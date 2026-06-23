// podkop schema adapter (v0.7+). Isolates version-dependent UCI option names.
// Strategy for "separate file list, not inline text": use `local_domain_lists`
// — a UCI list of PATHS to local PLAIN-TEXT domain files (one domain per line),
// imported by podkop directly from disk (no download, unaffected by
// download_lists_via_proxy). Inline domains live in user_domains_text (text mode)
// or user_domains (dynamic mode) and are READ-ONLY here.

import { normalizeHost } from "./domains.js";

export const DEFAULT_CFG = {
  domainListOption: "local_domain_lists",   // 0.7+. fallbacks: remote_domain_lists
  communityOption: "community_lists",
  subnetOption: "user_subnets",
  connTypeOption: "connection_type",
  listTypeOption: "user_domain_list_type",
  textOption: "user_domains_text",
  dynamicOption: "user_domains",
  listDir: "/etc/podkop-lists",              // persistent (overlay), read by podkop directly
  listExt: ".lst",
  rulesetTmpDir: "/tmp/sing-box/rulesets",   // best-effort community/source rulesets
  reloadCmd: "restart",                       // podkop применяет правки UCI через restart (procd config.change → restart)
};

// Hard whitelist: the only UCI options this extension may write.
const WRITABLE = new Set([
  "local_domain_lists", "remote_domain_lists", "custom_download_domains_list",
]);
export function assertWritable(option) {
  if (!WRITABLE.has(option)) throw new Error(`Опция '${option}' не в whitelist на запись — отказ (защита интерфейсов/прокси).`);
}

const toArr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const splitText = v => String(v || "").split(/[\s,]+/).map(normalizeHost).filter(Boolean);

// ---- schema detection ----
export async function detectSchema(ubus) {
  const all = await ubus.uciGetAll("podkop");
  const seen = new Set();
  for (const s of Object.values(all)) for (const k of Object.keys(s)) seen.add(k);
  const pick = (...c) => c.find(x => seen.has(x));
  return {
    detected: [...seen].sort(),
    suggest: {
      domainListOption: pick("local_domain_lists", "remote_domain_lists", "custom_download_domains_list") || DEFAULT_CFG.domainListOption,
      communityOption: pick("community_lists") || DEFAULT_CFG.communityOption,
      subnetOption: pick("user_subnets", "user_subnets_text") || DEFAULT_CFG.subnetOption,
      connTypeOption: pick("connection_type", "mode") || DEFAULT_CFG.connTypeOption,
      textOption: pick("user_domains_text") || DEFAULT_CFG.textOption,
      dynamicOption: pick("user_domains") || DEFAULT_CFG.dynamicOption,
    },
  };
}

// ---- sections ----
export async function readSections(ubus, cfg) {
  const all = await ubus.uciGetAll("podkop");
  const out = [];
  for (const [name, s] of Object.entries(all)) {
    if (name === "settings") continue;
    const isRouting = cfg.connTypeOption in s || cfg.communityOption in s ||
      cfg.domainListOption in s || cfg.listTypeOption in s;
    if (!isRouting) continue;
    const ldt = s[cfg.listTypeOption];
    let inline = [];
    if (ldt === "text") inline = splitText(s[cfg.textOption]);
    else if (ldt === "dynamic") inline = toArr(s[cfg.dynamicOption]).map(normalizeHost).filter(Boolean);
    out.push({
      name,
      uciType: s[".type"],
      connectionType: s[cfg.connTypeOption] || "?",
      listType: ldt || "disabled",
      community: toArr(s[cfg.communityOption]),
      inline,
      // field name kept for popup compatibility; holds local file PATHS
      fileListUrls: toArr(s[cfg.domainListOption]),
    });
  }
  return out;
}

