// Datara Studio, as a desktop application.
//
// Tauri is only the window. Everything behind it is the same stack the browser
// build uses: the Datara server owns the files and the compiler, the wasm text
// core owns the document and the lexer, and the interface is the same page.
//
// Why the shell starts the server rather than bundling a static build: the whole
// point of this IDE is that it can run the compiler, read the project and watch
// the filesystem. A frozen asset bundle could do none of that.
//
// Three things this shell does that a naive one does not, each for a reason
// that was measured rather than imagined:
//
//   * **Two ports, not one.** The Datara runtime gives a socket no timeout and
//     no non-blocking mode, so a single connection that connects and sends
//     nothing blocks that server's accept loop permanently. Webviews open
//     exactly such connections. A second server on a second port is the
//     mitigation, and the interface uses whichever answers - the same trick
//     `start.cmd` uses. See PORTING.md SEAM-6.
//   * **A visible failure page.** The first version printed to stderr, which in
//     a release build (`windows_subsystem = "windows"`) goes nowhere at all -
//     so a server that failed to start was an empty grey window with no
//     explanation. Now the window opens the bundled `dist/index.html`, which
//     says what is wrong, what to run, and retries by itself.
//   * **A watchdog.** The server is respawned when it stops answering, so the
//     window cannot end up pointed at a dead port.
//
// The window is undecorated: the interface draws its own title bar. The shell's
// half of that is one line below (`.decorations(false)`); the interface's half is
// `ui/tauri-bridge.js`, and the permission that makes it work is
// `capabilities/default.json`. All three are needed, and the failure mode of a
// missing one is different in each case - no title bar, a title bar whose buttons
// do nothing, or a title bar whose buttons are refused by the ACL.
//
// The server is killed on exit, so closing the window does not leave a process
// holding the port.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Every port the interface will try, in order.
///
/// The shell starts servers on the first two that are usable; the interface
/// tries all four. The extra two exist because a killed server can leave its
/// listening socket registered and Windows then keeps delivering connections to
/// the dead socket - with two ports that is a coin toss, with four the interface
/// almost always finds a live one.
const ALL_PORTS: [u16; 4] = [7878, 7879, 7880, 7881];

struct ServerState {
    children: Vec<Child>,
    stopped: Arc<AtomicBool>,
}

/// The subdirectory of the bundle's resource directory that holds the studio.
///
/// This is not a free choice - it is the first component of every target in
/// `bundle.resources` (`"../src": "studio/src"`), so it is the name the bundler
/// will actually create. A test asserts the two agree, because the defect that
/// shipped in 0.5.0 was exactly this constant disagreeing with the config: the
/// shell looked for `resources/studio`, the bundler created `studio`, and every
/// installed build opened on "the interface server is not answering". The search
/// then fell through to `current_dir()`, so `forgen run src/main.dtr` ran in a
/// directory with no `src/` and no port ever answered.
const PACKAGED_SUBDIR: &str = "studio";

