const files = {
  "README.md": "# Ryan Harness Core\n\nThe kernel stays small, offline-first and host-neutral.\n\n- core: identity, versioning and outcomes\n- text: rope, line index and edits\n- events: the event bus and plans\n\nThis workspace is ready for a host adapter.\n",
  "datara.toml": "[package]\nname = \"ryan-harness\"\nversion = \"0.1.0\"\n\n[features]\nnetwork = false\nai = false\n",
  "src/main.dtr": "//! Ryan Harness Core - headless kernel entry point.\n\nuse cli\n\nfn main() -> Int {\n    return cli_main()\n}\n",
  "src/cli.dtr": "//! Headless CLI adapter.\n\nuse core\nuse text\n\nfn cli_main() -> Int {\n    let kernel = kernel_self_check()\n    if !outcome_is_ok(kernel) {\n        return 1\n    }\n    return 0\n}\n",
  "src/core/mod.dtr": "//! Kernel foundation primitives.\n\nuse core.ids\nuse core.version\nuse core.outcome\n\npub fn ryan_kernel_abi() -> Int => 1\npub fn ryan_requires_network() -> Bool => false\npub fn ryan_requires_ai() -> Bool => false\n\npub fn kernel_self_check() -> Outcome<Str> {\n    if ryan_requires_network() {\n        return outcome_fail(\"\", \"network must stay disabled\")\n    }\n    if ryan_requires_ai() {\n        return outcome_fail(\"\", \"AI must stay disabled\")\n    }\n    return outcome_ok(\"kernel self-check passed\")\n}\n",
  "src/text/mod.dtr": "//! Text storage and manipulation.\n\nuse text.rope\nuse text.line_index\nuse text.utf16\n\npub fn text_engine_supports_utf16() -> Bool => true\npub fn text_engine_supports_undo() -> Bool => true\npub fn text_engine_supports_snapshots() -> Bool => true\n",
  "src/events/bus.dtr": "//! Event bus for host-neutral changes.\n\nstruct Event {\n    topic: Str\n    revision: Int\n}\n\npub fn event_new(topic: Str, revision: Int) -> Event {\n    return Event { topic: topic, revision: revision }\n}\n"
};

const state = {
  ...JSON.parse(localStorage.getItem("ryan-harness.ide") || "{}"),
  active: "src/main.dtr",
  open: ["src/main.dtr", "src/cli.dtr"],
  panel: "problems",
  view: "explorer",
  lineNumbers: true,
  wrap: false,
  fontSize: 13,
  indent: 4,
};
const saved = {};
for (const key of Object.keys(files)) saved[key] = localStorage.getItem("ryan-harness.file." + key) ?? files[key];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const editor = $("#editor");
const tree = $("#tree");
const tabs = $("#tabs");
const lineNumbers = $("#lineNumbers");
const inspectorBody = $("#inspectorBody");
const paletteOverlay = $("#paletteOverlay");
const paletteInput = $("#paletteInput");
const paletteList = $("#paletteList");
const settingsOverlay = $("#settingsOverlay");

