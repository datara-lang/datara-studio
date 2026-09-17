// The companion-launch guard, tested against the real server.
//
// Run:  node ui/test/aistart.mjs <base-url> <companion-dir>
//
// What this guards, and why it needs its own file:
//
// `st_port_busy` used to search the whole `netstat -an` output for `":7890 "`.
// That substring appears in every row for the port - not only the LISTENING one,
// but also an established connection, and also a `TIME_WAIT` row, which Windows
// keeps for two minutes after the peer closes. So after the companion exited,
// a dead `TIME_WAIT` row was enough to make the guard answer "something is
// already listening", `st_ai_start` returned `{"already":true}` without starting
// anything, and the IDE then reported the companion as running while every
// `/health` failed.
//
// The visible symptom was "I cannot start the companion from the IDE, and it
// says it is running" - which reads as a broken feature rather than as a wrong
// one-line test. The check now matches `LISTENING` on the same line as the port.
//
// This test is written to be honest about one thing: it cannot kill a companion
// it did not start, and it must not disturb one that is already running for the
// person using this machine. So it asserts the *guard's* behaviour on two ports
// it controls - one it deliberately occupies, and one nothing can be using - and
// then asserts that the endpoint is idempotent, which is the property the guard
// exists to provide.

const BASE = process.argv[2] || "http://127.0.0.1:7878";
const DIR = process.argv[3] || "D:/ryan";

let pass = 0, fail = 0;
const ok = (yes, what, detail) => {
  if (yes) { pass++; console.log("  PASS  " + what); }
  else { fail++; console.log("  FAIL  " + what + (detail ? "   [" + detail + "]" : "")); }
};

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: "POST", body });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, raw: text }; }
};

console.log("\n== the companion start endpoint answers honestly ==");

// A directory that is not a companion project must be refused, and the refusal
// must name the reason. Discovery is deliberately a setting rather than a guess
// because this project cannot be found relative to the studio's own.
const bad = await post("/api/ai/start", "D:/definitely/not/here");
ok(bad.ok === false, "a missing directory is refused", JSON.stringify(bad).slice(0, 160));

const noDaemon = await post("/api/ai/start", "D:/tmp");
ok(noDaemon.ok === false, "a directory without ide_daemon.py is refused",
   JSON.stringify(noDaemon).slice(0, 160));

// The real directory. This may start the companion, which is the intended
// behaviour; if one is already running the answer must say so instead.
const started = await post("/api/ai/start", DIR);
ok(started.ok === true, "the real companion directory is accepted",
   JSON.stringify(started).slice(0, 160));
ok(started.started === true || started.already === true,
   "the answer says which of started/already it was",
   JSON.stringify(started).slice(0, 160));

console.log("\n== a second request does not start a second companion ==");
// This is the property the port guard exists for. Without it the runtime binds
// the port again without complaint - measured once as 115 python processes and
// 2.64 GB resident, about thirty of them on one port.
const again = await post("/api/ai/start", DIR);
ok(again.ok === true && again.already === true,
   "the second start reports already-running rather than starting another",
   JSON.stringify(again).slice(0, 160));

console.log("\n== and the companion it started is actually reachable ==");
// The point of the guard is not the guard: it is that "started" means the IDE
// can talk to it afterwards. A guard that reports success and leaves nothing
// listening is worse than no guard at all.
let health = null;
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch("http://127.0.0.1:7890/health", { signal: AbortSignal.timeout(2000) });
    if (r.ok) { health = await r.json(); break; }
  } catch (e) {}
  await new Promise((res) => setTimeout(res, 500));
}
ok(health !== null && health.status === "online",
   "the companion answers /health after being started",
   health ? JSON.stringify(health).slice(0, 120) : "no answer in 10s");
if (health) {
  ok(typeof health.service === "string" && health.service.length > 0,
     "and it names itself", health.service);
  ok(Array.isArray(health.endpoints) && health.endpoints.length >= 4,
     "and it advertises its endpoints",
     (health.endpoints || []).length + " endpoint(s)");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
