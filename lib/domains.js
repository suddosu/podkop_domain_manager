// Domain helpers: normalization, registrable-domain (eTLD+1, compact PSL),
// suffix coverage, and intersection across lists.

// Compact multi-label public suffix set. NOT the full PSL — good enough for
// grouping; swap in the full list (publicsuffix.org) if you need exhaustive
// correctness.
const TWO_LEVEL = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg",
  "co.kr", "co.in", "co.il", "co.za",
  "com.ua", "net.ua", "org.ua", "in.ua",
  "msk.ru", "spb.ru",
]);

export function isIp(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:]+$/i.test(h));
}

// returns clean hostname or null if not a usable domain
export function normalizeHost(raw) {
  if (!raw) return null;
  let h = String(raw).trim().toLowerCase();
  // strip scheme/path/port if a URL slipped in
  h = h.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0];
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  if (h.startsWith("*.")) h = h.slice(2);
  if (h.startsWith(".")) h = h.slice(1);
  if (!h || isIp(h) || !h.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) {
    try { h = new URL("http://" + h).hostname; } catch { return null; }
  }
  return h;
}

export function registrable(host) {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  if (TWO_LEVEL.has(last2)) return p.slice(-3).join(".");
  return last2;
}

// Is `host` matched by a set of suffix entries (each entry is exact or a parent suffix)?
export function coveredBy(host, suffixSet) {
  if (suffixSet.has(host)) return true;
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i++) {
    if (suffixSet.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

// lists: [{name, domains:[...]}]  ->  { domain -> [listNames] } for domains in >1 list
export function intersection(lists) {
  const membership = new Map();
  for (const l of lists) {
    for (const d of new Set(l.domains)) {
      if (!membership.has(d)) membership.set(d, []);
      membership.get(d).push(l.name);
    }
  }
  const out = [];
  for (const [d, names] of membership) {
    if (names.length > 1) out.push({ domain: d, lists: names });
  }
  out.sort((a, b) => b.lists.length - a.lists.length || a.domain.localeCompare(b.domain));
  return out;
}

// Which of `candidates` are already covered by any of the active suffix sets.
// activeSets: [{name, set:Set}]
export function coverageCheck(candidates, activeSets) {
  const covered = [], fresh = [];
  for (const h of candidates) {
    const hit = activeSets.find(a => coveredBy(h, a.set));
    if (hit) covered.push({ domain: h, by: hit.name });
    else fresh.push(h);
  }
  return { covered, fresh };
}

// Group hosts by registrable domain for a compact collector view.
export function groupByRegistrable(hosts) {
  const m = new Map();
  for (const h of hosts) {
    const r = registrable(h);
    if (!m.has(r)) m.set(r, new Set());
    m.get(r).add(h);
  }
  return [...m.entries()]
    .map(([reg, set]) => ({ reg, hosts: [...set].sort() }))
    .sort((a, b) => a.reg.localeCompare(b.reg));
}