/// The studio directory inside a bundle's resource directory, if it is there.
///
/// Split out from `studio_dir` so it can be tested without a running Tauri app.
fn packaged_in(resources: &Path) -> Option<PathBuf> {
    let candidate = resources.join(PACKAGED_SUBDIR);
    if candidate.join("src").join("main.dtr").exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Walk up from a directory looking for the studio's sources.
///
/// This is the *development* path: `cargo run` puts the binary in
/// `src-tauri/target/debug`, several levels below the project root. It is a
/// fallback, not the packaged answer - see `studio_dir`.
fn resolve_studio_dir(dir: &Path) -> Option<PathBuf> {
    let mut level = dir.to_path_buf();
    for _ in 0..8 {
        if level.join("src").join("main.dtr").exists() {
            return Some(level);
        }
        if let Some(found) = packaged_in(&level) {
            return Some(found);
        }
        if !level.pop() {
            break;
        }
    }
    None
}

/// Where the studio's sources are.
///
/// **Tauri answers this, and its answer is different on every platform.** From
/// the `resource_dir` documentation, quoted because getting it wrong is what
/// broke 0.5.0:
///
///   * Windows - the directory that contains the main executable.
///   * macOS - `${exe_dir}/../Resources`, inside the `.app`.
///   * Linux - `/usr/lib/${exe_name}`, or `${APPDIR}/usr/lib/${exe_name}` in an
///     AppImage.
///
/// The Linux answer is the one that cannot be reached by guessing: the
/// executable is installed at `/usr/bin/${exe_name}` and the resources at
/// `/usr/lib/${exe_name}`, which is a *different directory tree*, not a
/// subdirectory of it. An earlier version of this function tried to recognise
/// the layouts itself - first only `resources/studio`, then also a `studio/`
/// sibling - and both versions would have left every Linux install with no
/// server, because walking up from `/usr/bin` reaches `/usr` and `/` and never
/// `/usr/lib`. Asking the framework is the only answer that is right on all
/// three platforms, and it is what the framework's own documentation tells you
/// to do rather than computing the path yourself.
///
/// The walk-up stays for development, where there is no bundle to ask about.
fn studio_dir(app: &tauri::App) -> PathBuf {
    use tauri::Manager;

    if let Ok(resources) = app.path().resource_dir() {
        if let Some(found) = packaged_in(&resources) {
            return found;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(found) = resolve_studio_dir(dir) {
                return found;
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// A JavaScript string literal for a path, so it can be handed to the splash page.
///
/// Windows paths are full of backslashes, and an unescaped one turns `C:\Users`
/// into `C:` + `\U` - a syntax error that kills the whole initialization script
/// and takes the diagnostics page with it. Only the four characters that can
/// appear in a path and that mean something inside a double-quoted JS string are
/// escaped.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `forgen` from PATH, then the conventional install locations for each OS.
///
/// Do not assume Windows' `LOCALAPPDATA`: a Linux desktop launch has no shell
/// profile and commonly installs a user binary in `$HOME/.local/bin`.
fn forgen() -> Command {
    if let Ok(explicit) = std::env::var("DATARA_FORGEN") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Command::new(p);
        }
    }
    if which("forgen") {
        return Command::new("forgen");
    }
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs").join("Datara").join("bin").join("forgen.exe"));
    }
    if let Ok(home) = std::env::var("HOME") {
        // Two candidates from one string, so the join has to borrow it. An
        // earlier version moved `home` into the first `PathBuf::from` and then
        // used it again - which is E0382, and it compiled only because the
        // stale binary it produced was never rebuilt until now.
        let home = PathBuf::from(home);
        candidates.push(home.join(".local").join("bin").join("forgen"));
        candidates.push(home.join(".datara").join("bin").join("forgen"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/forgen"));
    candidates.push(PathBuf::from("/usr/bin/forgen"));
    for candidate in candidates {
        if candidate.exists() {
            return Command::new(candidate);
        }
    }
    Command::new("forgen")
}

fn which(name: &str) -> bool {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        #[cfg(windows)]
        {
            let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                if dir.join(format!("{}{}", name, ext.to_lowercase())).exists() {
                    return true;
                }
            }
        }
        #[cfg(not(windows))]
        {
            if dir.join(name).is_file() {
                return true;
            }
        }
    }
    false
}

fn spawn_server(dir: &PathBuf, port: u16) -> Option<Child> {
    let mut cmd = forgen();
    cmd.args(["run", "src/main.dtr"])
        .current_dir(dir)
        .env("DATARA_STUDIO_PORT", port.to_string());

    // Without this the servers get their own console windows: a GUI-subsystem
    // process spawning a console application makes Windows create one, so
    // opening the IDE flashed two black windows and left them in the taskbar for
    // as long as it was open. CREATE_NO_WINDOW is the only flag that means
    // "hidden" - there is no minimised-and-invisible.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().ok()
}

/// Does this port have a server that actually *answers*?
///
/// Not the same as "can I connect". A killed server can leave its listening
/// socket registered and Windows keeps accepting connections to it, and a
/// server wedged on an idle connection accepts and then never replies. Testing
/// connectability alone therefore reports a dead port as healthy - which is
/// exactly how the watchdog ends up doing nothing while the interface hangs.
///
/// So: connect, send a real request, and require a 200 back.
fn answers(port: u16) -> bool {
    use std::io::{Read, Write};

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(700)));
    let req = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match s.read(&mut buf) {
        Ok(n) if n > 0 => buf.starts_with(b"HTTP/1.1 200"),
        _ => false,
    }
}

/// Something is bound to the port, whether or not it answers.
fn listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// A port we can either use or hand over to: free, or already serving.
///
/// A port that is bound but silent is skipped rather than fought over. The
/// runtime does not refuse a second bind on the same port, so starting a server
/// there would not fail - it would split the traffic between a live server and a
/// dead one, which is worse than failing.
fn usable(port: u16) -> bool {
    answers(port) || !listening(port)
}

/// The first port that answers, or None.
fn live_port() -> Option<u16> {
    ALL_PORTS.iter().copied().find(|p| answers(*p))
}

fn main() {
    let state = ServerState { children: Vec::new(), stopped: Arc::new(AtomicBool::new(false)) };
    let stopped = state.stopped.clone();

    tauri::Builder::default()
        .manage(Mutex::new(state))
        .setup(move |app| {
            use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

            // Where the studio's sources are, asked of Tauri rather than guessed.
            // This has to happen here rather than before `Builder::default()`:
            // the answer comes from the app's path resolver, and the packaged
            // answer is a different directory on every platform. See
            // `studio_dir`.
            let dir = studio_dir(app);
            eprintln!("datara-studio: studio directory {}", dir.display());

            // Start on the first two ports that are free or already serving. A
            // port that is bound but silent is skipped: the runtime allows a
            // second bind on the same port, so a server started there would not
            // fail, it would silently share traffic with a dead one - which is
            // the intermittent hang this whole scheme exists to avoid.
            let chosen: Vec<u16> =
                ALL_PORTS.iter().copied().filter(|p| usable(*p)).take(2).collect();
            let children: Vec<Child> = chosen
                .iter()
                .filter(|p| !answers(**p))
                .filter_map(|p| spawn_server(&dir, *p))
                .collect();
            if chosen.is_empty() {
                eprintln!("datara-studio: every port {:?} is bound and silent", ALL_PORTS);
            } else {
                eprintln!("datara-studio: using ports {:?}", chosen);
            }
            if let Some(managed) = app.try_state::<Mutex<ServerState>>() {
                if let Ok(mut guard) = managed.lock() {
                    guard.children = children;
                }
            }

            let dir_for_watch = dir.clone();
            let dir_for_page = dir.clone();

            // The window opens IMMEDIATELY, on the bundled splash, and does not
            // wait for the server. The splash polls and hands the window over the
            // moment one answers, and only admits failure after nine seconds.
            //
            // The first version waited up to twenty seconds before creating any
            // window at all, which meant a slow start looked like nothing
            // happening. A window that appears at once and says "starting" is
            // the difference between an editor that feels instant and one that
            // feels broken - and the wait was never buying anything, because the
            // page can do the waiting better than the shell can.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Datara Studio")
                // The splash tells the reader how to start the server by hand,
                // and the command it prints has to name *this* installation. It
                // used to carry a hardcoded path from the machine the shell was
                // developed on, so every user who ever saw that page was told to
                // cd into a directory that does not exist for them - which is
                // worse than saying nothing, because it looks like a real
                // instruction and it silently fails.
                .initialization_script(&format!(
                    "window.__DS_STUDIO_DIR = {};",
                    js_string(&dir_for_page.to_string_lossy())
                ))
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // No native title bar: the interface draws its own, in the
                // interface's own style. See `ui/tauri-bridge.js` for the other
                // half of this - the bar is only drawn when `window.isTauri` is
                // set, so the browser build is unchanged.
                //
                // The shadow is not decoration for its own sake. Without it an
                // undecorated window has no border, no drop shadow and no
                // rounding: a rectangle of #101014 with a hard edge, which on a
                // dark desktop reads as a hole rather than a window. On Windows
                // 11 `shadow(true)` gives it the system's 1px outline and
                // rounded corners; tao then keeps the resize grip on all four
                // edges and clamps a maximised undecorated window to the monitor
                // work area, so it does not cover the taskbar.
                .decorations(false)
                .shadow(true)
                .background_color(tauri::window::Color(16, 16, 20, 255))
                .build()?;

            // Watchdog: the runtime cannot time out a socket, so the server can
            // be blocked by one idle connection and stay blocked. Restarting it
            // is the only recovery available, and doing it here means the
            // desktop build gets the same protection the browser build has.
            std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(5));
                    if stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    if live_port().is_none() {
                        let retry: Vec<u16> =
                            ALL_PORTS.iter().copied().filter(|p| usable(*p)).take(2).collect();
                        eprintln!("datara-studio: no port answering, restarting on {:?}", retry);
                        for p in retry {
                            let _ = spawn_server(&dir_for_watch, p);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                if let Some(state) = window.app_handle().try_state::<Mutex<ServerState>>() {
                    if let Ok(mut guard) = state.lock() {
                        guard.stopped.store(true, Ordering::Relaxed);
                        for child in guard.children.iter_mut() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        guard.children.clear();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start Datara Studio");
}

/// The shell's own tests.
///
/// They exist because of one defect that shipped: v0.5.0's installers opened on
/// "the interface server is not answering" on every platform, and nothing in the
/// repository noticed. The gate's eleven stages all passed, `cargo test` had no
/// tests to run, and every check that existed looked at the *repository* layout -
/// the one layout that worked. `drive.mjs` runs the server the way a developer
/// does, from the project root, so it was green throughout.
///
/// The rule the project already had is "a verifier must run the artefact, not
/// restate the rule". These do not restate `PACKAGED_SUBDIR`: the fixture is
/// built from what `tauri.conf.json` declares the bundler will do, so changing
/// the config to a shape the resolver cannot find fails the test rather than
/// passing quietly alongside it.
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A plausible Datara program, since the resolver only asks whether the file
    /// exists.
    const FIXTURE: &str = "fn main() -> Int {\n    return 0\n}\n";

    /// A unique, empty directory under the system temp directory.
    ///
    /// Nothing is ever removed. A test that deletes directories is a test that
    /// can delete the wrong one, and a stray empty directory in the temp
    /// directory costs less than that.
    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ds-studio-dir-{}-{}-{}",
            name,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("could not create the scratch directory");
        dir
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("could not create a fixture directory");
        }
        fs::write(path, body).expect("could not write a fixture file");
    }

    /// Where `tauri.conf.json` says the studio's sources land inside a bundle,
    /// as a path relative to the resource directory.
    ///
    /// Read from the bundler's own config rather than written here a second
    /// time. A hard-coded `studio/src` would keep passing after someone changed
    /// the mapping to something the resolver cannot find, which is precisely the
    /// failure this whole module is about.
    fn declared_source_target() -> String {
        let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = fs::read_to_string(&conf).expect("could not read tauri.conf.json");
        let json: serde_json::Value =
            serde_json::from_str(&text).expect("tauri.conf.json is not valid JSON");
        let resources = json["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources is not an object");
        resources
            .get("../src")
            .and_then(|v| v.as_str())
            .expect("bundle.resources does not map ../src, so the shell's sources are unbundled")
            .to_string()
    }

    /// The first component of every target in `bundle.resources` - the directory
    /// the bundler will create inside `$RESOURCE`.
    fn declared_packaged_root() -> String {
        let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = fs::read_to_string(&conf).expect("could not read tauri.conf.json");
        let json: serde_json::Value =
            serde_json::from_str(&text).expect("tauri.conf.json is not valid JSON");
        let resources = json["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources is not an object");
        let mut root: Option<String> = None;
        for target in resources.values() {
            let target = target.as_str().expect("a resource target is not a string");
            let first = target.split('/').next().unwrap_or("").to_string();
            match &root {
                None => root = Some(first),
                Some(seen) if *seen == first => {}
                // Not a failure of the resolver, but it would make "the studio
                // directory" ambiguous, and the resolver can only return one.
                Some(seen) => panic!(
                    "bundle.resources puts the studio in two places at once: {:?} and {:?}",
                    seen, first
                ),
            }
        }
        root.expect("bundle.resources is empty")
    }

    /// The test that would have caught the defect before it shipped.
    ///
    /// The shell looked for `resources/studio`; the bundler created `studio`.
    /// Asserting that the constant equals what the config declares is the whole
    /// check - and it is a check on the *bundler's* config, so it cannot drift
    /// out of date the way a second copy of the layout would.
    #[test]
    fn the_bundled_subdirectory_is_the_one_the_bundler_declares() {
        assert_eq!(
            PACKAGED_SUBDIR,
            declared_packaged_root(),
            "the shell looks for {:?} inside the resource directory but bundle.resources \
             declares {:?} - an installed build would find no sources and start no server",
            PACKAGED_SUBDIR,
            declared_packaged_root()
        );
    }

    /// And that the resolver actually finds that directory on disk, with the
    /// fixture placed where the config says the bundler will place it.
    #[test]
    fn the_declared_layout_is_found_in_the_resource_directory() {
        let target = declared_source_target();
        let resources = scratch("resource-dir");
        write(&resources.join(&target).join("main.dtr"), FIXTURE);

        assert_eq!(packaged_in(&resources), Some(resources.join(PACKAGED_SUBDIR)));
    }

    #[test]
    fn an_empty_resource_directory_has_no_studio() {
        let resources = scratch("resource-empty");
        assert_eq!(packaged_in(&resources), None);
    }

    /// The layout every existing test used, kept so the packaged fix cannot
    /// trade one broken layout for another: `cargo run` and `cargo test` put the
    /// binary below `src-tauri/target/...`, where Tauri's resource directory
    /// holds no studio at all.
    #[test]
    fn a_development_binary_walks_up_to_the_project_root() {
        let root = scratch("repo");
        write(&root.join("src").join("main.dtr"), FIXTURE);
        let exe_dir = root.join("src-tauri").join("target").join("release");
        fs::create_dir_all(&exe_dir).expect("could not create the target directory");

        assert_eq!(resolve_studio_dir(&exe_dir), Some(root));
    }

    /// Nested deeper than the walk-up can climb, so the answer cannot depend on
    /// what happens to sit above the system temp directory on the machine
    /// running the test.
    #[test]
    fn an_empty_tree_resolves_to_nothing() {
        let mut level = scratch("empty");
        for _ in 0..10 {
            level = level.join("d");
        }
        fs::create_dir_all(&level).expect("could not create the nested directory");

        assert_eq!(resolve_studio_dir(&level), None);
    }

    /// The other half of the same bug report: the splash page.
    ///
    /// It prints the command that starts the server by hand, which has to name
    /// the reader's installation. It used to carry a path from the machine the
    /// shell was developed on. The path now travels through a JavaScript string
    /// literal, and an unescaped Windows backslash ends that literal early -
    /// `C:\Users` becomes `C:` followed by `\U`, a syntax error that kills the
    /// whole initialization script and takes the diagnostics page with it.
    #[test]
    fn a_windows_path_survives_into_the_splash_page() {
        assert_eq!(
            js_string(r"C:\Users\me\Datara Studio"),
            r#""C:\\Users\\me\\Datara Studio""#
        );
        assert_eq!(js_string("a\"b"), r#""a\"b""#);
        assert_eq!(js_string("a\nb"), r#""a\nb""#);
    }
}
