// Drive the chat surface in a real browser, against a live companion.
//
// Run:  node ui/test/chat.mjs <base-url>
//
// Why this exists as a browser test rather than only as a Python one: the Python
// gate (D:\ryan\tools\verify_chat.py) proves the companion's /chat and /context
// behave. It cannot prove that the IDE *reaches* them, that the panel renders the
// answer, or that pressing "clear context" empties both sides. A feature whose
// whole point is "it remembers what you said" is exactly the kind that passes at
// the API layer and does nothing in the interface.
//
// What is asserted, and each is a thing a person would notice if it broke:
//
//   * the Chat tab exists, and Generate still does
//   * the context readout says where the context came from
//   * a question about the project is answered, in the transcript
//   * a code request comes back with the code in a block, not as prose
//   * a follow-up is understood, which is the whole reason chat replaced Generate
//   * "clear context" empties the transcript AND the companion's context, and the
//     readout confirms it - a clear that only emptied React would look identical
//     in the panel and be a lie about the model
//
// The companion is optional. If it is not reachable the test reports that and
// asserts the honest empty state rather than failing: the studio is designed to
// work without it, and a test that insists on an optional service is a test that
// goes red for the wrong reason.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) {}
  const roots = [];
  if (process.env.PLAYWRIGHT_ROOT) roots.push(process.env.PLAYWRIGHT_ROOT);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
  if (appdata) roots.push(join(appdata, "npm", "node_modules"));
  for (const root of roots) {
    for (const entry of ["index.mjs", "index.js"]) {
      const file = join(root, "playwright", entry);
      if (existsSync(file)) { try { return await import(pathToFileURL(file).href); } catch (e) {} }
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.log("playwright is not importable - skipping the chat drive.");
  process.exit(0);
}

const BASE = process.argv[2] || "http://127.0.0.1:7878";
const COMPANION = process.env.COMPANION || "http://127.0.0.1:7890";

let pass = 0, fail = 0;
const ok = (yes, what, detail) => {
  if (yes) { pass++; console.log("  PASS  " + what); }
  else { fail++; console.log("  FAIL  " + what + (detail ? "   [" + detail + "]" : "")); }
};

async function companionUp() {
  try {
    const r = await fetch(COMPANION + "/health");
    return r.ok;
  } catch (e) { return false; }
}

const up = await companionUp();
console.log("\ncompanion at " + COMPANION + ": " + (up ? "online" : "not running"));

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Start from a cold transcript so the assertions are about this run and not about
// a conversation left over from a previous one.
//
// The stored `panelOrder` is cleared too. It is a preference written by an older
// build in this profile, and it does not mention the Chat tab - which is exactly
// the state a real user upgrading into this feature is in, so the guard's
// reconciliation is being exercised rather than sidestepped. If that guard
// regresses, the next click on Chat lands on another tab and the test says so.
//
// Two passes, because `chatMsgs` is initialised from localStorage during the
// first render: removing the key and reloading once still boots from the copy
// React already read. Clear, reload, clear again - then reload - is what actually
// starts cold.
await page.goto(BASE + "/ui/studio.html", { waitUntil: "load" });
await page.evaluate(() => {
  try {
    localStorage.removeItem("datara.studio.chat");
    localStorage.removeItem("datara.studio.settings");
  } catch (e) {}
});
await page.reload({ waitUntil: "load" });
await page.evaluate(() => {
  try { localStorage.removeItem("datara.studio.chat"); } catch (e) {}
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1400);

console.log("\n== the tab exists and is reachable ==");
const tabs = await page.$$eval(".ptabs button", (bs) =>
  bs.map((b) => (b.childNodes[0] && b.childNodes[0].textContent || "").trim()));
ok(tabs.includes("Chat"), "there is a Chat tab", tabs.join(" | "));
ok(tabs.includes("Generate"), "Generate is still there", tabs.join(" | "));

// The panel is opened by clicking, the way a person does - not by setting state.
const clickTab = async (label) => {
  const bs = await page.$$(".ptabs button");
  for (const b of bs) {
    const t = await b.evaluate((e) => (e.childNodes[0] && e.childNodes[0].textContent || "").trim());
    if (t === label) { await b.click(); await page.waitForTimeout(400); return true; }
  }
  return false;
};
await clickTab("Chat");

console.log("\n== the context readout ==");
const ctxText = await page.$eval(".ctxcard", (e) => e.innerText).catch(() => null);
ok(ctxText !== null, "the context card is rendered");
if (ctxText !== null) {
  ok(/Context/.test(ctxText), "it is labelled", ctxText.slice(0, 60));
  // Case-insensitive: the tag is uppercased by CSS, so the rendered text is
  // "COMPILER" while the value the daemon sent is "compiler".
  ok(/compiler|manual|empty/i.test(ctxText), "it names where the context came from",
     ctxText.slice(0, 90));
  ok(/Nothing carried yet|message/.test(ctxText), "it says how much is carried",
     ctxText.slice(0, 90));
  ok(/clear context/.test(ctxText), "there is a clear control");
}

const send = async (text) => {
  await page.fill(".chatfield", text);
  await page.click(".chat .composer .mini");
  // Generation through forgen takes a moment; the code path measured ~0.6s, and
  // a fixed wait is honest here because the panel has no "done" signal to await.
  await page.waitForTimeout(9000);
};

if (!up) {
  console.log("\n== companion offline: the honest empty state ==");
  const note = await page.$eval(".pbody .note", (e) => e.innerText).catch(() => "");
  ok(/not running/i.test(note), "the panel says the companion is not running", note.slice(0, 80));
  ok(/start it/.test(note), "it offers to start it", note.slice(0, 80));
} else {
  console.log("\n== a question about the project ==");
  await send("что в проекте");
  let msgs = await page.$$eval(".chat .msg", (ns) =>
    ns.map((n) => ({ role: n.className, text: n.innerText })));
  ok(msgs.length >= 2, "the exchange is in the transcript", msgs.length + " nodes");
  ok(msgs.some((m) => m.role.includes("user") && /что в проекте/.test(m.text)),
     "the question is shown");
  const projReply = msgs.filter((m) => m.role.includes("assistant")).pop();
  ok(projReply && /\.dtr/.test(projReply.text),
     "the answer contains compiler facts about the project",
     projReply ? projReply.text.slice(0, 90) : "no reply");
  ok(projReply && /Источник/.test(projReply.text),
     "the answer cites its source", projReply ? projReply.text.slice(-70) : "");

  console.log("\n== a code request renders code, not prose ==");
  await send("напиши сортировку вставками");
  const codeBlock = await page.$(".chat .msg .ins");
  ok(codeBlock !== null, "the code arrived in its own block");
  if (codeBlock !== null) {
    const code = await codeBlock.evaluate((e) => e.innerText);
    ok(/fn\s+\w+/.test(code), "it looks like Datara", code.slice(0, 70));
    ok(/forgen check/i.test(
        await page.$eval(".chat", (e) => e.innerText)), "the verification is stated");
  }

  console.log("\n== context actually carries across turns ==");
  const beforeFollow = await page.$eval(".ctxcard", (e) => e.innerText);
  await send("а теперь по убыванию");
  const msgs2 = await page.$$eval(".chat .msg", (ns) => ns.map((n) => n.innerText));
  const lastReply = msgs2[msgs2.length - 1] || "";
  ok(!/Не могу ответить/.test(lastReply),
     "the follow-up was understood rather than refused", lastReply.slice(0, 80));
  const afterFollow = await page.$eval(".ctxcard", (e) => e.innerText);
  const grew = (s) => { const m = s.match(/(\d+)\s+message/); return m ? Number(m[1]) : 0; };
  ok(grew(afterFollow) > grew(beforeFollow),
     "the carried-message count went up (" + grew(beforeFollow) + " -> " + grew(afterFollow) + ")");

  console.log("\n== clear context destroys it on both sides ==");
  await page.click(".ctxcard .ctxbtns .mini");
  await page.waitForTimeout(1600);
  const msgs3 = await page.$$eval(".chat .msg", (ns) => ns.length);
  ok(msgs3 === 0, "the transcript was emptied", msgs3 + " messages remain");
  const afterClear = await page.$eval(".ctxcard", (e) => e.innerText);
  ok(/Nothing carried yet/i.test(afterClear), "the readout says nothing is carried",
     afterClear.slice(0, 90));
  ok(/empty/i.test(afterClear), "the context source reads as empty", afterClear.slice(0, 90));
  ok(/use the project/.test(afterClear), "the project context can be asked back for");

  // The assertion that separates "cleared" from "cleared and it stayed cleared".
  await page.waitForTimeout(1200);
  const stillCleared = await page.$eval(".ctxcard", (e) => e.innerText);
  ok(/empty/i.test(stillCleared) && /Nothing carried yet/i.test(stillCleared),
     "the clear survived - the context did not silently refill", stillCleared.slice(0, 90));
}

console.log("\n== nothing threw ==");
const real = errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to fetch|fetch failed|net::/i.test(e));
ok(real.length === 0, "no page errors", real.slice(0, 2).join(" | "));

await browser.close();
console.log("\n" + "=".repeat(60));
console.log("chat drive: " + pass + " passed, " + fail + " failed");
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
