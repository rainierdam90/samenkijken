"use strict";

/*
 * SameCouch IPTV gateway
 *
 * Provider credentials stay only in this process' short-lived memory. Browsers
 * and room messages receive opaque source/stream tickets. The gateway also
 * rewrites HLS manifests so variants, segments, keys and subtitle renditions
 * remain credential-free and work when the frontend is hosted elsewhere.
 */
const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { Readable } = require("stream");
const express = require("express");

function createIptvService(options) {
  options = options || {};
  const router = express.Router();
  /* Idle TTLs slide on use; the hard TTLs are absolute so a leaked token cannot be kept alive
     forever by polling. Budgets are sized for the 512MB free Render instance. */
  const sourceTtl = Math.max(300, parseInt(process.env.IPTV_SOURCE_TTL || "7200", 10));
  const sourceMaxTtl = Math.max(sourceTtl, parseInt(process.env.IPTV_SOURCE_MAX_TTL || "43200", 10));
  const streamTtl = Math.max(300, parseInt(process.env.IPTV_STREAM_TTL || "1800", 10));
  const streamMaxTtl = Math.max(streamTtl, parseInt(process.env.IPTV_STREAM_MAX_TTL || "28800", 10));
  const maxSessions = Math.max(10, parseInt(process.env.IPTV_MAX_SESSIONS || "25", 10));
  const maxTickets = Math.max(50, parseInt(process.env.IPTV_MAX_TICKETS || "2000", 10));
  const maxCatalogBytes = Math.max(1024 * 1024, parseInt(process.env.IPTV_MAX_CATALOG_BYTES || String(16 * 1024 * 1024), 10));
  const maxPlaylistBytes = Math.max(256 * 1024, parseInt(process.env.IPTV_MAX_PLAYLIST_BYTES || String(12 * 1024 * 1024), 10));
  /* Everyone in one household shares a public IP, and a single HLS player keeps several
     fetches in flight, so the per-IP ceiling has to fit a whole living room, not one viewer. */
  const maxProxyStreams = Math.max(4, parseInt(process.env.IPTV_MAX_STREAMS || "48", 10));
  const maxProxyStreamsPerIp = Math.max(2, parseInt(process.env.IPTV_MAX_STREAMS_PER_IP || "16", 10));
  /* Artwork is its own budget. A catalogue page asks for dozens of thumbnails at once; if those
     shared the video pipe's slots or the API rate limit, browsing would starve playback. */
  const maxArt = Math.max(4, parseInt(process.env.IPTV_MAX_ART || "24", 10));
  const maxArtPerIp = Math.max(2, parseInt(process.env.IPTV_MAX_ART_PER_IP || "12", 10));
  const roomGraceMs = 120000;   // a reload or Wi-Fi blip must not kill an active source
  const allowedPorts = new Set((process.env.IPTV_ALLOWED_PORTS || "80,443,8000,8080,8443,8880,25461").split(",").map(v => v.trim()).filter(Boolean));
  const trustedPrivateHosts = new Set((process.env.IPTV_TRUSTED_PRIVATE_HOSTS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
  const allowedHosts = (process.env.IPTV_ALLOWED_HOSTS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  /* A number of Xtream panels serve the JSON API to every client but silently withhold media
     from unknown player identities. VLC is a deliberately boring, widely accepted default;
     operators can still override it for a provider with stricter requirements. */
  const mediaUserAgent = String(process.env.IPTV_MEDIA_USER_AGENT || "VLC/3.0.21 LibVLC/3.0.21").replace(/[\r\n]/g, " ").slice(0, 240);
  const sessions = new Map();
  const streams = new Map();
  const remuxStreams = new Map();
  const artwork = new Map();

  const allowConnect = options.makeLimiter ? options.makeLimiter(10, 10 * 60 * 1000) : () => true;
  const allowApi = options.makeLimiter ? options.makeLimiter(180, 60 * 1000) : () => true;
  /* One catalogue page is dozens of thumbnails, so artwork needs its own generous budget —
     sharing allowApi meant a couple of pages of browsing tripped the limit and every later
     call came back as "the gateway is busy". */
  const allowArt = options.makeLimiter ? options.makeLimiter(1500, 60 * 1000) : () => true;
  const clientIp = options.clientIp || (req => (req.socket && req.socket.remoteAddress) || "?");
  const authorizeRoom = options.authorizeRoom || (() => false);
  const roomLive = options.roomLive || (() => true);
  const makeStreamToken = typeof options.makeStreamToken === "function" ? options.makeStreamToken : null;
  const internalBase = String(options.internalBase || "").replace(/\/+$/, "");
  const internalRemuxKey = randomToken(24);

  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-SameCouch-IPTV");
    res.setHeader("Cache-Control", "no-store");
  }
  router.use((req, res, next) => { cors(res); if (req.method === "OPTIONS") return res.sendStatus(204); next(); });

  function failure(code, status) {
    const error = new Error(code); error.code = code; error.status = status || 502; return error;
  }
  function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  function asString(value) {
    if (typeof value === "string") { const s = value.trim(); return s || ""; }
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  }
  function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : undefined; }
  function safeText(value, max) { return asString(value).slice(0, max || 160); }
  function randomToken(bytes) { return crypto.randomBytes(bytes || 24).toString("base64url"); }
  function hostAllowed(host) {
    if (!allowedHosts.length) return true;
    return allowedHosts.some(rule => rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1)) && host !== rule.slice(2)));
  }
  function blockedIp(address) {
    address = String(address || "").toLowerCase().split("%")[0];
    if (address.startsWith("::ffff:")) return blockedIp(address.slice(7));
    const kind = net.isIP(address);
    if (kind === 4) {
      const p = address.split(".").map(Number), a = p[0], b = p[1], c = p[2];
      return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113);
    }
    if (kind === 6) return address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address) || address.startsWith("ff") || address.startsWith("2001:db8:");
    return true;
  }
  function sameProviderFamily(left, right) {
    left = String(left || "").replace(/^\[|\]$/g, "").toLowerCase();
    right = String(right || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    if (net.isIP(left) || net.isIP(right)) return false;
    const a = left.split(".").filter(Boolean), b = right.split(".").filter(Boolean);
    return a.length >= 2 && b.length >= 2 && a.slice(-2).join(".") === b.slice(-2).join(".");
  }
  async function validateTarget(raw, options) {
    raw = String(raw || "");
    if (!raw || raw.length > 4096) throw failure("bad_url", 400);
    let url; try { url = new URL(raw); } catch (_) { throw failure("bad_url", 400); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw failure("bad_scheme", 400);
    if (url.username || url.password) throw failure("url_auth_not_allowed", 400);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostAllowed(host)) throw failure("host_not_allowed", 403);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    /* Xtream panels commonly authenticate on one fixed port and then redirect media to a
       high streaming port on a sibling host. Permit that only after a validated redirect,
       only above the privileged range, and only inside the same provider domain family.
       The user-supplied first target still has to be explicitly allow-listed. */
    const redirectFromHost = options && options.redirectFromHost;
    const portNumber = Number(port);
    const safeProviderRedirect = redirectFromHost && portNumber >= 1024 && portNumber <= 65535 && sameProviderFamily(host, redirectFromHost);
    if (!allowedPorts.has(String(port)) && !safeProviderRedirect) throw failure("port_not_allowed", 403);
    let addresses;
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (_) { throw failure("dns_failed", 502); }
    if (!addresses.length) throw failure("dns_failed", 502);
    if (addresses.some(entry => blockedIp(entry.address)) && !trustedPrivateHosts.has(host)) throw failure("private_address", 403);
    return { url, address: addresses[0].address, family: addresses[0].family };
  }
  async function openUpstream(raw, requestOptions, redirects, redirectFromHost) {
    redirects = redirects || 0;
    if (redirects > 4) throw failure("too_many_redirects", 502);
    const target = await validateTarget(raw, { redirectFromHost });
    const transport = target.url.protocol === "https:" ? https : http;
    const opts = requestOptions || {};
    return new Promise((resolve, reject) => {
      const req = transport.request(target.url, {
        method: opts.method || "GET",
        headers: Object.assign({
          "User-Agent": opts.userAgent || "SameCouch-IPTV/1.0",
          Accept: opts.accept || "application/json,text/plain,video/*,*/*;q=0.5",
          "Accept-Encoding": "identity"
        }, opts.headers || {}),
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === "function") { callback = lookupOptions; lookupOptions = {}; }
          if (lookupOptions && lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }
      }, response => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          const next = new URL(response.headers.location, target.url).toString();
          response.resume(); resolve(openUpstream(next, requestOptions, redirects + 1, target.url.hostname)); return;
        }
        if (status < 200 || status >= 300) { response.resume(); reject(failure(status === 401 || status === 403 ? "provider_auth" : "upstream_" + status, status === 401 || status === 403 ? 401 : 502)); return; }
        resolve({ response, url: target.url.toString() });
      });
      const onAbort = () => req.destroy(failure("upstream_aborted", 499));
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
          req.once("close", () => opts.signal.removeEventListener("abort", onAbort));
        }
      }
      req.setTimeout(opts.timeout || 25000, () => req.destroy(failure("upstream_timeout", 504)));
      req.once("error", error => reject(error && error.code && error.status ? error : failure("upstream_failed", 502)));
      req.end();
    });
  }
  function readBody(response, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); reject(failure("upstream_too_large", 413)); return; }
        chunks.push(chunk);
      });
      response.once("end", () => resolve(Buffer.concat(chunks, bytes)));
      response.once("error", () => reject(failure("upstream_failed", 502)));
    });
  }
  function readAtMost(response, maxBytes) {
    return new Promise(resolve => {
      const chunks = []; let bytes = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; resolve(Buffer.concat(chunks, bytes)); };
      response.on("data", chunk => {
        if (settled) return;
        const left = maxBytes - bytes, part = chunk.length > left ? chunk.subarray(0, left) : chunk;
        if (part.length) { chunks.push(part); bytes += part.length; }
        if (bytes >= maxBytes) { finish(); response.destroy(); }
      });
      response.once("end", finish); response.once("error", finish);
    });
  }
  async function probeRange(url, range) {
    const opened = await openUpstream(url, { headers: { Range: range }, accept: "video/*,audio/*,*/*;q=0.1", timeout: 12000, userAgent: mediaUserAgent });
    const response = opened.response;
    const contentRange = String(response.headers["content-range"] || "");
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const total = totalMatch ? Number(totalMatch[1]) : Number(response.headers["content-length"] || 0);
    return { bytes: await readAtMost(response, 512 * 1024), total: Number.isFinite(total) ? total : 0 };
  }
  async function playbackFallback(item, upstream) {
    if (item.kind === "live") return "";   // hls.js reports actual live codecs after parsing the first segment
    if (item.compatibility !== undefined) return item.compatibility;
    if (item.compatibilityPromise) return item.compatibilityPromise;
    item.compatibilityPromise = (async () => {
      try {
        const first = await probeRange(upstream, "bytes=0-524287");
        const samples = [first.bytes];
        if (first.total > 1024 * 1024) {
          try { samples.push((await probeRange(upstream, "bytes=" + Math.max(0, first.total - 524288) + "-")).bytes); } catch (_) {}
        }
        const marker = Buffer.concat(samples).toString("latin1");
        if (/(?:hvc1|hev1|V_MPEGH\/ISO\/HEVC)/i.test(marker)) return "h264";
        if (/(?:ac-3|ec-3|A_(?:E?AC3|DTS)|dts[cehl])/i.test(marker)) return "copy";
        if ((item.extension || "").toLowerCase() === "mkv") return "copy";
      } catch (_) { if ((item.extension || "").toLowerCase() === "mkv") return "copy"; }
      return "";
    })();
    item.compatibility = await item.compatibilityPromise;
    item.compatibilityPromise = null;
    return item.compatibility;
  }
  async function fetchJson(url, maxBytes) {
    const opened = await openUpstream(url, { accept: "application/json,*/*;q=0.2" });
    const body = await readBody(opened.response, maxBytes || maxCatalogBytes);
    try { return JSON.parse(body.toString("utf8")); } catch (_) { throw failure("provider_parse", 502); }
  }
  async function fetchText(url, maxBytes) {
    const opened = await openUpstream(url, { accept: "application/x-mpegURL,audio/mpegurl,text/plain,*/*;q=0.2", timeout: 40000 });
    const body = await readBody(opened.response, maxBytes || maxPlaylistBytes);
    return { text: body.toString("utf8"), url: opened.url };
  }
  function normalizeBase(raw) {
    raw = String(raw || "").trim();
    if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
    let url; try { url = new URL(raw); } catch (_) { throw failure("bad_server", 400); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw failure("bad_server", 400);
    if (url.username || url.password) throw failure("url_auth_not_allowed", 400);
    let path = url.pathname.replace(/\/(?:player_api|get)\.php$/i, "").replace(/\/+$/, "");
    return url.protocol + "//" + url.host + path;
  }
  function mediaBaseFromAuth(root, fallback) {
    const info = root && asRecord(root.server_info), rawHost = info && safeText(info.url, 2048);
    if (!rawHost) return fallback;
    const protocol = /^(?:http|https)$/i.test(asString(info.server_protocol)) ? asString(info.server_protocol).toLowerCase() : new URL(fallback).protocol.slice(0, -1);
    let candidate = /^https?:\/\//i.test(rawHost) ? rawHost : protocol + "://" + rawHost;
    try {
      const url = new URL(candidate);
      if (!url.port) {
        const port = safeText(url.protocol === "https:" ? info.https_port : info.port, 8);
        if (/^\d{1,5}$/.test(port)) url.port = port;
      }
      candidate = url.toString();
    } catch (_) { return fallback; }
    try { return normalizeBase(candidate); } catch (_) { return fallback; }
  }
  function apiUrl(session, action, extra) {
    let out = session.base + "/player_api.php?username=" + encodeURIComponent(session.username) + "&password=" + encodeURIComponent(session.password);
    if (action) out += "&action=" + encodeURIComponent(action);
    if (extra) Object.keys(extra).forEach(key => { out += "&" + encodeURIComponent(key) + "=" + encodeURIComponent(extra[key]); });
    return out;
  }
  function streamUrl(session, item, format) {
    if (session.type === "m3u") return item.upstream;
    /* Xtream may return a per-title CDN/signed URL. Some panels expose their API on one host
       while media lives on another; rebuilding /live or /movie against the API host then gives
       an empty connection even though login and catalogue both work. Keep this URL private in
       the session and prefer it for both direct playback and the server-side remux fallback. */
    if (item.directSource) return item.directSource;
    const base = session.mediaBase || session.base;
    const u = encodeURIComponent(session.username), p = encodeURIComponent(session.password), id = encodeURIComponent(item.providerId);
    if (item.kind === "live") return base + "/live/" + u + "/" + p + "/" + id + (format === "ts" ? ".ts" : ".m3u8");
    if (item.kind === "movie") return base + "/movie/" + u + "/" + p + "/" + id + "." + (item.extension || "mp4");
    return base + "/series/" + u + "/" + p + "/" + id + "." + (item.extension || "mp4");
  }
  async function categoriesFor(session, kind) {
    if (session.type === "m3u") return session.categories[kind] || [];
    const action = kind === "live" ? "get_live_categories" : kind === "movie" ? "get_vod_categories" : "get_series_categories";
    try {
      const raw = await fetchJson(apiUrl(session, action));
      if (!Array.isArray(raw)) return [];
      return raw.slice(0, 10000).map(entry => {
        const rec = asRecord(entry); if (!rec) return null;
        const id = safeText(rec.category_id, 80), title = safeText(rec.category_name, 160);
        return id && title ? { id, title } : null;
      }).filter(Boolean);
    } catch (_) { return []; }
  }
  function inferLang(value) {
    const s = String(value || "").toLowerCase();
    const m = s.match(/(?:^|[._\-/])(en|eng|nl|dut|nld|de|ger|deu|fr|fre|fra|es|spa|it|ita|pt|por|ar|ara|zh|chi|zho|ja|jpn|ko|kor)(?:[._\-/]|$)/);
    if (!m) return "und";
    return ({eng:"en",dut:"nl",nld:"nl",ger:"de",deu:"de",fre:"fr",fra:"fr",spa:"es",ita:"it",por:"pt",ara:"ar",chi:"zh",zho:"zh",jpn:"ja",kor:"ko"})[m[1]] || m[1];
  }
  function collectSubtitleUrls(value, base, out, hint, depth) {
    depth = depth || 0; if (depth > 4 || out.length >= 20 || value == null) return;
    if (typeof value === "string") {
      const bits = value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
      bits.forEach(raw => {
        if (out.length >= 20 || !/^(?:https?:\/\/|\/)/i.test(raw)) return;
        let url; try { url = new URL(raw, base).toString(); } catch (_) { return; }
        if (!/\.(?:srt|vtt|ass|ssa|ttml)(?:$|[?#])/i.test(url) && !/sub|caption|text/i.test(hint || "")) return;
        if (!out.some(item => item.url === url)) out.push({ url, name: safeText((hint || "Subtitles").replace(/[_-]+/g, " "), 80) || "Subtitles", lang: inferLang((hint || "") + " " + url) });
      });
      return;
    }
    if (Array.isArray(value)) { value.forEach(v => collectSubtitleUrls(v, base, out, hint, depth + 1)); return; }
    const rec = asRecord(value); if (!rec) return;
    const ownLang = safeText(rec.language || rec.lang || rec.label || rec.title, 40);
    Object.keys(rec).forEach(key => {
      const subtitleKey = /sub|caption|vtt|srt|ass|file|url/i.test(key);
      collectSubtitleUrls(rec[key], base, out, ownLang || (subtitleKey ? key : hint), depth + 1);
    });
  }
  function subtitleCandidates(value, base) { const out = []; collectSubtitleUrls(value, base, out, "", 0); return out; }

  function parseAttrs(line) {
    const attrs = {}; const re = /([A-Za-z0-9_-]+)="([^"]*)"/g; let match;
    while ((match = re.exec(line))) attrs[match[1].toLowerCase()] = match[2];
    return attrs;
  }
  function parseM3u(text, sourceUrl) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const hls = /#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(text.slice(0, 131072));
    if (hls) return { categories: { live: [{ id: "all", title: "Live" }], movie: [], series: [] }, items: [{ id: "live:stream", providerId: "stream", kind: "live", title: "Live stream", categoryId: "all", upstream: sourceUrl, extension: "m3u8", subtitleData: null }] };
    const categories = { live: [], movie: [], series: [] }, seenGroups = { live: new Set(), movie: new Set(), series: new Set() }, items = [];
    let pending = null, index = 0;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && items.length < 50000; i++) {
      const line = lines[i].trim(); if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        const comma = line.indexOf(","), attrs = parseAttrs(line), title = comma >= 0 ? line.slice(comma + 1).trim() : "";
        pending = { attrs, title }; continue;
      }
      if (line[0] === "#") continue;
      let upstream; try { upstream = new URL(line, sourceUrl).toString(); } catch (_) { pending = null; continue; }
      const attrs = pending ? pending.attrs : {}, title = safeText((pending && pending.title) || attrs["tvg-name"] || "Channel " + (index + 1), 180);
      const group = safeText(attrs["group-title"] || "Other", 120);
      const movieLike = /\.(?:mp4|mkv|avi|mov|m4v)(?:$|[?#])/i.test(upstream) || /vod|movie|film|cinema/i.test(group);
      const kind = movieLike ? "movie" : "live";
      if (!seenGroups[kind].has(group)) { seenGroups[kind].add(group); categories[kind].push({ id: group, title: group }); }
      const extMatch = upstream.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
      items.push({ id: kind + ":m" + index, providerId: "m" + index, kind, title, categoryId: group, image: safeText(attrs["tvg-logo"], 2048), upstream, extension: extMatch ? extMatch[1].toLowerCase() : (kind === "live" ? "m3u8" : "mp4"), subtitleData: attrs.subtitle || attrs.subtitles || attrs["sub-url"] || attrs["subtitle-url"] || null });
      index++; pending = null;
    }
    return { categories, items };
  }
  function normalizeItem(session, kind, rec, index) {
    if (!rec) return null;
    const providerId = safeText(kind === "series" ? rec.series_id : rec.stream_id, 100);
    const title = safeText(rec.name || rec.title, 180);
    if (!providerId || !title) return null;
    const item = { id: kind + ":" + providerId, providerId, kind, title, categoryId: safeText(rec.category_id, 80), image: safeText(kind === "series" ? (rec.cover || rec.stream_icon) : rec.stream_icon, 2048), extension: safeText(rec.container_extension, 12).toLowerCase(), rating: asNumber(rec.rating), year: safeText(rec.year || rec.release_date || rec.releaseDate, 16), plot: safeText(rec.plot, 600), subtitleData: rec.subtitles || rec.subtitle || rec.subtitles_url || null };
    const directSource = safeText(rec.direct_source || rec.directSource, 4096);
    if (/^https?:\/\//i.test(directSource)) item.directSource = directSource;
    if (!item.extension) item.extension = kind === "live" ? "m3u8" : "mp4";
    if (!Number.isFinite(item.rating)) delete item.rating;
    if (!item.categoryId) delete item.categoryId;
    if (!item.image) delete item.image;
    if (!item.year) delete item.year;
    if (!item.plot) delete item.plot;
    return item;
  }
  async function loadCatalog(session, kind) {
    if (session.catalog[kind]) return session.catalog[kind];
    if (session.loading[kind]) return session.loading[kind];
    session.loading[kind] = (async () => {
      let items;
      if (session.type === "m3u") items = session.m3uItems.filter(item => item.kind === kind);
      else {
        const action = kind === "live" ? "get_live_streams" : kind === "movie" ? "get_vod_streams" : "get_series";
        const raw = await fetchJson(apiUrl(session, action));
        items = [];
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length && items.length < 50000; i++) {
            const item = normalizeItem(session, kind, asRecord(raw[i]), i); if (item) items.push(item);
            if (i && i % 2500 === 0) await new Promise(resolve => setImmediate(resolve));
          }
        }
      }
      items.forEach(item => session.items.set(item.id, item));
      session.catalog[kind] = items; session.loading[kind] = null; return items;
    })().catch(error => { session.loading[kind] = null; throw error; });
    return session.loading[kind];
  }
  /* Drop a session AND everything minted from it, so a revoked provider login cannot keep
     serving through an already-issued playback ticket or artwork id. */
  function dropSession(token) {
    token = String(token || "");
    if (!sessions.delete(token)) return false;
    streams.forEach((stream, key) => { if (stream.sessionToken === token) { streams.delete(key); if (stream.remuxKey) remuxStreams.delete(stream.remuxKey); } });
    artwork.forEach((entry, key) => { if (entry.sessionToken === token) artwork.delete(key); });
    return true;
  }
  function touchSession(token) {
    const session = sessions.get(String(token || "")), now = Date.now();
    if (!session) return null;
    if (session.exp < now || session.hardExp < now) { dropSession(session.token); return null; }
    if (roomLive(session.room)) session.roomEmptySince = 0;
    else {
      if (!session.roomEmptySince) session.roomEmptySince = now;
      if (now - session.roomEmptySince > roomGraceMs) { dropSession(session.token); return null; }   // the room it belongs to is gone
    }
    session.exp = Math.min(now + sourceTtl * 1000, session.hardExp); return session;
  }
  function peekSession(token) {   // read without sliding the TTL — used by passive checks
    const session = sessions.get(String(token || "")), now = Date.now();
    return session && session.exp >= now && session.hardExp >= now ? session : null;
  }
  function sourceToken(req) { return String(req.headers["x-samecouch-iptv"] || "").slice(0, 120); }
  function externalBase(req) {
    if (process.env.IPTV_PUBLIC_BASE) return String(process.env.IPTV_PUBLIC_BASE).replace(/\/+$/, "");
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
    return proto + "://" + host;
  }
  function publicSource(session) { return { token: session.token, type: session.type, name: session.name, expiresAt: session.exp }; }
  function artworkFor(req, session, raw) {
    if (!raw || !/^https?:\/\//i.test(raw)) return "";
    let id = session.artByUrl.get(raw);
    if (!id) {
      if (session.artByUrl.size >= 3000) return "";
      id = randomToken(12); session.artByUrl.set(raw, id); artwork.set(id, { url: raw, sessionToken: session.token, exp: session.exp });
    }
    return externalBase(req) + "/iptv/art/" + encodeURIComponent(id);
  }
  function publicItem(req, session, item) {
    const out = { id: item.id, kind: item.kind, title: item.title };
    if (item.categoryId) out.categoryId = item.categoryId;
    if (item.image) { const image = artworkFor(req, session, item.image); if (image) out.image = image; }
    if (item.rating !== undefined) out.rating = item.rating;
    if (item.year) out.year = item.year;
    if (item.plot) out.plot = item.plot;
    if (item.season !== undefined) out.season = item.season;
    if (item.episode !== undefined) out.episode = item.episode;
    return out;
  }
  function createStream(session, upstream) {
    if (streams.size >= maxTickets) throw failure("iptv_busy", 503);
    const ticket = randomToken(24);
    const stream = { ticket, sessionToken: session.token, exp: Date.now() + streamTtl * 1000, hardExp: Date.now() + streamMaxTtl * 1000, aliases: new Map([["root", upstream]]), aliasByUrl: new Map([[upstream, "root"]]) };
    streams.set(ticket, stream); return stream;
  }
  function createRemuxStream(session, item, upstream, video) {
    const key = session.token + "|" + item.id + "|" + video;
    const existingTicket = remuxStreams.get(key), existing = existingTicket && streams.get(existingTicket), now = Date.now();
    if (existing && existing.exp >= now && existing.hardExp >= now) {
      existing.exp = Math.min(now + streamTtl * 1000, existing.hardExp); return existing;
    }
    if (existingTicket) remuxStreams.delete(key);
    const stream = createStream(session, upstream); stream.remuxKey = key; remuxStreams.set(key, stream.ticket); return stream;
  }
  function aliasFor(stream, upstream) {
    const found = stream.aliasByUrl.get(upstream); if (found) return found;
    if (stream.aliases.size >= 10000) throw failure("manifest_too_large", 413);
    const alias = randomToken(10); stream.aliases.set(alias, upstream); stream.aliasByUrl.set(upstream, alias); return alias;
  }
  function resourceUrlAt(base, stream, alias) { return base + "/iptv/resource/" + encodeURIComponent(stream.ticket) + "/" + encodeURIComponent(alias); }
  function resourceUrl(req, stream, alias) { return resourceUrlAt(externalBase(req), stream, alias); }
  function rewriteManifestAt(base, stream, upstream, text) {
    return String(text || "").split(/\r?\n/).map(line => {
      if (!line) return line;
      if (line[0] === "#") return line.replace(/URI="([^"]+)"/g, (_all, value) => {
        let url; try { url = new URL(value, upstream).toString(); } catch (_) { return 'URI=""'; }
        return 'URI="' + resourceUrlAt(base, stream, aliasFor(stream, url)) + '"';
      });
      let url; try { url = new URL(line.trim(), upstream).toString(); } catch (_) { return ""; }
      return resourceUrlAt(base, stream, aliasFor(stream, url));
    }).join("\n");
  }
  function rewriteManifest(req, stream, upstream, text) { return rewriteManifestAt(externalBase(req), stream, upstream, text); }
  function makePool(maxTotal, maxPerIp) {
    const byIp = new Map(); let total = 0;
    return {
      acquire(ip) {
        const count = byIp.get(ip) || 0;
        if (total >= maxTotal || count >= maxPerIp) return false;
        total++; byIp.set(ip, count + 1); return true;
      },
      release(ip) {
        total = Math.max(0, total - 1);
        const left = Math.max(0, (byIp.get(ip) || 1) - 1);
        if (left) byIp.set(ip, left); else byIp.delete(ip);
      },
      active() { return total; }
    };
  }
  const streamPool = makePool(maxProxyStreams, maxProxyStreamsPerIp);
  const artPool = makePool(maxArt, maxArtPerIp);
  function errorResponse(res, error) { if (res.destroyed || res.writableEnded) return; if (!res.headersSent) res.status(error.status || 502).json({ error: error.code || "iptv_failed" }); else res.end(); }

  /* Everything proxied below is served from OUR origin, which also serves the app and /admin.
     Never echo a provider's Content-Type: an "text/html" or SVG body would become same-origin
     script. Anything unrecognised degrades to octet-stream, which <video>/hls.js still play
     (they sniff container bytes, not the HTTP type). */
  const SAFE_MEDIA_TYPES = new Set([
    "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl",
    "video/mp2t", "video/mp4", "video/webm", "video/ogg", "video/x-matroska", "video/quicktime", "video/iso.segment",
    "audio/mp4", "audio/aac", "audio/mpeg", "audio/ogg", "audio/webm",
    "text/vtt", "application/x-subrip", "application/ttml+xml",
    "application/octet-stream"
  ]);
  const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);
  function baseType(raw) { return String(raw || "").toLowerCase().split(";")[0].trim(); }
  function safeMediaType(raw) { const t = baseType(raw); return SAFE_MEDIA_TYPES.has(t) ? t : "application/octet-stream"; }
  function lockDownResponse(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "inline");
  }
  /* Read the first bytes without consuming them, so a playlist that a provider mislabels
     (e.g. text/plain after a redirect) is still recognised and rewritten instead of being
     piped through with the credentialed upstream URLs inside it. */
  function peekHead(source, bytes) {
    return new Promise((resolve, reject) => {
      const onReadable = () => { cleanup(); resolve(source.read(bytes) || source.read() || Buffer.alloc(0)); };
      const onEnd = () => { cleanup(); resolve(Buffer.alloc(0)); };
      const onError = error => { cleanup(); reject(error); };
      function cleanup() { source.removeListener("readable", onReadable); source.removeListener("end", onEnd); source.removeListener("error", onError); }
      source.once("readable", onReadable); source.once("end", onEnd); source.once("error", onError);
    });
  }

  router.post("/connect", async (req, res) => {
    const ip = clientIp(req); if (!allowConnect(ip)) return res.status(429).json({ error: "rate_limited" });
    const body = req.body || {}, room = safeText(body.room, 80), roomKey = safeText(body.roomKey, 128);
    if (!room || !authorizeRoom(room, roomKey)) return res.status(403).json({ error: "room_required" });
    if (sessions.size >= maxSessions) return res.status(503).json({ error: "iptv_busy" });
    const type = body.type === "m3u" ? "m3u" : "xtream";
    try {
      let session;
      if (type === "xtream") {
        const base = normalizeBase(body.server), username = safeText(body.username, 200), password = String(body.password || "").slice(0, 300);
        if (!username || !password) throw failure("credentials_required", 400);
        await validateTarget(base);
        const probe = { base, username, password };
        const auth = await fetchJson(apiUrl(probe));
        const root = asRecord(auth), user = root && asRecord(root.user_info);
        if (!user || asNumber(user.auth) !== 1 || /disabled|banned/i.test(asString(user.status))) throw failure("provider_auth", 401);
        const proposedMediaBase = mediaBaseFromAuth(root, base);
        let mediaBase = base;
        try { await validateTarget(proposedMediaBase); mediaBase = proposedMediaBase; } catch (_) { /* an invalid provider hint must not break a valid login */ }
        const allowedOutputFormats = Array.isArray(user.allowed_output_formats)
          ? user.allowed_output_formats.map(value => safeText(value, 20).toLowerCase()).filter(Boolean)
          : [];
        session = { token: randomToken(24), type, room, base, mediaBase, username, password, allowedOutputFormats, name: safeText(new URL(base).hostname, 120) || "IPTV", exp: Date.now() + sourceTtl * 1000, hardExp: Date.now() + sourceMaxTtl * 1000, roomEmptySince: 0, categories: { live: [], movie: [], series: [] }, catalog: {}, loading: {}, items: new Map(), artByUrl: new Map() };
        session.categories.live = await categoriesFor(session, "live");
        session.categories.movie = await categoriesFor(session, "movie");
        session.categories.series = await categoriesFor(session, "series");
        const expSec = asNumber(user.exp_date); session.accountExpiresAt = expSec && expSec > 0 ? expSec * 1000 : 0;
      } else {
        const playlistUrl = safeText(body.playlistUrl, 4096); if (!playlistUrl) throw failure("playlist_required", 400);
        const fetched = await fetchText(playlistUrl);
        if (!/^\s*#EXTM3U/i.test(fetched.text)) throw failure("playlist_parse", 400);
        const parsed = parseM3u(fetched.text, fetched.url);
        session = { token: randomToken(24), type, room, playlistUrl: fetched.url, name: safeText(new URL(fetched.url).hostname, 120) || "M3U", exp: Date.now() + sourceTtl * 1000, hardExp: Date.now() + sourceMaxTtl * 1000, roomEmptySince: 0, categories: parsed.categories, catalog: {}, loading: {}, items: new Map(), artByUrl: new Map(), m3uItems: parsed.items };
      }
      sessions.set(session.token, session);
      res.json({ source: publicSource(session), categories: session.categories, accountExpiresAt: session.accountExpiresAt || 0 });
    } catch (error) { errorResponse(res, error); }
  });

  router.get("/catalog", async (req, res) => {
    const ip = clientIp(req); if (!allowApi(ip)) return res.status(429).json({ error: "rate_limited" });
    const session = touchSession(sourceToken(req)); if (!session) return res.status(403).json({ error: "source_expired" });
    const kind = req.query.kind === "movie" || req.query.kind === "series" ? req.query.kind : "live";
    const category = safeText(req.query.category, 120), query = safeText(req.query.q, 120).toLowerCase();
    const cursor = Math.max(0, parseInt(req.query.cursor || "0", 10) || 0), limit = Math.max(12, Math.min(120, parseInt(req.query.limit || "60", 10) || 60));
    try {
      let items = await loadCatalog(session, kind);
      if (category) items = items.filter(item => item.categoryId === category);
      if (query) items = items.filter(item => (item.title + " " + (item.plot || "") + " " + (item.year || "")).toLowerCase().includes(query));
      const page = items.slice(cursor, cursor + limit).map(item => publicItem(req, session, item));
      res.json({ source: publicSource(session), kind, categories: session.categories[kind] || [], items: page, total: items.length, nextCursor: cursor + page.length < items.length ? cursor + page.length : null });
    } catch (error) { errorResponse(res, error); }
  });

  router.get("/series", async (req, res) => {
    const ip = clientIp(req); if (!allowApi(ip)) return res.status(429).json({ error: "rate_limited" });
    const session = touchSession(sourceToken(req)); if (!session) return res.status(403).json({ error: "source_expired" });
    if (session.type !== "xtream") return res.status(400).json({ error: "series_unavailable" });
    const id = safeText(req.query.id, 100); if (!id) return res.status(400).json({ error: "bad_series" });
    try {
      const data = await fetchJson(apiUrl(session, "get_series_info", { series_id: id }));
      const root = asRecord(data), rawEpisodes = root && root.episodes, episodes = [];
      const addEpisode = (value, seasonHint) => {
        const rec = asRecord(value); if (!rec) return;
        const providerId = safeText(rec.id || rec.stream_id, 100), title = safeText(rec.title || rec.name, 180); if (!providerId || !title) return;
        const info = asRecord(rec.info) || {}, season = asNumber(rec.season || rec.season_number || seasonHint), episode = asNumber(rec.episode_num || rec.episode || info.episode_num);
        const item = { id: "episode:" + providerId, providerId, kind: "episode", title, extension: safeText(rec.container_extension, 12).toLowerCase() || "mp4", season, episode, image: safeText(info.movie_image || info.cover_big || info.cover, 2048), plot: safeText(info.plot, 600), subtitleData: rec.subtitles || rec.subtitle || info.subtitles || info.subtitle || info.subtitles_url || null };
        const directSource = safeText(rec.direct_source || rec.directSource || info.direct_source || info.directSource, 4096);
        if (/^https?:\/\//i.test(directSource)) item.directSource = directSource;
        session.items.set(item.id, item); episodes.push(item);
      };
      if (Array.isArray(rawEpisodes)) rawEpisodes.forEach(list => { if (Array.isArray(list)) list.forEach(value => addEpisode(value)); else addEpisode(list); });
      else { const obj = asRecord(rawEpisodes); if (obj) Object.keys(obj).forEach(key => { const list = obj[key]; if (Array.isArray(list)) list.forEach(value => addEpisode(value, key)); }); }
      episodes.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
      res.json({ items: episodes.map(item => publicItem(req, session, item)) });
    } catch (error) { errorResponse(res, error); }
  });

  router.post("/resolve", async (req, res) => {
    const ip = clientIp(req); if (!allowApi(ip)) return res.status(429).json({ error: "rate_limited" });
    const session = touchSession(sourceToken(req)); if (!session) return res.status(403).json({ error: "source_expired" });
    const item = session.items.get(safeText((req.body || {}).id, 140)); if (!item || item.kind === "series") return res.status(404).json({ error: "item_not_found" });
    try {
      let extraSubs = subtitleCandidates(item.subtitleData, session.base || session.playlistUrl);
      if (session.type === "xtream" && item.kind === "movie") {
        try {
          const detail = await fetchJson(apiUrl(session, "get_vod_info", { vod_id: item.providerId }), 8 * 1024 * 1024);
          extraSubs = extraSubs.concat(subtitleCandidates(detail, session.base));
        } catch (_) { /* provider detail is optional; the stream can still play */ }
      }
      const directHls = !!(item.directSource && /\.m3u8(?:$|[?#])/i.test(item.directSource));
      const hlsAllowed = item.kind !== "live" || (item.directSource ? directHls : (!session.allowedOutputFormats || !session.allowedOutputFormats.length || session.allowedOutputFormats.includes("m3u8")));
      const upstream = streamUrl(session, item, hlsAllowed ? "hls" : "ts");
      /* A TS-only account cannot ever open the synthetic .m3u8 URL. Tell the client to enter
         the AAC remux path immediately, avoiding a dead request and a needless 12-second wait. */
      const fallback = item.kind === "live" && !hlsAllowed ? "copy" : await playbackFallback(item, upstream);
      const stream = createStream(session, upstream);
      const ext = (item.extension || "").toLowerCase(), mode = item.kind === "live" || ext === "m3u8" ? "hls" : ext === "mkv" ? "mkv" : "file";
      const subtitles = [];
      extraSubs.forEach(sub => {
        if (!sub.url || subtitles.some(existing => existing._raw === sub.url)) return;
        const alias = aliasFor(stream, sub.url); subtitles.push({ name: sub.name, lang: sub.lang, url: resourceUrl(req, stream, alias), _raw: sub.url });
      });
      subtitles.forEach(sub => { delete sub._raw; });
      res.json({ item: publicItem(req, session, item), playback: { url: resourceUrl(req, stream, "root"), mode, live: item.kind === "live", fallback, subtitles } });
    } catch (error) { errorResponse(res, error); }
  });

  /* Fallback when the browser cannot decode a channel/film directly. The normal tier copies
     video and converts only audio to AAC; the explicit h264 tier is the bounded last resort for
     HEVC. The signed browser token contains only "iptv:<random ticket>", never a provider URL. */
  router.post("/remux", async (req, res) => {
    const ip = clientIp(req); if (!allowApi(ip)) return res.status(429).json({ error: "rate_limited" });
    if (!makeStreamToken) return res.status(503).json({ error: "iptv_unavailable" });
    const session = touchSession(sourceToken(req)); if (!session) return res.status(403).json({ error: "source_expired" });
    const item = session.items.get(safeText((req.body || {}).id, 140)); if (!item || item.kind === "series") return res.status(404).json({ error: "item_not_found" });
    try {
      const upstream = streamUrl(session, item, item.kind === "live" ? "ts" : "file");
      await validateTarget(upstream);
      const video = (req.body || {}).video === "h264" ? "h264" : "copy";
      const stream = createRemuxStream(session, item, upstream, video);
      const opaqueRef = "iptv:" + stream.ticket;
      res.json({ streamPath: "/mkv-stream?token=" + encodeURIComponent(makeStreamToken(opaqueRef, { video })), live: item.kind === "live", video });
    } catch (error) { errorResponse(res, error); }
  });

  /* Resolve an IPTV remux ticket inside this process. This deliberately bypasses the public
     domain/CDN hairpin. If an M3U source itself is HLS, make its relative segment URLs absolute
     opaque loopback URLs so FFmpeg can follow them without ever seeing provider credentials. */
  async function openRemuxSource(ticket) {
    const stream = streams.get(String(ticket || "")), now = Date.now();
    if (!stream || stream.exp < now || stream.hardExp < now) { if (stream) streams.delete(stream.ticket); throw failure("stream_expired", 403); }
    const session = touchSession(stream.sessionToken); if (!session) throw failure("source_expired", 403);
    const upstream = stream.aliases.get("root"); if (!upstream) throw failure("resource_missing", 404);
    stream.exp = Math.min(now + streamTtl * 1000, stream.hardExp);
    const opened = await openUpstream(upstream, { accept: "application/vnd.apple.mpegurl,application/x-mpegURL,video/*,audio/*,*/*;q=0.2", timeout: 35000, userAgent: mediaUserAgent });
    let source = opened.response;
    const type = baseType(source.headers["content-type"]);
    let isManifest = /mpegurl/.test(type) || /\.m3u8(?:$|[?#])/i.test(opened.url);
    if (!isManifest && !/^(?:video|audio)\//.test(type)) {
      const head = await peekHead(source, 16); if (head.length) source.unshift(head);
      if (/^\s*#EXTM3U/i.test(head.toString("utf8"))) isManifest = true;
    }
    if (!isManifest) return source;
    const body = await readBody(source, 4 * 1024 * 1024);
    const base = internalBase || "http://127.0.0.1:8080";
    const rendered = rewriteManifestAt(base, stream, opened.url, body.toString("utf8"));
    if (session.username && rendered.includes(session.username)) throw failure("provider_unsupported", 502);
    return Readable.from([Buffer.from(rendered)]);
  }

  async function proxyResource(req, res) {
    const stream = streams.get(String(req.params.ticket || ""));
    if (!stream || stream.exp < Date.now() || stream.hardExp < Date.now()) { if (stream) streams.delete(stream.ticket); return res.status(403).json({ error: "stream_expired" }); }
    const session = touchSession(stream.sessionToken); if (!session) return res.status(403).json({ error: "source_expired" });
    const upstream = stream.aliases.get(String(req.params.alias || "")); if (!upstream) return res.status(404).json({ error: "resource_missing" });
    stream.exp = Math.min(Date.now() + streamTtl * 1000, stream.hardExp);
    const ip = clientIp(req); if (!streamPool.acquire(ip)) { res.setHeader("Retry-After", "10"); return res.status(503).json({ error: "iptv_busy" }); }
    let source, released = false, finished = false;
    const upstreamAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    const done = () => { if (!released) { released = true; streamPool.release(ip); } };
    res.once("finish", () => { finished = true; done(); });
    res.once("close", () => { if (!finished) { if (upstreamAbort) upstreamAbort.abort(); if (source && !source.destroyed) source.destroy(); } done(); });
    try {
      const headers = {}; if (req.headers.range) headers.Range = String(req.headers.range).slice(0, 160);
      const opened = await openUpstream(upstream, { headers, accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/vtt,video/*,audio/*,*/*;q=0.2", timeout: 35000, userAgent: mediaUserAgent, signal: upstreamAbort && upstreamAbort.signal });
      source = opened.response;
      const type = baseType(source.headers["content-type"]);
      let isManifest = /mpegurl/.test(type) || /\.m3u8(?:$|[?#])/i.test(opened.url);
      /* A provider that redirects to a playlist served as text/plain would otherwise be piped
         through verbatim — and its lines carry the credentialed upstream URLs. Sniff instead of
         trusting the label. Skipped for range requests and declared binary media, so the VOD
         byte-range path and ordinary segments never take this branch. */
      if (!isManifest && !req.headers.range && !/^(?:video|audio|image)\//.test(type)) {
        const head = await peekHead(source, 16);
        if (head.length) source.unshift(head);
        if (/^\s*#EXTM3U/i.test(head.toString("utf8"))) isManifest = true;
      }
      if (isManifest) {
        const body = await readBody(source, 4 * 1024 * 1024);
        const rendered = rewriteManifest(req, stream, opened.url, body.toString("utf8"));
        if (session.username && rendered.includes(session.username)) throw failure("provider_unsupported", 502);   // a rewritten playlist must never still name the subscriber
        lockDownResponse(res);
        res.status(200).type("application/vnd.apple.mpegurl").send(rendered); done(); return;
      }
      const status = source.statusCode === 206 ? 206 : 200; res.status(status);
      res.setHeader("Content-Type", safeMediaType(source.headers["content-type"]));
      ["content-length", "content-range", "accept-ranges", "last-modified", "etag"].forEach(name => { if (source.headers[name]) res.setHeader(name, source.headers[name]); });
      lockDownResponse(res);
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); res.setHeader("Timing-Allow-Origin", "*");
      source.once("error", () => { if (!res.writableEnded) res.end(); done(); });
      source.pipe(res);
    } catch (error) { done(); errorResponse(res, error); }
  }
  function loopbackRequest(req) {
    const address = String(req.socket && req.socket.remoteAddress || "").toLowerCase();
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }
  function equalInternalKey(value) {
    const a = Buffer.from(String(value || "")), b = Buffer.from(internalRemuxKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  /* FFmpeg needs a seekable HTTP input for long MP4 VODs (their `moov` atom is commonly at the
     end) and a reconnectable input for live transport streams. This endpoint is reachable only
     over loopback and uses an unguessable process-local key; the URL still contains no provider
     hostname, username or password. Reusing proxyResource preserves Range and HLS rewriting. */
  router.get("/remux-source/:ticket", (req, res) => {
    if (!loopbackRequest(req) || !equalInternalKey(req.query.key)) return res.status(404).end();
    req.params.alias = "root";
    return proxyResource(req, res);
  });
  router.get("/resource/:ticket/:alias", proxyResource);

  router.get("/art/:id", async (req, res) => {
    const ip = clientIp(req); if (!allowArt(ip)) return res.status(429).end();
    const entry = artwork.get(String(req.params.id || ""));
    if (!entry || entry.exp < Date.now() || !touchSession(entry.sessionToken)) { if (entry) artwork.delete(req.params.id); return res.status(404).end(); }
    if (!artPool.acquire(ip)) { res.setHeader("Retry-After", "5"); return res.status(503).end(); }
    let source = null, released = false, finished = false;
    const done = () => { if (!released) { released = true; artPool.release(ip); } };
    res.once("finish", () => { finished = true; done(); });
    res.once("close", () => { if (!finished && source && !source.destroyed) source.destroy(); done(); });   // an aborted thumbnail must not keep fetching upstream
    try {
      const opened = await openUpstream(entry.url, { accept: "image/*,*/*;q=0.1", timeout: 15000 });
      source = opened.response;
      const type = baseType(source.headers["content-type"]);
      if (!SAFE_IMAGE_TYPES.has(type)) { source.destroy(); done(); return res.status(415).end(); }   // exact list: SVG executes script, and no channel logo needs it
      const length = parseInt(source.headers["content-length"] || "0", 10); if (length > 6 * 1024 * 1024) { source.destroy(); done(); return res.status(413).end(); }
      res.setHeader("Cache-Control", "private, max-age=900"); lockDownResponse(res); res.type(type); let sent = 0;
      source.on("data", chunk => { sent += chunk.length; if (sent > 6 * 1024 * 1024) { source.destroy(); if (!res.writableEnded) res.end(); } });
      source.once("error", () => { if (!res.writableEnded) res.end(); done(); });
      source.pipe(res);
    } catch (_) { done(); if (!res.headersSent) res.status(502).end(); }
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    sessions.forEach((session, token) => { if (session.exp < now || session.hardExp < now) dropSession(token); });
    streams.forEach((stream, token) => { if (stream.exp < now || stream.hardExp < now || !sessions.has(stream.sessionToken)) { streams.delete(token); if (stream.remuxKey) remuxStreams.delete(stream.remuxKey); } });
    artwork.forEach((entry, token) => { if (entry.exp < now || !sessions.has(entry.sessionToken)) artwork.delete(token); });
  }, 60000);
  if (sweep.unref) sweep.unref();

  return {
    router,
    openRemuxSource,
    remuxInputUrl(ticket) {
      if (!internalBase) throw failure("iptv_unavailable", 503);
      return internalBase + "/iptv/remux-source/" + encodeURIComponent(String(ticket || "")) + "?key=" + encodeURIComponent(internalRemuxKey);
    },
    publicSession(token) { const session = touchSession(token); return session ? publicSource(session) : null; },
    hasSession(token) { return !!peekSession(token); },
    sessionRoom(token) { const session = peekSession(token); return session ? session.room : ""; },
    revoke(token) { return dropSession(token); },
    stats() { return { sessions: sessions.size, streams: streams.size, activeStreams: streamPool.active(), activeArt: artPool.active() }; }
  };
}

module.exports = { createIptvService };
