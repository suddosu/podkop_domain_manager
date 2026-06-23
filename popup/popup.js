import { Ubus } from "../lib/ubus.js";
import {
  DEFAULT_CFG, detectSchema, readSections, readManagedLists, readListDomains,
  writeListFile, deleteListFile, buildRuleset, parseRulesetDomains,
  readCommunityDomains, applyReload, isManagedUrl, nameFromUrl, listUrl, listPath,
} from "../lib/podkop.js";
import {
  normalizeHost, registrable, groupByRegistrable, coverageCheck, intersection,
} from "../lib/domains.js";
import { getCommunityMany } from "../lib/community.js";
import { routerSetupScript, RELOAD_DESC } from "../lib/setup.js";

const S = {
  cfg: null, conn: null, ubus: null,
  sections: [], lists: [],
  pendingUci: [],          // [{label, run(ubus,cfg)}]
  pendingFiles: new Map(),  // name -> domains[]
  touchedSections: new Set(),
  backup: null,
  capHosts: [], capSel: new Set(),
};

const $ = id => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) e.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return e;
};
function showErr(msg) { const b = $("globalErr"); b.style.display = "block"; b.textContent = msg; }
function clearErr() { $("globalErr").style.display = "none"; }

// ---------- modal ----------
function modal(node) {
  const host = $("modal");
  host.innerHTML = "";
  const back = h("div", { class: "modal-back", style: "position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:50" });
  const box = h("div", { class: "card", style: "width:380px;max-height:90%;overflow:auto;margin:0" });
  box.append(node);
  back.append(box);
  back.addEventListener("click", e => { if (e.target === back) host.innerHTML = ""; });
  host.append(back);
  return () => { host.innerHTML = ""; };
}
function confirm2({ title, body, danger, confirmText = "Подтвердить" }) {
  return new Promise(resolve => {
    const close = modal(h("div", {},
      h("div", { class: "title" }, title),
      h("div", { class: "small muted", style: "margin:8px 0" }, body || ""),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => { close(); resolve(false); } }, "Отмена"),
        h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => { close(); resolve(true); } }, confirmText),
      ),
    ));
  });
}

function settle(ms = 4500) { return new Promise(r => setTimeout(r, ms)); }
function copyBtn(getText, label = "Копировать") {
  return h("button", { class: "btn sm", onclick: async (e) => {
    try { await navigator.clipboard.writeText(getText()); e.target.textContent = "Скопировано ✓"; setTimeout(() => e.target.textContent = label, 1200); }
    catch { e.target.textContent = "выдели и Ctrl+C"; }
  } }, label);
}
function setupBlock(user, listDir) {
  const script = routerSetupScript({ user: user || "podkop-ext", listDir: listDir || S.cfg.listDir });
  return h("details", { style: "margin:8px 0" },
    h("summary", { class: "small", style: "cursor:pointer;color:var(--acc)" }, "▸ Команды для роутера (SSH)"),
    h("div", { class: "flex", style: "margin:6px 0" }, copyBtn(() => script),
      h("span", { class: "small muted" }, "пароль замени на свой — он же вводится в плагине")),
    h("pre", {}, script));
}
function reloadHelp() {
  return h("div", { class: "small muted", style: "margin:-2px 0 8px" },
    h("div", {}, RELOAD_DESC.restart),
    h("div", { style: "margin-top:4px" }, RELOAD_DESC.reload),
    h("div", { style: "margin-top:4px" }, RELOAD_DESC.list_update));
}

// ---------- connect / wizard ----------
async function loadCfg() {
  const o = await chrome.storage.local.get(["cfg", "conn"]);
  S.cfg = { ...DEFAULT_CFG, ...(o.cfg || {}) };
  S.conn = o.conn || null;
}
async function connect() {
  if (!S.conn?.base) throw new Error("no-conn");
  S.ubus = new Ubus(S.conn.base);
  await S.ubus.login(S.conn.user, S.conn.pass);
}