// ---- managed file lists (plain-text files in listDir) ----
export function listPath(cfg, name) { return `${cfg.listDir}/${name}${cfg.listExt}`; }
export function listUrl(cfg, name) { return listPath(cfg, name); } // value stored in UCI = the path
export function isManagedUrl(cfg, val) { return typeof val === "string" && val.startsWith(cfg.listDir + "/"); }
export function nameFromUrl(val) { return val.replace(/.*\//, "").replace(/\.[^.]+$/, ""); }

export async function readManagedLists(ubus, cfg) {
  let entries = [];
  try { entries = await ubus.fileList(cfg.listDir); }
  catch (e) {
    if (e && e.code === 4) entries = []; // NOT_FOUND: каталог ещё не создан
    else throw new Error(`Не читается каталог списков (${cfg.listDir}): ${e.message}. Нужна ACL-привилегия file.list на САМ каталог, а не только на /*`);
  }
  return entries
    .filter(e => e.type === "file" && e.name.endsWith(cfg.listExt))
    .map(e => {
      const p = `${cfg.listDir}/${e.name}`;
      return { name: e.name.slice(0, -cfg.listExt.length), path: p, url: p };
    });
}

export function buildPlainList(domains) {
  const set = new Set();
  for (const d of domains) { const n = normalizeHost(d); if (n) set.add(n); }
  return [...set].sort().join("\n") + "\n";
}

export async function readListDomains(ubus, path) {
  try {
    const txt = await ubus.fileRead(path);
    return splitText(txt);
  } catch { return []; }
}

export async function writeListFile(ubus, cfg, name, domains) {
  await ubus.exec("/bin/mkdir", ["-p", cfg.listDir]).catch(() => {});
  await ubus.fileWrite(listPath(cfg, name), buildPlainList(domains));
  return { name, path: listPath(cfg, name), url: listPath(cfg, name) };
}

export async function deleteListFile(ubus, cfg, name) {
  await ubus.exec("/bin/rm", ["-f", listPath(cfg, name)]).catch(() => {});
}

// ---- community lists (best-effort; often only .srs => unavailable) ----
export async function readCommunityDomains(ubus, cfg, listName) {
  let entries = [];
  try { entries = await ubus.fileList(cfg.rulesetTmpDir); } catch { return null; }
  const lc = listName.toLowerCase();
  const cand = entries.find(e => e.name.toLowerCase().includes(lc) && e.name.endsWith(".json"));
  if (!cand) return null;
  try {
    const j = JSON.parse(await ubus.fileRead(`${cfg.rulesetTmpDir}/${cand.name}`));
    const out = new Set();
    for (const r of j.rules || []) {
      for (const d of toArr(r.domain)) out.add(d);
      for (const d of toArr(r.domain_suffix)) out.add(String(d).replace(/^\./, ""));
    }
    return [...out];
  } catch { return null; }
}

// ---- apply ----
export async function applyReload(ubus, cfg) {
  if (cfg.reloadCmd === "list_update") return ubus.exec("/usr/bin/podkop", ["list_update"]);
  return ubus.exec("/etc/init.d/podkop", [cfg.reloadCmd || "reload"]);
}
export async function attachToSection(ubus, cfg, section, val) {
  assertWritable(cfg.domainListOption);
  await ubus.listAdd("podkop", section, cfg.domainListOption, val);
}
export async function detachFromSection(ubus, cfg, section, val) {
  assertWritable(cfg.domainListOption);
  await ubus.listRemove("podkop", section, cfg.domainListOption, val);
}

// kept for compatibility (remote .json lists); unused on the local-file path
export function buildRuleset(domains) {
  const set = new Set();
  for (const d of domains) { const n = normalizeHost(d); if (n) set.add(n); }
  const exact = [...set].sort();
  return JSON.stringify({ version: 2, rules: [{ domain: exact, domain_suffix: exact.map(h => "." + h) }] });
}
export function parseRulesetDomains(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const out = new Set();
  for (const r of j.rules || []) {
    for (const d of toArr(r.domain)) out.add(d);
    for (const d of toArr(r.domain_suffix)) out.add(String(d).replace(/^\./, ""));
  }
  return [...out];
}
