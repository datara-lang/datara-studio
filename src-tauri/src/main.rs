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
use std::path::PathBuf;
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

/// Locate the studio data directory in both repository and packaged layouts.
///
/// A packaged Tauri app does not run beside the repository. Its resources live
/// below the executable in `resources/studio`, while a development binary lives
/// below `src-tauri/target/...` and must walk up to the project root. Explorer,
/// a desktop shortcut and a terminal therefore all take the same path.
fn studio_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let packaged = dir.join("resources").join("studio");
            if packaged.join("src").join("main.dtr").exists() {
                return packaged;
            }
            let mut candidate = dir.to_path_buf();
            for _ in 0..8 {
                if candidate.join("src").join("main.dtr").exists() {
                    return candidate;
                }
                if !candidate.pop() {
                    break;
                }
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
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
    let dir = studio_dir();

    // Start on the first two ports that are free or already serving. A port that
    // is bound but silent is skipped: the runtime allows a second bind on the
    // same port, so a server started there would not fail, it would silently
    // share traffic with a dead one - which is the intermittent hang this whole
    // scheme exists to avoid.
    let chosen: Vec<u16> = ALL_PORTS.iter().copied().filter(|p| usable(*p)).take(2).collect();
    let mut children: Vec<Child> = chosen
        .iter()
        .filter(|p| !answers(**p))
        .filter_map(|p| spawn_server(&dir, *p))
        .collect();
    if chosen.is_empty() {
        eprintln!("datara-studio: every port {:?} is bound and silent", ALL_PORTS);
    } else {
        eprintln!("datara-studio: using ports {:?}", chosen);
    }

    let state = ServerState {
        children: children.drain(..).collect(),
        stopped: Arc::new(AtomicBool::new(false)),
    };
    let stopped = state.stopped.clone();
    let dir_for_watch = dir.clone();

    tauri::Builder::default()
        .manage(Mutex::new(state))
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

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