async function runWizard() {
  let step = 1;
  const state = { base: S.conn?.base || "http://192.168.1.1", user: S.conn?.user || "podkop-ext", pass: S.conn?.pass || "" };
  function render() {
    const body = h("div", {});
    body.append(h("div", { class: "title" }, "Первый запуск — настройка"));
    if (step === 1) {
      body.append(
        h("div", { class: "small muted", style: "margin:8px 0" }, "Шаг 1/3. Сначала на роутере по SSH заведи пользователя rpcd и ACL — команды ниже. Затем введи те же данные здесь."),
        field("Адрес", "base", state.base),
        field("Пользователь", "user", state.user),
        field("Пароль", "pass", state.pass, "password"),
        setupBlock(state.user, S.cfg.listDir),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", onclick: async (e) => {
            collect(body, state);
            e.target.disabled = true; e.target.textContent = "Проверяю…";
            try {
              const u = new Ubus(state.base); await u.login(state.user, state.pass);
              await u.uciGetAll("podkop");
              S._wizUbus = u; step = 2; render();
            } catch (err) { e.target.disabled = false; e.target.textContent = "Проверить и далее"; alert("Ошибка: " + err.message); }
          } }, "Проверить и далее"),
        ),
      );
    } else if (step === 2) {
      body.append(h("div", { class: "small muted", style: "margin:8px 0" }, "Шаг 2/3. Определяю схему podkop…"));
      const out = h("pre", {}, "…");
      body.append(out);
      detectSchema(S._wizUbus).then(({ detected, suggest }) => {
        S._wizSchema = suggest;
        out.textContent =
          "Найденные опции:\n" + detected.join("\n") +
          "\n\nБуду использовать:\n" + JSON.stringify(suggest, null, 2);
      }).catch(e => out.textContent = "Ошибка: " + e.message);
      body.append(h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => { step = 1; render(); } }, "Назад"),
        h("button", { class: "btn primary", onclick: () => { step = 3; render(); } }, "Далее"),
      ));
    } else {
      body.append(
        h("div", { class: "small muted", style: "margin:8px 0" }, "Шаг 3/3. Списки — локальные plain-text файлы в этом каталоге (podkop читает их с диска напрямую, через local_domain_lists)."),
        field("Каталог списков", "listDir", S.cfg.listDir),
        h("div", { class: "small muted", style: "margin:4px 0 8px" }, "Применение: плагин делает один uci commit — podkop перезапускается ровно один раз (его триггер config.change → restart). Отдельный restart НЕ выполняется, иначе гонка двух процессов рвёт nftables."),
        h("div", { class: "actions" },
          h("button", { class: "btn", onclick: () => { step = 2; render(); } }, "Назад"),
          h("button", { class: "btn primary", onclick: async (e) => {
            collect(body, state);
            const cfg = { ...S.cfg, ...S._wizSchema, listDir: val(body, "listDir") };
            try {
              await S._wizUbus.exec("/bin/mkdir", ["-p", cfg.listDir]);
            } catch (err) { /* may lack exec ACL; non-fatal */ }
            await chrome.storage.local.set({ cfg, conn: { base: state.base, user: state.user, pass: state.pass } });
            S.cfg = cfg; S.conn = { base: state.base, user: state.user, pass: state.pass };
            close(); boot();
          } }, "Готово"),
        ),
      );
    }
    close = modal(body);
  }
  let close = () => {};
  function field(label, key, v, type = "text") {
    return h("label", {}, label, h("input", { id: "wz_" + key, type, value: v || "" }));
  }
  function select(key, opts, v) {
    const s = h("select", { id: "wz_" + key });
    for (const o of opts) s.append(h("option", { value: o, ...(o === v ? { selected: "" } : {}) }, o));
    return s;
  }
  function val(scope, key) { return scope.querySelector("#wz_" + key).value.trim(); }
  function collect(scope, state) { for (const k of ["base", "user", "pass"]) { const i = scope.querySelector("#wz_" + k); if (i) state[k] = i.value; } }
  render();
}

// ---------- pending / apply / undo ----------
function pendDirty() { return S.pendingUci.length || S.pendingFiles.size; }
function renderBar() {
  const bar = $("bar");
  if (!pendDirty() && !S.backup) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  const n = S.pendingUci.length + S.pendingFiles.size;
  $("pendCount").textContent = n ? `Несохранённых изменений: ${n}` : "Применено — можно откатить";
  $("apply").disabled = !pendDirty();
  $("undo").disabled = !S.backup;
}
function queueUci(label, run) { S.pendingUci.push({ label, run }); renderBar(); }
function queueFile(name, domains) { S.pendingFiles.set(name, domains); renderBar(); }