function persist() {
  localStorage.setItem("ryan-harness.ide", JSON.stringify({ ...state, active: state.active, open: state.open }));
}
function basename(path) { return path.split("/").pop(); }
function dirname(path) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
function languageFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "dtr") return "Datara";
  if (ext === "md") return "Markdown";
  if (ext === "toml") return "TOML";
  return "Plain text";
}
function iconFor(path, folder = false) { if (folder) return "[+]"; const ext = path.split(".").pop().toLowerCase(); return ext === "dtr" ? "<>" : ext === "md" ? "#" : ext === "toml" ? "=" : "--"; }
function escapeHtml(value) { return String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function currentText() { return saved[state.active] ?? ""; }
function isDirty(path) { return saved[path] !== files[path]; }

function renderTree() {
  const filter = $("#fileFilter").value.toLowerCase();
  const roots = ["README.md", "datara.toml"];
  const groups = { src: Object.keys(files).filter((p) => p.startsWith("src/")) };
  const visible = (p) => !filter || p.toLowerCase().includes(filter);
  let html = "";
  for (const path of roots) if (visible(path)) html += row(path, false, 0);
  for (const [folder, paths] of Object.entries(groups)) {
    const shown = paths.filter(visible);
    if (!shown.length && filter) continue;
    html += `<div class="tree-row folder" data-folder="${folder}"><span class="tree-chevron">v</span><span class="tree-icon folder-icon">[+]</span><span>${folder}</span><span class="tree-muted">${paths.length}</span></div>`;
    for (const path of shown) html += row(path, false, 1);
  }
  tree.innerHTML = html || `<div class="panel-note" style="padding:14px">No files match this filter.</div>`;
  $$(".tree-row[data-path]").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.path)));
}
function row(path, folder, depth) {
  const selected = path === state.active ? " selected" : "";
  const dirty = isDirty(path) ? " <span class=\"tree-muted\">*</span>" : "";
  return `<div class="tree-row${selected}${depth ? " indent" : ""}" data-path="${path}"><span class="tree-chevron"></span><span class="tree-icon">${iconFor(path, folder)}</span><span>${basename(path)}</span>${dirty}</div>`;
}

