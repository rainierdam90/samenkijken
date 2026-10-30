/* ============================================================================
 * "Discover" — free, legal content to browse and watch together, no API keys:
 *   - Internet Archive: public-domain feature films and cartoons (direct MP4)
 *   - Radio Browser:    community directory of internet radio stations
 *   - PeerTube:         the open, federated video platform (via SepiaSearch)
 * Searches go through this server (results cached, the user's IP is not sent to
 * the directories while browsing). Playback then streams directly from the source
 * into the room's existing synced player. Only fixed API hosts are contacted, plus
 * PeerTube instances, which are validated (https, public address) before fetching.
 * ==========================================================================*/
"use strict";
const express = require("express");
const dns = require("dns").promises;

const UA = "SameCouch/1.0 (+https://samecouch.com; discover)";
const RADIO_HOSTS = ["de1.api.radio-browser.info", "nl1.api.radio-browser.info", "fi1.api.radio-browser.info"];
const ARCHIVE_COLLECTIONS = "(feature_films OR classic_cartoons OR silent_films OR film_noir)";
const PLAYABLE_RADIO_CODECS = new Set(["MP3", "AAC", "AAC+", "OGG", "OPUS", "MPEG"]);

function createDiscover(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const lookup = opts.lookup || ((host) => dns.lookup(host, { all: true }));
  const blockedIp = opts.blockedIp || (() => false);
  const limiter = opts.makeLimiter ? opts.makeLimiter(90, 60000) : () => true;
  const clientIp = opts.clientIp || (req => req.socket && req.socket.remoteAddress);
  const cors = opts.cors || ((req, res) => res.setHeader("Access-Control-Allow-Origin", "*"));
  const cache = new Map();   // key -> { ts, data }
  const TTL = 10 * 60000, MAX_CACHE = 400;

  async function getJson(url, ms) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms || 9000);
    try {
      const r = await fetchImpl(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, redirect: "follow", signal: ctrl.signal });
      if (!r.ok) throw Object.assign(new Error("upstream " + r.status), { code: "upstream" });
      const text = await r.text();
      if (text.length > 4 * 1024 * 1024) throw Object.assign(new Error("too big"), { code: "upstream" });
      return JSON.parse(text);
    } finally { clearTimeout(t); }
  }
  async function cached(key, fn) {
    const hit = cache.get(key); if (hit && Date.now() - hit.ts < TTL) return hit.data;
    const data = await fn();
    cache.set(key, { ts: Date.now(), data });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return data;
  }
  const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n || 160);
  const query = (req) => clean(req.query.q, 100);
  const httpsOnly = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.toString() : ""; } catch (e) { return ""; } };

  /* ---------------- Internet Archive ---------------- */
  async function archiveSearch(q, page) {
    const words = q.replace(/[^\p{L}\p{N} '-]/gu, " ").trim();
    const terms = words ? " AND (title:(" + words + ") OR subject:(" + words + "))" : "";
    /* only items that actually carry a browser-playable MP4, and keep the default family-friendly
       (the most-downloaded public-domain list is full of 1930s "exploitation" films) */
    const playable = " AND format:(\"h.264\" OR \"MPEG4\" OR \"512Kb MPEG4\" OR \"h.264 IA\")";
    const family = " AND -title:(sex OR sexy OR nude OR nudist OR erotic OR stripper OR burlesque) AND -subject:(sex OR sexploitation OR exploitation OR erotica OR erotic OR adult OR nudity OR burlesque OR drugs)";
    const url = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent("collection:" + ARCHIVE_COLLECTIONS + " AND mediatype:movies AND -access-restricted-item:true" + playable + family + terms) +
      "&fl[]=identifier&fl[]=title&fl[]=year&fl[]=runtime&fl[]=downloads&sort[]=downloads+desc&rows=24&page=" + page + "&output=json";
    const j = await getJson(url);
    return ((j.response && j.response.docs) || []).filter(d => /^[A-Za-z0-9._-]{1,100}$/.test(d.identifier || "")).map(d => ({
      id: d.identifier, title: clean(d.title, 140) || d.identifier, meta: [d.year ? String(d.year).slice(0, 4) : "", clean(d.runtime, 20)].filter(Boolean).join(" · "),
      thumb: "https://archive.org/services/img/" + encodeURIComponent(d.identifier)
    }));
  }
  /* best browser-playable MP4 of an item: h.264 (≈480p) → MPEG4 → 512Kb */
  async function archivePlay(id) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw Object.assign(new Error("bad id"), { code: "bad_request" });
    const j = await getJson("https://archive.org/metadata/" + encodeURIComponent(id), 12000);
    if (j.is_dark || (j.metadata && /restricted/i.test(String(j.metadata["access-restricted-item"] || "")))) throw Object.assign(new Error("restricted"), { code: "not_playable" });
    const rank = f => /^h\.264$/i.test(f.format) ? 0 : /^h\.264 ia$/i.test(f.format) ? 1 : /^mpeg4$/i.test(f.format) ? 2 : /512kb mpeg4/i.test(f.format) ? 3 : 9;
    const files = (j.files || []).filter(f => /\.mp4$/i.test(f.name || "") && f.private !== "true" && rank(f) < 9).sort((a, b) => rank(a) - rank(b) || (+b.size || 0) - (+a.size || 0));
    const f = files[0]; if (!f) throw Object.assign(new Error("no mp4"), { code: "not_playable" });
    return { url: "https://archive.org/download/" + encodeURIComponent(id) + "/" + f.name.split("/").map(encodeURIComponent).join("/"), title: clean((j.metadata && j.metadata.title) || id, 180), duration: Math.round(+f.length || 0), live: false };
  }

  /* ---------------- Radio Browser ---------------- */
  async function radioGet(path) {
    let last;
    for (const host of RADIO_HOSTS) { try { return await getJson("https://" + host + path, 7000); } catch (e) { last = e; } }
    throw last || new Error("radio unavailable");
  }
  function radioOk(s) {
    const url = httpsOnly(s.url_resolved || s.url), codec = String(s.codec || "").toUpperCase();
    return !!url && !/\.m3u8(\?|$)/i.test(url) && PLAYABLE_RADIO_CODECS.has(codec) && s.lastcheckok === 1;
  }
  async function radioSearch(q, country) {
    const p = new URLSearchParams({ limit: "60", order: "clickcount", reverse: "true", hidebroken: "true", is_https: "true" });
    if (q) p.set("name", q); if (country && /^[A-Z]{2}$/.test(country)) p.set("countrycode", country);
    const list = await radioGet("/json/stations/search?" + p.toString());
    return (Array.isArray(list) ? list : []).filter(radioOk).slice(0, 30).map(s => ({
      id: clean(s.stationuuid, 40), title: clean(s.name, 100), meta: [clean(s.country, 40), String(s.codec || "").toUpperCase(), s.bitrate ? s.bitrate + " kbps" : ""].filter(Boolean).join(" · "),
      thumb: httpsOnly(s.favicon),
      url: httpsOnly(s.url_resolved || s.url)   // lets the browser start the stream inside the tap itself (Safari's autoplay rule)
    }));
  }
  async function radioPlay(uuid) {
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw Object.assign(new Error("bad id"), { code: "bad_request" });
    const list = await radioGet("/json/stations/byuuid/" + uuid);
    const s = Array.isArray(list) && list[0]; if (!s || !radioOk(s)) throw Object.assign(new Error("not playable"), { code: "not_playable" });
    radioGet("/json/url/" + uuid).catch(() => {});   // counts a "click" — the directory's own popularity signal, as its docs ask
    return { url: httpsOnly(s.url_resolved || s.url), title: clean(s.name, 180), duration: 0, live: true };
  }

  /* ---------------- PeerTube (SepiaSearch index) ---------------- */
  async function peertubeSearch(q, lang) {
    const p = new URLSearchParams({ count: "24", start: "0", nsfw: "false", isLive: "false", durationMin: "120" });
    if (q) { p.set("search", q); p.set("sort", "-match"); } else { p.set("sort", "-views"); if (lang) p.append("languageOneOf", lang); p.append("languageOneOf", "en"); }
    const j = await getJson("https://sepiasearch.org/api/v1/search/videos?" + p.toString());
    return ((j && j.data) || []).map(v => {
      let host = ""; try { host = new URL(v.url).host; } catch (e) {}
      if (!host || !/^[0-9a-f-]{36}$/i.test(v.uuid || "")) return null;
      const mins = Math.round((+v.duration || 0) / 60);
      return { id: host + "/" + v.uuid, title: clean(v.name, 140), meta: [clean((v.account && v.account.displayName) || (v.channel && v.channel.displayName), 50), mins ? mins + " min" : ""].filter(Boolean).join(" · "), thumb: httpsOnly(v.thumbnailUrl) };
    }).filter(Boolean);
  }
  async function safeHost(host) {
    host = String(host || "").toLowerCase();
    if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw Object.assign(new Error("bad host"), { code: "bad_request" });
    const addrs = await lookup(host).catch(() => []);
    if (!addrs.length || addrs.some(a => blockedIp(a.address))) throw Object.assign(new Error("blocked host"), { code: "bad_request" });
    return host;
  }
  async function peertubePlay(ref) {
    const m = /^([a-z0-9.-]+)\/([0-9a-f-]{36})$/i.exec(String(ref || "")); if (!m) throw Object.assign(new Error("bad id"), { code: "bad_request" });
    const host = await safeHost(m[1]);
    const v = await getJson("https://" + host + "/api/v1/videos/" + m[2], 10000);
    if (v.isLive) throw Object.assign(new Error("live"), { code: "not_playable" });
    const pick = (files) => (files || []).filter(f => f && f.fileUrl && f.resolution && f.resolution.id > 0 && f.resolution.id <= 720).sort((a, b) => b.resolution.id - a.resolution.id)[0];
    const f = pick(v.files) || pick(((v.streamingPlaylists || [])[0] || {}).files);   // plain MP4 first, else the fragmented MP4 of the HLS rendition
    const url = f && httpsOnly(f.fileUrl);
    if (!url) throw Object.assign(new Error("no file"), { code: "not_playable" });
    return { url, title: clean(v.name, 180), duration: Math.round(+v.duration || 0), live: false };
  }

  const router = express.Router();
  function handler(fn) {
    return async (req, res) => {
      cors(req, res); res.setHeader("Cache-Control", "no-store");
      if (!limiter(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
      try { res.json(await fn(req)); }
      catch (e) { const code = e && e.code; res.status(code === "bad_request" ? 400 : code === "not_playable" ? 422 : 502).json({ error: code || "upstream" }); }
    };
  }
  router.get("/archive", handler(async req => { const q = query(req), page = Math.min(20, Math.max(1, parseInt(req.query.page, 10) || 1)); return { items: await cached("ia|" + q + "|" + page, () => archiveSearch(q, page)) }; }));
  router.get("/archive/play", handler(async req => cached("iap|" + clean(req.query.id, 100), () => archivePlay(clean(req.query.id, 100)))));
  router.get("/radio", handler(async req => { const q = query(req), c = clean(req.query.country, 2).toUpperCase(); return { items: await cached("rb|" + q + "|" + c, () => radioSearch(q, c)) }; }));
  router.get("/radio/play", handler(async req => radioPlay(clean(req.query.id, 40))));
  router.get("/peertube", handler(async req => { const q = query(req), l = /^[a-z]{2}$/.test(String(req.query.lang || "")) ? String(req.query.lang) : ""; return { items: await cached("pt|" + q + "|" + l, () => peertubeSearch(q, l)) }; }));
  router.get("/peertube/play", handler(async req => cached("ptp|" + clean(req.query.id, 120), () => peertubePlay(clean(req.query.id, 120)))));
  return { router, _internal: { archivePlay, radioSearch, peertubePlay, safeHost } };
}

module.exports = { createDiscover };
