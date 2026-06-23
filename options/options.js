import { Ubus } from "../lib/ubus.js";
import { DEFAULT_CFG } from "../lib/podkop.js";
import { routerSetupScript } from "../lib/setup.js";

const FIELDS = ["base", "user", "pass", "domainListOption", "communityOption",
  "connTypeOption", "listTypeOption", "textOption", "dynamicOption",
  "listDir", "rulesetTmpDir"];

export async function loadCfg() {
  const o = await chrome.storage.local.get(["cfg", "conn"]);
  return { ...DEFAULT_CFG, ...(o.cfg || {}), ...(o.conn || {}) };
}
const $ = id => document.getElementById(id);
function setStatus(m, ok) { const s = $("status"); s.textContent = m; s.className = "status " + (ok ? "ok" : "err"); }

function renderHelp() {
  const u = $("user") ? $("user").value.trim() || "podkop-ext" : "podkop-ext";
  const d = $("listDir") ? $("listDir").value.trim() || "/etc/podkop-lists" : "/etc/podkop-lists";
  if ($("setupScript")) $("setupScript").textContent = routerSetupScript({ user: u, listDir: d });
}

async function init() {
  const cfg = await loadCfg();
  for (const f of FIELDS) if ($(f) && cfg[f] != null) $(f).value = cfg[f];
  renderHelp();
  for (const id of ["user", "listDir"]) $(id)?.addEventListener("input", renderHelp);
  $("copySetup")?.addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText($("setupScript").textContent); e.target.textContent = "Скопировано ✓"; setTimeout(() => e.target.textContent = "Копировать", 1200); }
    catch { e.target.textContent = "выдели и Ctrl+C"; }
  });
}
async function readForm() {
  const c = {};
  for (const f of FIELDS) c[f] = $(f) ? $(f).value.trim() : "";
  return c;
}
$("save").addEventListener("click", async () => {
  const c = await readForm();
  const conn = { base: c.base, user: c.user, pass: c.pass };
  const cfg = { ...c }; delete cfg.base; delete cfg.user; delete cfg.pass;
  await chrome.storage.local.set({ cfg, conn });
  setStatus("Сохранено", true);
});
$("test").addEventListener("click", async () => {
  const c = await readForm();
  setStatus("Подключаюсь…", true);
  try {
    const u = new Ubus(c.base); await u.login(c.user, c.pass);
    const v = await u.uciGetAll("podkop");
    setStatus(`OK. Секций в podkop: ${Object.keys(v).length}`, true);
  } catch (e) { setStatus("Ошибка: " + e.message, false); }
});
init();