function renderTabs() {
  tabs.innerHTML = state.open.map((path) => `<div class="tab${path === state.active ? " active" : ""}${isDirty(path) ? " modified" : ""}" data-tab="${path}"><span class="file-glyph">${iconFor(path)}</span><span>${basename(path)}</span>${isDirty(path) ? "<span class=tab-dot>•</span>" : ""}<span class="tab-close" data-close-tab="${path}">x</span></div>`).join("");
  $$(".tab").forEach((el) => el.addEventListener("click", (event) => {
    if (event.target.dataset.closeTab) closeTab(event.target.dataset.closeTab); else openFile(el.dataset.tab);
  }));
}
function renderEditor() {
  editor.value = currentText();
  editor.style.fontSize = state.fontSize + "px";
  editor.classList.toggle("wrap", state.wrap);
  lineNumbers.style.display = state.lineNumbers ? "block" : "none";
  $("#breadcrumbPath").textContent = dirname(state.active) || "workspace";
  $("#breadcrumbFile").textContent = basename(state.active);
  $("#currentFileLabel").textContent = basename(state.active) + (isDirty(state.active) ? " *" : "");
  $("#currentLanguage").textContent = languageFor(state.active);
  updateLineNumbers();
  updateCursor();
  renderMinimap();
}
function updateLineNumbers() {
  const lines = editor.value.split("\n");
  const active = editor.value.slice(0, editor.selectionStart).split("\n").length;
  lineNumbers.innerHTML = lines.map((_, i) => `<div class="${i + 1 === active ? "active" : ""}">${i + 1}</div>`).join("");
}
function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split("\n").length;
  const col = before.length - before.lastIndexOf("\n");
  $("#cursorPosition").textContent = `Ln ${line}, Col ${col}`;
  updateLineNumbers();
}
function renderMinimap() {
  const lines = editor.value.split("\n");
  const step = Math.max(2, Math.min(5, 75 / Math.max(lines.length, 1)));
  const end = step + 1;
  const next = end + 3;
  $("#minimap").style.background = "repeating-linear-gradient(to bottom, transparent 0 " + step + "px, #768195 " + step + "px " + end + "px, transparent " + end + "px " + next + "px)";
}
function renderInspector() {
  $$(".inspector-tab").forEach((el) => el.classList.toggle("active", el.dataset.panel === state.panel));
  if (state.panel === "problems") inspectorBody.innerHTML = `<div class="panel-heading"><span>Problems</span><span class="muted">saved buffer</span></div><div class="problem"><span class="problem-mark">OK</span><span class="problem-text"><b>No problems detected</b><small>Kernel self-check and source scan are clean</small></span></div>`;
  if (state.panel === "structure") inspectorBody.innerHTML = `<div class="panel-heading"><span>Structure</span><span class="muted">${basename(state.active)}</span></div>${structureRows(currentText()) || `<div class="panel-note">No declarations in this file.</div>`}`;
  if (state.panel === "project") inspectorBody.innerHTML = `<div class="panel-heading"><span>Project</span><span class="muted">7 files</span></div><div class="project-row"><span>Kernel ABI</span><span>1</span></div><div class="project-row"><span>Text engine</span><span>ready</span></div><div class="project-row"><span>Event bus</span><span>ready</span></div><div class="project-row"><span>Host adapter</span><span>local</span></div><div class="project-row"><span>Working tree</span><span>clean</span></div>`;
  if (state.panel === "layout") inspectorBody.innerHTML = `<div class="panel-heading"><span>Layout</span><span class="muted">Event</span></div><div class="layout-row"><span class="layout-label">topic: Str</span><span class="layout-bar"><i style="width:36%"></i></span><span class="muted">16 B</span></div><div class="layout-row"><span class="layout-label">revision: Int</span><span class="layout-bar"><i style="width:64%"></i></span><span class="muted">8 B</span></div><div class="panel-note" style="margin-top:16px">The kernel host can replace this view with compiler-provided layout facts.</div>`;
  if (state.panel === "output") inspectorBody.innerHTML = `<div class="panel-heading"><span>Output</span><span class="muted">last run</span></div><div class="output"><span class="ok">$ kernel self-check</span>\n\nABI 1\nnetwork disabled\nAI subsystem disabled\n<span class="ok">self-check passed</span></div>`;
}
function structureRows(text) {
  return text.split("\n").map((line, i) => { const match = line.match(/^\s*(?:pub\s+)?(fn|struct|trait|class|enum|type)\s+([A-Za-z_]\w*)/); return match ? `<div class="outline-row"><span class="outline-kind">${match[1]}</span><span>${match[2]}</span><span class="tree-muted">${i + 1}</span></div>` : ""; }).join("");
}
function renderAll() { renderTree(); renderTabs(); renderEditor(); renderInspector(); }
function openFile(path) { if (!(path in files)) return; state.active = path; if (!state.open.includes(path)) state.open.push(path); persist(); renderAll(); editor.focus(); }
function closeTab(path) { if (state.open.length === 1) return; const index = state.open.indexOf(path); state.open = state.open.filter((p) => p !== path); if (path === state.active) state.active = state.open[Math.max(0, index - 1)]; persist(); renderAll(); }
function saveFile() { localStorage.setItem("ryan-harness.file." + state.active, editor.value); saved[state.active] = editor.value; $("#editorMessage").textContent = "Saved locally"; setTimeout(() => { $("#editorMessage").textContent = ""; }, 1200); renderAll(); }
function runAction(kind) { state.panel = "output"; $("#editorMessage").textContent = kind === "run" ? "Kernel run completed" : "Source check completed"; renderInspector(); setTimeout(() => { $("#editorMessage").textContent = ""; }, 1500); }
function commandItems(query) { const q = query.toLowerCase(); const items = [{ label: "Open file", hint: "Ctrl+P", action: () => openFile("src/main.dtr") }, { label: "Save file", hint: "Ctrl+S", action: saveFile }, { label: "Run kernel", hint: "", action: () => runAction("run") }, { label: "Check source", hint: "", action: () => runAction("check") }, { label: "Show problems", hint: "", action: () => { state.panel = "problems"; renderInspector(); } }, { label: "Show structure", hint: "", action: () => { state.panel = "structure"; renderInspector(); } }, { label: "Open settings", hint: "", action: openSettings }]; return items.filter((item) => !q || item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q)); }
function renderPalette() { const items = commandItems(paletteInput.value); paletteList.innerHTML = items.map((item, i) => `<div class="palette-item${i === 0 ? " selected" : ""}" data-palette-index="${i}"><span>${item.label}</span><small>${item.hint}</small></div>`).join("") || `<div class="panel-note" style="padding:12px">No matching commands.</div>`; $$(".palette-item").forEach((el) => el.addEventListener("click", () => { const item = items[Number(el.dataset.paletteIndex)]; closePalette(); item.action(); })); }
function openPalette() { paletteOverlay.classList.remove("hidden"); paletteInput.value = ""; renderPalette(); paletteInput.focus(); }
function closePalette() { paletteOverlay.classList.add("hidden"); }
function openSettings() { settingsOverlay.classList.remove("hidden"); }
function closeSettings() { settingsOverlay.classList.add("hidden"); }