async function applyChanges() {
  const ok = await confirm2({
    title: "Применить изменения",
    body: "uci commit подтянет podkop к перезапуску один раз (его собственный триггер config.change → restart). Перед этим — бэкап.",
    confirmText: "Применить",
  });
  if (!ok) return;
  clearErr();
  try {
    const backup = { files: {}, sections: {} };
    for (const name of S.pendingFiles.keys()) {
      try { backup.files[name] = await S.ubus.fileRead(listPath(S.cfg, name)); }
      catch { backup.files[name] = null; }
    }
    for (const sec of S.touchedSections) {
      try { backup.sections[sec] = S.ubus._asArr(await S.ubus.uciGet("podkop", sec, S.cfg.domainListOption)); }
      catch { backup.sections[sec] = []; }
    }
    // 1. write files  2. stage uci  3. ONE commit (rpcd шлёт config.change -> podkop сам делает один restart)
    for (const [name, domains] of S.pendingFiles) await writeListFile(S.ubus, S.cfg, name, domains);
    for (const op of S.pendingUci) await op.run(S.ubus, S.cfg);
    await S.ubus.uciCommit("podkop");
    S.backup = backup;
    S.pendingUci = []; S.pendingFiles.clear(); S.touchedSections.clear();
    await chrome.storage.local.set({ lastBackup: backup });
    renderBar();
    showOK("Применено. podkop перезапускается (один раз). Подожди ~10с и проверь во вкладке «Диагностика».");
    await settle();
    await refreshAll();
  } catch (e) { showErr("Не удалось применить: " + e.message); }
}
function showOK(msg) { const b = $("globalErr"); b.style.display = "block"; b.style.background = "#16291b"; b.style.borderColor = "#2f5a3a"; b.style.color = "var(--ok)"; b.textContent = msg; setTimeout(() => { b.style.background = ""; b.style.borderColor = ""; b.style.color = ""; }, 50); }

async function undoChanges() {
  if (!S.backup) return;
  const ok = await confirm2({ title: "Откатить последнее применение?", body: "Файлы и привязки списков вернутся к состоянию до Apply, затем reload.", danger: true, confirmText: "Откатить" });
  if (!ok) return;
  try {
    for (const [name, content] of Object.entries(S.backup.files)) {
      if (content == null) await deleteListFile(S.ubus, S.cfg, name);
      else await S.ubus.fileWrite(listPath(S.cfg, name), content);
    }
    for (const [sec, arr] of Object.entries(S.backup.sections)) {
      await S.ubus.uciSet("podkop", sec, { [S.cfg.domainListOption]: arr });
    }
    await S.ubus.uciCommit("podkop");
    S.backup = null; await chrome.storage.local.remove("lastBackup");
    renderBar(); showOK("Откат выполнен, podkop перезапускается."); await settle(); await refreshAll();
  } catch (e) { showErr("Откат не удался: " + e.message); }
}

// ---------- data refresh ----------
async function refreshAll() {
  S.sections = await readSections(S.ubus, S.cfg);
  try { S.lists = await readManagedLists(S.ubus, S.cfg); }
  catch (e) { S.lists = []; showErr(e.message); }
  renderSections(); renderLists();
}

// active managed-list URLs across all sections
function activeUrls() {
  const set = new Set();
  for (const s of S.sections) for (const u of s.fileListUrls) if (isManagedUrl(S.cfg, u)) set.add(u);
  return set;
}

// build active suffix sets for coverage: file lists (active) + inline + community
async function buildActiveSets(forceCommunity = false) {
  const sets = []; const notes = [];
  for (const url of activeUrls()) {
    const name = nameFromUrl(url);
    const domains = await readListDomains(S.ubus, listPath(S.cfg, name));
    sets.push({ name: "file:" + name, set: new Set(domains) });
  }
  for (const s of S.sections) {
    if (s.inline.length) sets.push({ name: "inline:" + s.name, set: new Set(s.inline.map(normalizeHost).filter(Boolean)) });
  }
  const tags = new Set();
  for (const s of S.sections) for (const c of s.community) tags.add(c);
  if (tags.size) {
    const cm = await getCommunityMany([...tags], forceCommunity);
    for (const [tag, res] of cm) {
      if (res.domains) sets.push({ name: "community:" + tag, set: new Set(res.domains) });
      else notes.push(`${tag}(${res.reason})`);
    }
  }
  return { sets, notes };
}

