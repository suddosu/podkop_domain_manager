// Resolve podkop community lists to their domains by fetching the plain-text
// SOURCES from the itdoginfo/allow-domains repo (the compiled .srs in releases
// aren't readable on disk; sing-box keeps them in cache.db). Fetched in the
// browser, cached in chrome.storage.local. Note: this is the upstream `main`
// source and may differ marginally from the latest compiled release.

import { normalizeHost } from "./domains.js";

const BASE = "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/";

// community tag -> plain-text domain source path
const MAP = {
  russia_inside: "Russia/inside-raw.lst",
  russia_outside: "Russia/outside-raw.lst",
  ukraine_inside: "Ukraine/inside-raw.lst",
  geoblock: "Categories/geoblock.lst",
  block: "Categories/block.lst",
  porn: "Categories/porn.lst",
  news: "Categories/news.lst",
  anime: "Categories/anime.lst",
  hodca: "Categories/hodca.lst",
  youtube: "Services/youtube.lst",
  hdrezka: "Services/hdrezka.lst",
  tiktok: "Services/tiktok.lst",
  google_ai: "Services/google_ai.lst",
  google_play: "Services/google_play.lst",
  google_meet: "Services/google_meet.lst",
  discord: "Services/discord.lst",
  meta: "Services/meta.lst",
  twitter: "Services/twitter.lst",
  telegram: "Services/telegram.lst",
  roblox: "Services/roblox.lst",
};

// subnet/IP-only community lists — no domains to intersect
const SUBNET_ONLY = new Set(["cloudflare", "cloudfront", "digitalocean", "hetzner", "ovh"]);

const TTL = 24 * 3600 * 1000;

export async function getCommunity(tag, force = false) {
  if (SUBNET_ONLY.has(tag)) return { tag, domains: null, reason: "subnet" };
  const path = MAP[tag];
  if (!path) return { tag, domains: null, reason: "unknown" };
  const key = "comm:" + tag;
  if (!force) {
    const o = await chrome.storage.local.get(key);
    const c = o[key];
    if (c && Date.now() - c.ts < TTL) return { tag, domains: c.domains, reason: "cache", ts: c.ts };
  }
  try {
    const r = await fetch(BASE + path, { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const txt = await r.text();
    const domains = [...new Set(
      txt.split(/\r?\n/).map(l => l.replace(/#.*$/, "")).map(normalizeHost).filter(Boolean)
    )];
    await chrome.storage.local.set({ [key]: { ts: Date.now(), domains } });
    return { tag, domains, reason: "fetch", ts: Date.now() };
  } catch (e) {
    const o = await chrome.storage.local.get(key);
    if (o[key]?.domains) return { tag, domains: o[key].domains, reason: "stale", ts: o[key].ts };
    return { tag, domains: null, reason: "net: " + e.message };
  }
}

export async function getCommunityMany(tags, force = false) {
  const out = new Map();
  await Promise.all([...new Set(tags)].map(async t => out.set(t, await getCommunity(t, force))));
  return out;
}
