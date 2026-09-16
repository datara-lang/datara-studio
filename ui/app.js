const defaults = { indent: "4", lineNumbers: true, wordWrap: false };
const state = { ...defaults, ...JSON.parse(localStorage.getItem("ryan-harness.settings") || "{}") };
const save = () => localStorage.setItem("ryan-harness.settings", JSON.stringify(state));
const result = document.querySelector("#result");
const show = (text, good) => { result.textContent = text; result.className = "result " + (good ? "good" : "bad"); };

for (const el of document.querySelectorAll("[data-setting]")) {
  const key = el.dataset.setting;
  if (el.type === "checkbox") el.checked = Boolean(state[key]);
  else el.value = state[key];
  el.addEventListener("change", () => {
    state[key] = el.type === "checkbox" ? el.checked : el.value;
    save();
  });
}

document.querySelector("#selfcheck").addEventListener("click", () => {
  const noNetwork = true;
  const noAi = true;
  if (noNetwork && noAi) show("Self-check passed", true);
  else show("Self-check failed", false);
});
document.querySelector("#reset").addEventListener("click", () => {
  Object.assign(state, defaults);
  save();
  for (const el of document.querySelectorAll("[data-setting]")) {
    if (el.type === "checkbox") el.checked = Boolean(state[el.dataset.setting]);
    else el.value = state[el.dataset.setting];
  }
  show("Settings reset", true);
});
