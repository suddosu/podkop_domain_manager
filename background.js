// MV3 service worker: collect every request host per tab. Resets on top-frame
// navigation so "reload & capture" yields exactly the domains used to load the page.

const sets = new Map(); // tabId -> Set<host>
const flushTimers = new Map();

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
function add(tabId, host) {
  if (tabId < 0 || !host) return;
  let s = sets.get(tabId);
  if (!s) { s = new Set(); sets.set(tabId, s); }
  s.add(host);
  scheduleFlush(tabId);
}
function scheduleFlush(tabId) {
  if (flushTimers.has(tabId)) return;
  flushTimers.set(tabId, setTimeout(() => { flushTimers.delete(tabId); flush(tabId); }, 400));
}
async function flush(tabId) {
  const s = sets.get(tabId) || new Set();
  try { await chrome.storage.session.set({ ["cap_" + tabId]: [...s] }); } catch {}
}

chrome.webRequest.onCompleted.addListener(d => add(d.tabId, hostOf(d.url)), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(d => add(d.tabId, hostOf(d.url)), { urls: ["<all_urls>"] });

chrome.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId === 0) { sets.set(d.tabId, new Set()); flush(d.tabId); }
});
chrome.tabs.onRemoved.addListener(tabId => {
  sets.delete(tabId);
  chrome.storage.session.remove("cap_" + tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "getCapture") {
    const s = sets.get(msg.tabId);
    if (s) { reply({ hosts: [...s] }); return false; }
    chrome.storage.session.get("cap_" + msg.tabId)
      .then(o => reply({ hosts: o["cap_" + msg.tabId] || [] }));
    return true;
  }
  if (msg.type === "clearCapture") {
    sets.set(msg.tabId, new Set());
    chrome.storage.session.set({ ["cap_" + msg.tabId]: [] }).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