function allListNames() {
  return [...new Set([...S.lists.map(l => l.name), ...S.pendingFiles.keys()])];
}

// ---------- views ----------
function pill(type) { return h("span", { class: "pill " + type }, type); }

function renderSections() {
  const root = $("sections"); root.innerHTML = "";
  if (!S.sections.length) { root.append(h("div", { class: "muted" }, "Секции не найдены.")); return; }
  for (const s of S.sections) {
    const card = h("div", { class: "card" });
    card.append(h("div", { class: "head" },
      h("span", { class: "title" }, s.name), pill(s.connectionType),
      h("span", { class: "spacer", style: "flex:1" }),
      h("span", { class: "sub" }, `${s.uciType}`)));
    // file lists (managed) — editable
    const fileWrap = h("div", {});
    for (const url of s.fileListUrls) {
      const managed = isManagedUrl(S.cfg, url);
      const name = managed ? nameFromUrl(url) : url;
      const chip = h("span", { class: "chip file" }, (managed ? name : url));
      if (managed) chip.append(h("span", { class: "x", title: "Отвязать", onclick: () => detachUrl(s.name, url) }, "✕"));
      fileWrap.append(chip);
    }
    fileWrap.append(h("button", { class: "btn sm", style: "margin-left:6px", onclick: () => attachDialog(s.name) }, "+ список"));
    card.append(h("div", { class: "sub", style: "margin-top:8px" }, "Файловые списки:"), fileWrap);
    // community + inline — read only
    if (s.community.length) card.append(h("div", { class: "sub", style: "margin-top:6px" }, "Community:"),
      h("div", {}, s.community.map(c => h("span", { class: "chip community" }, c))));
    if (s.inline.length) card.append(h("div", { class: "sub", style: "margin-top:6px" }, `Inline (${s.inline.length}, read-only):`),
      h("div", {}, s.inline.slice(0, 12).map(d => h("span", { class: "chip inline" }, d)),
        s.inline.length > 12 ? h("span", { class: "muted small" }, ` +${s.inline.length - 12}`) : ""));
    root.append(card);
  }
}

function detachUrl(section, url) {
  S.touchedSections.add(section);
  queueUci(`detach ${nameFromUrl(url)} ← ${section}`, async (u, cfg) => u.listRemove("podkop", section, cfg.domainListOption, url));
  // optimistic UI
  const sec = S.sections.find(x => x.name === section);
  if (sec) sec.fileListUrls = sec.fileListUrls.filter(x => x !== url);
  renderSections();
}
function attachUrl(section, url) {
  S.touchedSections.add(section);
  queueUci(`attach ${nameFromUrl(url)} → ${section}`, async (u, cfg) => u.listAdd("podkop", section, cfg.domainListOption, url));
  const sec = S.sections.find(x => x.name === section);
  if (sec && !sec.fileListUrls.includes(url)) sec.fileListUrls.push(url);
  renderSections();
}

function attachDialog(section) {
  const avail = S.lists.filter(l => !(S.sections.find(s => s.name === section)?.fileListUrls.includes(l.url)));
  if (!avail.length) { alert("Нет свободных списков — создай во вкладке «Списки»."); return; }
  const sel = h("select", {}, avail.map(l => h("option", { value: l.name }, l.name)));
  const close = modal(h("div", {},
    h("div", { class: "title" }, `Привязать список → ${section}`),
    h("label", { style: "margin-top:8px" }, "Список", sel),
    h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => close() }, "Отмена"),
      h("button", { class: "btn primary", onclick: () => { attachUrl(section, listUrl(S.cfg, sel.value)); close(); } }, "Привязать"),
    )));
}

function renderLists() {
  const root = $("lists"); root.innerHTML = "";
  if (!S.lists.length) { root.append(h("div", { class: "muted" }, "Пока нет файловых списков.")); return; }
  const active = activeUrls();
  for (const l of S.lists) {
    const usedIn = S.sections.filter(s => s.fileListUrls.includes(l.url)).map(s => s.name);
    const card = h("div", { class: "card" });
    card.append(h("div", { class: "head" },
      h("span", { class: "title" }, l.name),
      h("span", { class: "spacer", style: "flex:1" }),
      h("button", { class: "btn sm", onclick: () => editList(l) }, "править"),
      h("button", { class: "btn sm danger", onclick: () => removeList(l) }, "удалить")));
    card.append(h("div", { class: "sub" }, usedIn.length ? "активен в: " + usedIn.join(", ") : "не привязан"));
    root.append(card);
  }
}