editor.addEventListener("input", () => { saved[state.active] = editor.value; updateCursor(); renderTabs(); renderTree(); });
editor.addEventListener("click", updateCursor); editor.addEventListener("keyup", updateCursor); editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
editor.addEventListener("keydown", (event) => { if (event.key === "Tab") { event.preventDefault(); const start = editor.selectionStart; const spaces = " ".repeat(state.indent); editor.setRangeText(spaces, start, editor.selectionEnd, "end"); saved[state.active] = editor.value; updateCursor(); } if (event.key === "Enter") { event.preventDefault(); const before = editor.value.slice(0, editor.selectionStart); const indent = before.slice(before.lastIndexOf("\n") + 1).match(/^\s*/)?.[0] || ""; editor.setRangeText("\n" + indent, editor.selectionStart, editor.selectionEnd, "end"); saved[state.active] = editor.value; updateCursor(); } });
$("#fileFilter").addEventListener("input", renderTree); $("#searchButton").addEventListener("click", openPalette); $("#runButton").addEventListener("click", () => runAction("run")); $("#checkButton").addEventListener("click", () => runAction("check")); $("#selfCheckButton").addEventListener("click", () => { state.panel = "output"; renderInspector(); }); $("#settingsButton").addEventListener("click", openSettings); $("#railSettings").addEventListener("click", openSettings); $("#newFileButton").addEventListener("click", () => { const path = "src/new_file.dtr"; if (!(path in files)) { files[path] = "fn new_function() -> Int {\n    return 0\n}\n"; saved[path] = files[path]; } openFile(path); }); $("#collapseButton").addEventListener("click", () => { $$(".tree-row.folder").forEach((el) => { el.style.display = el.style.display === "none" ? "flex" : "none"; }); });
$$('.rail-button,.strip-item[data-view]').forEach((button) => button.addEventListener("click", () => { const view = button.dataset.view; state.view = view; $$('.rail-button,.strip-item[data-view]').forEach((x) => x.classList.toggle("active", x.dataset.view === view)); $("#sidebarTitle").textContent = view === "search" ? "SEARCH" : view === "source" ? "SOURCE CONTROL" : "EXPLORER"; if (view !== "explorer") $("#sidebarStatus").textContent = view === "search" ? "Search in workspace" : "Working tree clean"; else $("#sidebarStatus").textContent = "Workspace ready"; }));
$$('.inspector-tab').forEach((button) => button.addEventListener("click", () => { state.panel = button.dataset.panel; renderInspector(); }));
$$('[data-close="settingsOverlay"]').forEach((button) => button.addEventListener("click", closeSettings));
settingsOverlay.addEventListener("click", (event) => { if (event.target === settingsOverlay) closeSettings(); }); paletteOverlay.addEventListener("click", (event) => { if (event.target === paletteOverlay) closePalette(); });
paletteInput.addEventListener("input", renderPalette); paletteInput.addEventListener("keydown", (event) => { if (event.key === "Escape") closePalette(); if (event.key === "Enter") { const item = commandItems(paletteInput.value)[0]; if (item) { closePalette(); item.action(); } } });
$("#fontSizeSetting").addEventListener("change", (event) => { state.fontSize = Number(event.target.value); renderEditor(); persist(); }); $("#lineNumberSetting").addEventListener("change", (event) => { state.lineNumbers = event.target.checked; renderEditor(); persist(); }); $("#wrapSetting").addEventListener("change", (event) => { state.wrap = event.target.checked; renderEditor(); persist(); }); $("#indentSetting").addEventListener("change", (event) => { state.indent = Number(event.target.value); persist(); });
document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") { event.preventDefault(); openPalette(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveFile(); } if (event.key === "Escape") { closePalette(); closeSettings(); } });

renderAll();