async function editList(l) {
  const domains = await readListDomains(S.ubus, l.path);
  const ta = h("textarea", {}, domains.join("\n"));
  const close = modal(h("div", {},
    h("div", { class: "title" }, "Правка списка " + l.name),
    h("label", { style: "margin-top:8px" }, "Домены", ta),
    h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => close() }, "Отмена"),
      h("button", { class: "btn primary", onclick: () => {
        const ds = ta.value.split(/\s+/).map(normalizeHost).filter(Boolean);
        queueFile(l.name, [...new Set(ds)]); close();
      } }, "В очередь"),
    )));
}

async function removeList(l) {
  const usedIn = S.sections.filter(s => s.fileListUrls.includes(l.url)).map(s => s.name);
  const ok = await confirm2({
    title: "Удалить список " + l.name + "?",
    body: usedIn.length ? `Список привязан к: ${usedIn.join(", ")}. Сначала отвяжу его оттуда, затем удалю файл.` : "Файл будет удалён.",
    danger: true, confirmText: "Удалить",
  });
  if (!ok) return;
  try {
    for (const sec of usedIn) await S.ubus.listRemove("podkop", sec, S.cfg.domainListOption, l.url);
    await deleteListFile(S.ubus, S.cfg, l.name);
    if (usedIn.length) { await S.ubus.uciCommit("podkop"); showOK("Список удалён, podkop перезапускается."); await settle(); }
    else showOK("Список удалён.");
    await refreshAll();
  } catch (e) { showErr("Не удалось удалить: " + e.message); }
}

$("createList").addEventListener("click", () => {
  const name = $("newListName").value.trim();
  if (!/^[a-zA-Z0-9_]+$/.test(name)) { alert("Имя: латиница, цифры, подчёркивание."); return; }
  if (S.lists.find(l => l.name === name) || S.pendingFiles.has(name)) { alert("Список с таким именем уже есть."); return; }
  const domains = [...new Set($("newListDomains").value.split(/\s+/).map(normalizeHost).filter(Boolean))];
  queueFile(name, domains);
  // reflect in lists immediately (as pending)
  S.lists.push({ name, path: listPath(S.cfg, name), url: listUrl(S.cfg, name) });
  $("newListName").value = ""; $("newListDomains").value = "";
  renderLists();
});

// ---------- collector ----------
async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }

async function getCapture(tabId) {
  return new Promise(res => chrome.runtime.sendMessage({ type: "getCapture", tabId }, r => res(r?.hosts || [])));
}
async function recapture() {
  const t = await activeTab();
  if (!t) return;
  await new Promise(res => chrome.runtime.sendMessage({ type: "clearCapture", tabId: t.id }, res));
  $("recapture").disabled = true; $("recapture").textContent = "Перезагружаю…";
  await chrome.tabs.reload(t.id);
  await new Promise(resolve => {
    const to = setTimeout(done, 9000);
    function listener(id, info) { if (id === t.id && info.status === "complete") done(); }
    function done() { clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    chrome.tabs.onUpdated.addListener(listener);
  });
  await new Promise(r => setTimeout(r, 700)); // tail of late requests
  $("recapture").disabled = false; $("recapture").textContent = "Перезагрузить и собрать";
  await loadCapture();
}
async function loadCapture() {
  const t = await activeTab();
  S.capHosts = (await getCapture(t.id)).map(normalizeHost).filter(Boolean);
  S.capHosts = [...new Set(S.capHosts)];
  S.capSel = new Set();
  renderCapture();
}
function renderCapture() {
  const root = $("capList"); root.innerHTML = "";
  $("capCount").textContent = `${S.capHosts.length} доменов`;
  const groups = groupByRegistrable(S.capHosts);
  for (const g of groups) {
    for (const host of g.hosts) {
      const id = "c_" + host;
      const row = h("div", { class: "dom" });
      const cb = h("input", { type: "checkbox", id, ...(S.capSel.has(host) ? { checked: "" } : {}) });
      cb.addEventListener("change", () => { cb.checked ? S.capSel.add(host) : S.capSel.delete(host); updateAddBtn(); });
      row.append(cb, h("span", { class: host === g.reg ? "reg" : "" }, host));
      root.append(row);
    }
  }
  updateAddBtn();
}
function updateAddBtn() { $("addSelected").disabled = S.capSel.size === 0; $("addSelected").textContent = `Добавить выбранные (${S.capSel.size})…`; }

$("selAll").addEventListener("click", () => { S.capSel = new Set(S.capHosts); renderCapture(); });
$("selNone").addEventListener("click", () => { S.capSel = new Set(); renderCapture(); });
$("refreshCap").addEventListener("click", loadCapture);
$("recapture").addEventListener("click", recapture);

$("addSelected").addEventListener("click", async () => {
  const chosen = [...S.capSel];
  // coverage check against active lists
  const { sets, notes } = await buildActiveSets();
  const { covered, fresh } = coverageCheck(chosen, sets);
  const targetSel = h("select", {},
    h("option", { value: "__new__" }, "＋ новый список…"),
    allListNames().map(n => h("option", { value: n }, n)));
  const newName = h("input", { placeholder: "имя нового списка", style: "display:none;margin-top:6px" });
  targetSel.addEventListener("change", () => newName.style.display = targetSel.value === "__new__" ? "block" : "none");
  newName.style.display = "block";
  const attachSel = h("select", {}, h("option", { value: "" }, "— не привязывать —"),
    S.sections.map(s => h("option", { value: s.name }, s.name)));
  const onlyFresh = h("input", { type: "checkbox", checked: "" });

  const body = h("div", {},
    h("div", { class: "title" }, "Добавить домены"),
    covered.length ? h("div", { class: "warnbox" },
      `${covered.length} уже покрыты активными списками: ` +
      covered.slice(0, 6).map(c => `${c.domain}→${c.by}`).join(", ") + (covered.length > 6 ? "…" : "")) : "",
    notes.length ? h("div", { class: "small muted" }, "⚠ Содержимое community-списков не прочитано (" + notes.join(", ") + ") — пересечение по ним не проверялось.") : "",
    h("label", { style: "margin-top:8px" }, h("span", {}, onlyFresh, " добавлять только новые (без покрытых)")),
    h("label", { style: "margin-top:8px" }, "Целевой список", targetSel), newName,
    h("label", { style: "margin-top:8px" }, "Привязать к секции (опц.)", attachSel),
    h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => close() }, "Отмена"),
      h("button", { class: "btn primary", onclick: async () => {
        const add = onlyFresh.checked ? fresh : chosen;
        if (!add.length) { alert("Нечего добавлять."); return; }
        let name = targetSel.value;
        if (name === "__new__") {
          name = newName.value.trim();
          if (!/^[a-zA-Z0-9_]+$/.test(name)) { alert("Имя: латиница/цифры/_."); return; }
        }
        // merge with existing/pending content
        let base = S.pendingFiles.get(name);
        if (!base) {
          const existing = S.lists.find(l => l.name === name);
          base = existing ? await readListDomains(S.ubus, existing.path) : [];
        }
        const merged = [...new Set([...base, ...add])];
        queueFile(name, merged);
        if (!S.lists.find(l => l.name === name)) S.lists.push({ name, path: listPath(S.cfg, name), url: listUrl(S.cfg, name) });
        if (attachSel.value) {
          const url = listUrl(S.cfg, name);
          if (!S.sections.find(s => s.name === attachSel.value)?.fileListUrls.includes(url)) attachUrl(attachSel.value, url);
        }
        close(); renderLists(); showOK(`В очередь: +${add.length} доменов → ${name}`);
      } }, "Добавить"),
    ));
  const close = modal(body);
});

// ---------- intersection ----------
async function runIntersect(forceCommunity) {
  const out = $("intersectOut"); out.innerHTML = forceCommunity ? "Обновляю community и считаю…" : "Считаю…";
  try {
    const { sets, notes } = await buildActiveSets(forceCommunity);
    const lists = sets.map(s => ({ name: s.name, domains: [...s.set] }));
    const inter = intersection(lists);
    out.innerHTML = "";
    if (notes.length) out.append(h("div", { class: "small muted", style: "margin-bottom:8px" }, "⚠ Не получены community: " + notes.join(", ")));
    out.append(h("div", { class: "small muted", style: "margin-bottom:8px" }, `Активных списков: ${lists.length}. Пересечений: ${inter.length}.`));
    if (!inter.length) { out.append(h("div", { class: "muted" }, "Дубликатов между активными списками нет.")); return; }
    const list = h("div", { class: "list" });
    for (const r of inter) {
      list.append(h("div", { class: "dom" },
        h("span", { class: "reg" }, r.domain),
        h("span", { class: "spacer", style: "flex:1" }),
        h("span", { class: "muted small" }, r.lists.join(" ∩ "))));
    }
    out.append(list);
  } catch (e) { out.innerHTML = ""; out.append(h("div", { class: "warnbox" }, "Ошибка: " + e.message)); }
}
$("runIntersect").addEventListener("click", () => runIntersect(false));
$("refreshCommunity").addEventListener("click", () => runIntersect(true));

// ---------- diagnostics ----------
const DIAG_CHECKS = [
  { cmd: "get_status", label: "Служба podkop" },
  { cmd: "get_sing_box_status", label: "sing-box" },
  { cmd: "check_nft_rules", label: "nftables правила" },
  { cmd: "check_sing_box", label: "sing-box проверка" },
  { cmd: "check_dns_available", label: "DNS" },
  { cmd: "check_fakeip", label: "FakeIP" },
];
function diagOk(v) {
  return v === 1 || v === true || (typeof v === "string" && /\b(running|enabled|passed|ok|available|true)\b/i.test(v));
}
function renderDiag(r) {
  const card = h("div", { class: "card" });
  card.append(h("div", { class: "head" },
    h("span", { class: "title" }, r.label),
    h("span", { class: "spacer", style: "flex:1" }),
    h("span", { class: "pill" }, r.error ? "ошибка" : ("exit " + r.code))));
  if (r.error) { card.append(h("div", { class: "warnbox" }, r.error)); return card; }
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch {}
  if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) {
      const ok = diagOk(v), bad = v === 0 || v === false;
      card.append(h("div", { class: "dom" },
        h("span", { class: "muted" }, k),
        h("span", { class: "spacer", style: "flex:1" }),
        h("span", { class: "small", style: `color:var(--${ok ? "ok" : bad ? "err" : "fg"})` }, String(v))));
    }
  } else if (r.stdout) {
    card.append(h("pre", { style: "max-height:160px" }, r.stdout.slice(0, 4000)));
  } else {
    card.append(h("div", { class: "small muted" }, r.stderr ? r.stderr.slice(0, 400) : "(пусто)"));
  }
  return card;
}
async function runDiag() {
  const out = $("diagOut"); out.innerHTML = "";
  out.append(h("div", { class: "small muted" }, "Гоняю проверки (~10с)…"));
  const results = [];
  for (const c of DIAG_CHECKS) {
    try {
      const r = await S.ubus.exec("/usr/bin/podkop", [c.cmd]);
      results.push({ ...c, code: r.code ?? 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() });
    } catch (e) { results.push({ ...c, error: e.message }); }
  }
  out.innerHTML = "";
  for (const r of results) out.append(renderDiag(r));
}
$("runDiag").addEventListener("click", runDiag);

// ---------- tabs / boot ----------
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".view").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $("view-" + b.dataset.view).classList.add("active");
  if (b.dataset.view === "collect") loadCapture();
}));
$("apply").addEventListener("click", applyChanges);
$("undo").addEventListener("click", undoChanges);

async function boot() {
  clearErr();
  await loadCfg();
  // Миграция: прежний дефолт 'reload' оставлял лишние nft-правила в части сетапов.
  const mig = await chrome.storage.local.get("migReloadRestart");
  if (!mig.migReloadRestart) {
    if (S.cfg.reloadCmd === "reload") { S.cfg.reloadCmd = "restart"; await chrome.storage.local.set({ cfg: S.cfg }); }
    await chrome.storage.local.set({ migReloadRestart: true });
  }
  const o = await chrome.storage.local.get("lastBackup");
  if (o.lastBackup) { S.backup = o.lastBackup; renderBar(); }
  if (!S.conn?.base) { runWizard(); return; }
  try {
    await connect();
    await refreshAll();
  } catch (e) {
    if (e.message === "no-conn") { runWizard(); return; }
    showErr("Подключение: " + e.message + "  → проверь настройки (шестерёнка) или ACL rpcd.");
  }
}
boot();
