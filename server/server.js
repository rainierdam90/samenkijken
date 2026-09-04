/* ============================================================================
 * SameCouch — single backend
 *
 * One Node process that provides EVERYTHING the realtime app needs:
 *   - Static hosting of the front-end (public/)
 *   - Your OWN WebRTC signaling (self-hosted PeerJS server at /peerjs)
 *   - A realtime control plane at /rt  (room roster, play/pause sync,
 *     "who is talking", and CHAT — chat is relayed + logged so the admin can
 *     moderate it)
 *   - An admin dashboard at /admin  (live counts + live chat monitoring)
 *   - Short-lived TURN credentials at /turn-credentials  (HMAC, coturn-compatible)
 *
 * IMPORTANT — privacy model:
 *   Live camera/mic and device-shared media stay peer-to-peer and end-to-end
 *   encrypted (WebRTC). CHAT and selected subtitle text pass through this
 *   server. Remote MKV/opaque direct-video sources also pass temporarily through
 *   FFmpeg on this server. Disclose these distinctions in the privacy policy.
 *
 * Deploy on a host with persistent WebSocket support (Render / Railway / Fly /
 * a VPS). It does NOT run on Vercel's serverless functions.
 * ==========================================================================*/
"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const express = require("express");
const compression = require("compression");
const { WebSocketServer } = require("ws");
const { ExpressPeerServer } = require("peer");
let webpush = null; try { webpush = require("web-push"); } catch (e) { /* optional */ }
const store = require("./store");   // optional SQLite persistence (degrades gracefully)

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_URLS_RAW = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TURN_URLS = TURN_URLS_RAW.filter(u => /^(turns?|stun):/i.test(u));
const TURN_TTL = parseInt(process.env.TURN_TTL || "3600", 10);
const MAX_ROOM = parseInt(process.env.MAX_ROOM || "8", 10);
// Test phase: everything that normally sits behind the paywall (wall expiry → Stripe extension)
// stays free until PAYWALL=on is set in the environment. Rooms/walls are not pruned while free.
const PAYWALL_ON = (process.env.PAYWALL || "off") === "on";
const CHAT_KEEP = parseInt(process.env.CHAT_KEEP || "300", 10);
const YT_API_KEY = process.env.YT_API_KEY || "";   // YouTube Data API v3 key — stays server-side, never sent to the browser
const TURN_USERNAME = process.env.TURN_USERNAME || "";     // static TURN username (managed providers, e.g. Metered/Twilio)
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || ""; // static TURN credential/password
// Optional SECOND TURN provider (reserve, on a DIFFERENT IP/host). A single TURN server can't relay between two of
// its own relay addresses, so two relay-only peers (e.g. both behind a VPN / symmetric NAT) fail. A reserve relay on
// a different IP gives ICE a working relay↔relay pair. Same config shapes as the primary (static creds or HMAC secret).
const TURN2_SECRET = process.env.TURN2_SECRET || "";
const TURN2_URLS = (process.env.TURN2_URLS || "").split(",").map(s => s.trim()).filter(u => /^(turns?|stun):/i.test(u));
const TURN2_USERNAME = process.env.TURN2_USERNAME || "";
const TURN2_CREDENTIAL = process.env.TURN2_CREDENTIAL || "";
const TURN2_TTL = parseInt(process.env.TURN2_TTL || "3600", 10);
const HAS_TURN = !!((TURN_URLS.length && (TURN_SECRET || (TURN_USERNAME && TURN_CREDENTIAL))) ||
                    (TURN2_URLS.length && (TURN2_SECRET || (TURN2_USERNAME && TURN2_CREDENTIAL))));

/* ---- low-CPU MKV and opaque video-link streaming ----
   Browsers do not consistently understand the Matroska container. A short-lived,
   signed stream URL feeds a validated remote source into FFmpeg, copies the video
   packets unchanged into fragmented MP4, and only converts audio to AAC when the
   compatibility-first default is active. No video frames are decoded or encoded. */
const MKV_TOKEN_TTL = Math.max(30, parseInt(process.env.MKV_TOKEN_TTL || "300", 10));
const MKV_TOKEN_SECRET = process.env.MKV_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const MKV_ALLOWED_HOSTS = (process.env.MKV_ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MKV_TRUSTED_PRIVATE_HOSTS = (process.env.MKV_TRUSTED_PRIVATE_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MKV_ALLOWED_PORTS = new Set((process.env.MKV_ALLOWED_PORTS || "80,443,8080,8443").split(",").map(s => s.trim()).filter(Boolean));
const MKV_ALLOW_PRIVATE = process.env.MKV_ALLOW_PRIVATE === "1";
const MKV_MAX_STREAMS = Math.max(1, parseInt(process.env.MKV_MAX_STREAMS || "4", 10));
const MKV_MAX_STREAMS_PER_IP = Math.max(1, parseInt(process.env.MKV_MAX_STREAMS_PER_IP || "2", 10));
/* Video transcoding is the expensive last resort for HEVC/H.265. Keep it much tighter than
   the audio-only remux pool so one difficult channel cannot starve calls or the room server. */
const MKV_MAX_TRANSCODES = Math.max(1, parseInt(process.env.MKV_MAX_TRANSCODES || "1", 10));
const MKV_MAX_TRANSCODES_PER_IP = Math.max(1, parseInt(process.env.MKV_MAX_TRANSCODES_PER_IP || "1", 10));
const MKV_TRANSCODE_THREADS = Math.max(1, Math.min(4, parseInt(process.env.MKV_TRANSCODE_THREADS || "1", 10)));
const MKV_COPY_AUDIO = process.env.MKV_COPY_AUDIO === "1";
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require("ffmpeg-static"); } catch (_) { return "ffmpeg"; }
}
const FFMPEG_PATH = resolveFfmpeg();
const ffmpegProbe = spawnSync(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
const HAS_FFMPEG = !ffmpegProbe.error && ffmpegProbe.status === 0;

/* ---- rate limiting (lightweight, in-memory; tune via env, all per-IP unless noted) ----
   Defaults are deliberately generous so shared/CGNAT mobile IPs (common in expat
   markets) aren't blocked; tighten via env only if you see abuse. */
const RL_HTTP_MAX        = parseInt(process.env.RL_HTTP_MAX        || "120", 10);    // HTTP hits per window
const RL_HTTP_WINDOW     = parseInt(process.env.RL_HTTP_WINDOW     || "60000", 10);  // window (ms)
const RL_CONN_MAX        = parseInt(process.env.RL_CONN_MAX        || "60", 10);     // new /rt sockets per window
const RL_CONN_WINDOW     = parseInt(process.env.RL_CONN_WINDOW     || "60000", 10);
const RL_CONN_CONCURRENT = parseInt(process.env.RL_CONN_CONCURRENT || "40", 10);     // concurrent /rt sockets (high: mobile carriers share IPs)
const RL_MSG_MAX         = parseInt(process.env.RL_MSG_MAX         || "60", 10);     // messages per CONNECTION per window
const RL_MSG_WINDOW      = parseInt(process.env.RL_MSG_WINDOW      || "10000", 10);
const RL_CHAT_MAX        = parseInt(process.env.RL_CHAT_MAX        || "12", 10);     // chat messages per CONNECTION per window
const RL_CHAT_WINDOW     = parseInt(process.env.RL_CHAT_WINDOW     || "10000", 10);

/* ---- Web Push (scheduled watch-party reminders) ---- */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@samecouch.com";
const HAS_PUSH = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
if (HAS_PUSH) { try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) { console.warn("[WARN] VAPID setup failed:", e.message); } }
else console.warn("[WARN] Web Push disabled (set VAPID_PUBLIC + VAPID_PRIVATE; generate with: npx web-push generate-vapid-keys). Calendar reminders still work.");
// In-memory fallback; the normal path persists reminders through server restarts.
const reminders = [];   // { id, sub, at, title, body, url, sent }
const MAX_REMINDERS = parseInt(process.env.MAX_REMINDERS || "5000", 10);
const REMINDER_MAX_AHEAD = parseInt(process.env.REMINDER_MAX_AHEAD || String(31 * 24 * 3600 * 1000), 10);

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD not set — the admin dashboard will refuse logins.");
if (TURN_URLS_RAW.length && TURN_URLS.length < TURN_URLS_RAW.length) {
  console.warn("[WARN] TURN_URLS has entries that are not turn:/turns:/stun: URLs and were ignored:",
    TURN_URLS_RAW.filter(u => !/^(turns?|stun):/i.test(u)));
}
if (!HAS_TURN) console.warn("[WARN] No usable TURN (need TURN_URLS plus either TURN_SECRET or TURN_USERNAME+TURN_CREDENTIAL) — only public STUN offered; cross-network calls may fail.");
if (!HAS_FFMPEG) console.warn("[WARN] MKV streaming disabled — install ffmpeg-static or set FFMPEG_PATH to a working FFmpeg binary.");

const app = express();
app.disable("x-powered-by");
// Compress text assets and JSON when this process serves the frontend directly.
// The opt-in speed test stays uncompressed or its Mbps estimate would be false.
app.use(compression({ filter: (req, res) => req.path !== "/speed-test" && compression.filter(req, res) }));

/* ---- security headers (applied to every response) ----
   Legacy content pages still contain inline JSON-LD/styles. The room entrypoint
   has external JavaScript and receives the stricter CSP_APP policy below. */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com https://player.vimeo.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: mediastream: https:",
  "connect-src 'self' https://watchmovietogether-j59u.onrender.com wss://watchmovietogether-j59u.onrender.com",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");
const CSP_APP = CSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'");
app.use((req, res, next) => {
  const requestHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0].toLowerCase();
  if (requestHost === "www.samecouch.com") return res.redirect(308, "https://samecouch.com" + req.originalUrl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), screen-wake-lock=(self), geolocation=(), browsing-topics=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if ((req.headers["x-forwarded-proto"] || req.protocol) === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Full CSP only for top-level documents — API responses are JSON and don't need it.
  if (req.method === "GET" && (req.headers.accept || "").indexOf("text/html") !== -1)
    res.setHeader("Content-Security-Policy", (req.path === "/" || req.path === "/index.html") ? CSP_APP : CSP);
  if (req.method !== "OPTIONS" && req.path !== "/healthz") recordVisit(clientIp(req));   // count unique visitors per day
  next();
});

const jsonSmall = express.json({ limit: "16kb" });   // most POSTs are tiny
const jsonWall = express.json({ limit: "8mb" });     // wall photos + voice/video messages (client-side capped)
app.use((req, res, next) => (req.path === "/wall" ? jsonWall : jsonSmall)(req, res, next));
const server = http.createServer(app);

/* ---- small CORS for the public GET endpoints (front-end may be on another origin) ---- */
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ---- tiny in-memory rate limiter (fixed window) ----
   Per-process only — fine for a single instance. If you ever run multiple
   instances, move these counters to Redis (and add sticky sessions). */
function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();   // Render/Cloudflare put the real IP here
  return xff || (req.socket && req.socket.remoteAddress) || "?";
}
function makeLimiter(max, windowMs) {
  const hits = new Map();   // key -> { n, reset }
  const t = setInterval(() => {
    const now = Date.now();
    hits.forEach((e, k) => { if (now >= e.reset) hits.delete(k); });   // keep the map bounded
  }, windowMs);
  if (t.unref) t.unref();
  return function allow(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now >= e.reset) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    e.n++;
    return e.n <= max;
  };
}
const httpLimiter = makeLimiter(RL_HTTP_MAX, RL_HTTP_WINDOW);
const connLimiter = makeLimiter(RL_CONN_MAX, RL_CONN_WINDOW);
const wallWriteLimiter = makeLimiter(25, 10 * 60 * 1000);   // wall posts/deletes: 25 per 10 min per IP (anti-spam, anti-DB-bloat)
const ipConns = new Map();   // ip -> live /rt socket count (concurrency cap)
function tooMany(res) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "rate_limited" }); }

/* ---- safe remote-video validation + signed stream tickets ---- */
const mkvPrepareLimiter = makeLimiter(30, 10 * 60 * 1000);
const speedTestLimiter = makeLimiter(12, 10 * 60 * 1000);   // explicit user-triggered preflight only
let activeMkvStreams = 0;
const activeMkvByIp = new Map();
let activeMkvTranscodes = 0;
const activeMkvTranscodesByIp = new Map();
function mkvError(code, status, message) {
  const error = new Error(message || code); error.code = code; error.status = status; return error;
}
function hostMatchesRules(host, rules) {
  host = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return rules.some(rule => {
    if (rule === host) return true;
    if (!rule.startsWith("*.")) return false;
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && host !== suffix.slice(1);
  });
}
function hostMatchesAllowlist(host) { return !MKV_ALLOWED_HOSTS.length || hostMatchesRules(host, MKV_ALLOWED_HOSTS); }
function explicitlyAllowedHost(host) { return MKV_ALLOWED_HOSTS.length > 0 && hostMatchesAllowlist(host); }
function trustedPrivateHost(host) { return MKV_TRUSTED_PRIVATE_HOSTS.includes(String(host || "").replace(/^\[|\]$/g, "").toLowerCase()); }
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
async function validateMkvTarget(raw) {
  raw = String(raw || "");
  if (!raw || raw.length > 2200) throw mkvError("bad_url", 400);
  let url; try { url = new URL(raw); } catch (_) { throw mkvError("bad_url", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw mkvError("bad_scheme", 400);
  if (url.username || url.password) throw mkvError("auth_not_allowed", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostMatchesAllowlist(host)) throw mkvError("host_not_allowed", 403);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!MKV_ALLOWED_PORTS.has(String(port))) throw mkvError("port_not_allowed", 403);
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (_) { throw mkvError("dns_failed", 502); }
  if (!addresses.length) throw mkvError("dns_failed", 502);
  const unsafe = addresses.filter(entry => blockedIp(entry.address));
  if (unsafe.length && !trustedPrivateHost(host) && !(MKV_ALLOW_PRIVATE && explicitlyAllowedHost(host))) throw mkvError("private_address", 403);
  return { url, address: addresses[0].address, family: addresses[0].family };
}
async function openMkvSource(raw, redirects) {
  redirects = redirects || 0;
  if (redirects > 3) throw mkvError("too_many_redirects", 502);
  const target = await validateMkvTarget(raw);
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(target.url, {
      headers: { "User-Agent": "SameCouch-Video/1.0", Accept: "video/x-matroska,video/*;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        if (options && options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        const next = new URL(response.headers.location, target.url).toString(); response.resume(); resolve(openMkvSource(next, redirects + 1)); return;
      }
      if (status < 200 || status >= 300) { response.resume(); reject(mkvError("upstream_" + status, 502)); return; }
      resolve(response);
    });
    req.setTimeout(30000, () => req.destroy(mkvError("upstream_timeout", 504)));
    req.once("error", error => reject(error && error.code ? error : mkvError("upstream_failed", 502)));
  });
}
function makeMkvToken(url, options) {
  const video = options && options.video === "h264" ? "h264" : "copy";
  const payload = Buffer.from(JSON.stringify({ url, video, exp: Math.floor(Date.now() / 1000) + MKV_TOKEN_TTL })).toString("base64url");
  const signature = crypto.createHmac("sha256", MKV_TOKEN_SECRET).update(payload).digest("base64url");
  return payload + "." + signature;
}
function readMkvToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw mkvError("bad_token", 403);
  const expected = crypto.createHmac("sha256", MKV_TOKEN_SECRET).update(parts[0]).digest();
  let supplied; try { supplied = Buffer.from(parts[1], "base64url"); } catch (_) { throw mkvError("bad_token", 403); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw mkvError("bad_token", 403);
  let payload; try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (_) { throw mkvError("bad_token", 403); }
  if (!payload || typeof payload.url !== "string" || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw mkvError("expired_token", 403);
  return { url: payload.url, video: payload.video === "h264" ? "h264" : "copy" };
}
function acquireMkvSlot(ip) {
  const byIp = activeMkvByIp.get(ip) || 0;
  if (activeMkvStreams >= MKV_MAX_STREAMS || byIp >= MKV_MAX_STREAMS_PER_IP) return false;
  activeMkvStreams++; activeMkvByIp.set(ip, byIp + 1); return true;
}
function releaseMkvSlot(ip) {
  activeMkvStreams = Math.max(0, activeMkvStreams - 1);
  const left = Math.max(0, (activeMkvByIp.get(ip) || 1) - 1);
  if (left) activeMkvByIp.set(ip, left); else activeMkvByIp.delete(ip);
}
function acquireMkvTranscodeSlot(ip) {
  const byIp = activeMkvTranscodesByIp.get(ip) || 0;
  if (activeMkvTranscodes >= MKV_MAX_TRANSCODES || byIp >= MKV_MAX_TRANSCODES_PER_IP) return false;
  activeMkvTranscodes++; activeMkvTranscodesByIp.set(ip, byIp + 1); return true;
}
function releaseMkvTranscodeSlot(ip) {
  activeMkvTranscodes = Math.max(0, activeMkvTranscodes - 1);
  const left = Math.max(0, (activeMkvTranscodesByIp.get(ip) || 1) - 1);
  if (left) activeMkvTranscodesByIp.set(ip, left); else activeMkvTranscodesByIp.delete(ip);
}

/* ---- daily unique visitors (counted per IP; we only ever store a salted hash, never the raw IP) ---- */
const VISIT_SALT = process.env.VISIT_SALT || ADMIN_PASSWORD || "samecouch-visit";
const dailyVisitors = new Map();   // "YYYY-MM-DD" -> Set(ipHash)   (in-memory mirror; DB is the durable source)
let visitDay = "";
function todayStr() { return new Date().toISOString().slice(0, 10); }
function hashIp(ip, day) { return crypto.createHmac("sha256", VISIT_SALT).update(ip + "|" + day).digest("hex").slice(0, 32); }
function recordVisit(ip) {
  if (!ip || ip === "?") return;
  const day = todayStr();
  if (day !== visitDay) {                       // new day → keep the in-memory map bounded and prune very old rows
    visitDay = day;
    if (dailyVisitors.size > 40) { const keep = new Set([...dailyVisitors.keys()].sort().slice(-35)); dailyVisitors.forEach((v, k) => { if (!keep.has(k)) dailyVisitors.delete(k); }); }
    store.pruneVisits(new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10));
  }
  const h = hashIp(ip, day);
  let set = dailyVisitors.get(day); if (!set) { set = new Set(); dailyVisitors.set(day, set); }
  if (!set.has(h)) { set.add(h); store.recordVisit(day, h); }   // first time we've seen this IP today → persist once
}
async function visitorsReport(limit) {
  if (store.enabled()) { const rows = await store.visitorDays(limit || 30); if (rows && rows.length) return rows; }
  const arr = []; dailyVisitors.forEach((set, day) => arr.push({ day, count: set.size }));
  arr.sort((a, b) => (a.day < b.day ? 1 : -1));
  return arr.slice(0, limit || 30);
}

/* ---- short-lived TURN credentials (coturn "use-auth-secret" REST scheme) ---- */
// Build one TURN ICE entry: static username+credential (managed providers), or a short-lived HMAC
// credential for your own coturn ("use-auth-secret"). Returns null when this provider isn't configured.
function turnEntry(urls, secret, ttl, user, cred) {
  if (!urls.length) return null;
  if (user && cred) return { urls, username: user, credential: cred };
  if (secret) {
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = expiry + ":" + crypto.randomBytes(6).toString("hex");
    const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
    return { urls, username, credential };
  }
  return null;
}
function makeTurnCredentials() {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  const primary = turnEntry(TURN_URLS, TURN_SECRET, TURN_TTL, TURN_USERNAME, TURN_CREDENTIAL);
  if (primary) servers.push(primary);
  const reserve = turnEntry(TURN2_URLS, TURN2_SECRET, TURN2_TTL, TURN2_USERNAME, TURN2_CREDENTIAL);   // 2nd relay on a different IP
  if (reserve) servers.push(reserve);
  return servers;
}

app.get("/turn-credentials", (req, res) => {
  cors(req, res);
  if (!httpLimiter(clientIp(req))) return tooMany(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers: makeTurnCredentials(), ttl: TURN_TTL });
});

app.get("/config", (req, res) => {
  cors(req, res);
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
  res.json({
    peerHost: host,
    peerPort: secure ? 443 : (parseInt((req.headers.host || "").split(":")[1], 10) || PORT),
    peerPath: "/peerjs",
    peerSecure: secure,
    maxRoom: MAX_ROOM,
    hasTurn: HAS_TURN,
    hasYouTube: !!YT_API_KEY,
    hasMkv: HAS_FFMPEG,
    hasIptv: true,
    mkvMode: MKV_COPY_AUDIO ? "remux-copy" : "remux-aac",
    hasPush: HAS_PUSH,
    vapidPublic: HAS_PUSH ? VAPID_PUBLIC : "",
    hasWall: store.enabled(),
    freeDays: store.freeDays(),
    stripeLink: process.env.STRIPE_LINK || ""
  });
});

/* Small, bounded transfer used by the opt-in connection check. It never inspects
   the bytes and is deliberately capped so it cannot become a generic upload route. */
const speedRaw = express.raw({ type: "application/octet-stream", limit: "384kb" });
app.options("/speed-test", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.sendStatus(204); });
app.get("/speed-test", (req, res) => {
  cors(req, res); res.setHeader("Cache-Control", "no-store"); res.setHeader("Timing-Allow-Origin", "*");
  if (!speedTestLimiter(clientIp(req))) return tooMany(res);
  const bytes = Math.max(32 * 1024, Math.min(256 * 1024, parseInt(req.query.bytes || String(256 * 1024), 10) || 0));
  res.type("application/octet-stream").send(Buffer.alloc(bytes, 0x53));
});
app.post("/speed-test", speedRaw, (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.setHeader("Cache-Control", "no-store");
  if (!speedTestLimiter(clientIp(req))) return tooMany(res);
  const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
  if (bytes < 1024 || bytes > 384 * 1024) return res.status(400).json({ error: "bad_size" });
  res.json({ ok: true, bytes });
});

/* Broad by default: any public HTTP(S) video host is accepted, including
   redirects and opaque/signed download URLs. MKV_ALLOWED_HOSTS is opt-in. */
app.get("/mkv-prepare", async (req, res) => {
  cors(req, res); res.setHeader("Cache-Control", "no-store");
  if (!HAS_FFMPEG) return res.status(503).json({ error: "mkv_unavailable" });
  const ip = clientIp(req); if (!mkvPrepareLimiter(ip)) return tooMany(res);
  try {
    const target = await validateMkvTarget(req.query.url);
    const token = makeMkvToken(target.url.toString());
    res.json({ streamPath: "/mkv-stream?token=" + encodeURIComponent(token), expiresIn: MKV_TOKEN_TTL });
  } catch (error) { res.status(error.status || 502).json({ error: error.code || "mkv_source_failed" }); }
});

/* Assigned after the realtime room helpers are initialized. The route handlers run later, so
   IPTV remux tickets can be resolved directly in-process instead of hairpinning through the
   public SameCouch domain (which was slow and unreliable on a single VPS instance). */
let iptvService = null;
const activeSharedTranscodes = new Map();
const MKV_SHARED_BACKLOG = Math.max(1024 * 1024, parseInt(process.env.MKV_SHARED_BACKLOG || String(8 * 1024 * 1024), 10));

function mkvFfmpegArgs(transcodeVideo, inputUrl) {
  const audioArgs = MKV_COPY_AUDIO
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-af", "aresample=async=1000:first_pts=0"];
  const videoArgs = transcodeVideo
    ? ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "25", "-pix_fmt", "yuv420p", "-vf", "scale=w=-2:h=min(720\\,ih)", "-threads", String(MKV_TRANSCODE_THREADS), "-g", "60", "-keyint_min", "30", "-sc_threshold", "0"]
    : ["-c:v", "copy"];
  const input = inputUrl || "pipe:0";
  const inputArgs = input === "pipe:0"
    ? ["-i", input]
    : ["-rw_timeout", "35000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "2", "-i", input];
  return [
    "-hide_banner", "-loglevel", "warning", "-fflags", "+genpts",
    "-probesize", "5M", "-analyzeduration", "5000000", ...inputArgs,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn",
    ...videoArgs, ...audioArgs,
    "-max_muxing_queue_size", "1024", "-avoid_negative_ts", "make_zero",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000",
    "-f", "mp4", "pipe:1"
  ];
}
async function prepareMkvInput(streamTicket) {
  if (streamTicket.url.startsWith("iptv:")) {
    if (!iptvService) throw mkvError("iptv_unavailable", 503);
    return { url: iptvService.remuxInputUrl(streamTicket.url.slice(5)), source: null };
  }
  return { url: "pipe:0", source: await openMkvSource(streamTicket.url) };
}
function setMkvStreamHeaders(res) {
  res.status(200); res.setHeader("Content-Type", "video/mp4"); res.setHeader("Content-Disposition", "inline; filename=\"samecouch-stream.mp4\""); res.setHeader("Accept-Ranges", "none");
}

function createSharedTranscode(key, streamTicket, ip) {
  let readyResolve;
  const state = { key, clients: new Set(), backlog: [], backlogBytes: 0, overflow: false, done: false, error: null, source: null, ffmpeg: null, stderr: "", ready: new Promise(resolve => { readyResolve = resolve; }), readyResolve, released: false, mkvSlot: false, transcodeSlot: false };
  activeSharedTranscodes.set(key, state);
  const release = () => {
    if (state.released) return; state.released = true; if (state.mkvSlot) releaseMkvSlot(ip); if (state.transcodeSlot) releaseMkvTranscodeSlot(ip);
  };
  const fail = (code, status) => {
    if (state.done) return; state.error = { code, status }; state.done = true; state.readyResolve();
    state.clients.forEach(client => { if (!client.headersSent) client.status(status).json({ error: code }); else if (!client.writableEnded) client.end(); });
    state.clients.clear(); activeSharedTranscodes.delete(key); release();
  };
  if (!acquireMkvSlot(ip)) { fail("mkv_busy", 503); return state; }
  state.mkvSlot = true;
  if (!acquireMkvTranscodeSlot(ip)) { fail("mkv_transcode_busy", 503); return state; }
  state.transcodeSlot = true;
  (async () => {
    let input;
    try { input = await prepareMkvInput(streamTicket); state.source = input.source; }
    catch (error) { fail(error.code || "mkv_source_failed", error.status || 502); return; }
    state.ffmpeg = spawn(FFMPEG_PATH, mkvFfmpegArgs(true, input.url), { stdio: [state.source ? "pipe" : "ignore", "pipe", "pipe"] });
    state.ffmpeg.stderr.on("data", chunk => { state.stderr = (state.stderr + String(chunk)).slice(-8000); });
    if (state.ffmpeg.stdin) state.ffmpeg.stdin.on("error", () => {});
    if (state.source) state.source.once("error", () => { if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill("SIGKILL"); });
    state.ffmpeg.once("error", () => fail("mkv_remux_failed", 502));
    state.ffmpeg.stdout.on("data", chunk => {
      if (!state.overflow && state.backlogBytes + chunk.length <= MKV_SHARED_BACKLOG) { state.backlog.push(chunk); state.backlogBytes += chunk.length; }
      else state.overflow = true;
      state.clients.forEach(client => {
        if (client.destroyed || client.writableEnded) { state.clients.delete(client); return; }
        if (client.writableLength > 4 * 1024 * 1024) { client.destroy(); state.clients.delete(client); return; }
        client.write(chunk);
      });
    });
    state.ffmpeg.once("close", code => {
      if (state.done) return;
      state.done = true; state.clients.forEach(client => { if (!client.writableEnded) client.end(); }); state.clients.clear(); activeSharedTranscodes.delete(key); release();
      if (code !== 0 && state.stderr) console.warn("[MKV] shared H.264 transcode stopped:", state.stderr.replace(/https?:\/\/\S+/g, "[source]").slice(-1000));
    });
    state.readyResolve(); if (state.source) state.source.pipe(state.ffmpeg.stdin);
  })();
  return state;
}

async function attachSharedTranscode(state, res) {
  await state.ready;
  if (state.error) { if (!res.headersSent) res.status(state.error.status).json({ error: state.error.code }); return; }
  if (state.overflow) { res.setHeader("Retry-After", "20"); res.status(503).json({ error: "mkv_transcode_busy" }); return; }
  setMkvStreamHeaders(res);
  state.backlog.forEach(chunk => res.write(chunk));
  if (state.done) { res.end(); return; }
  state.clients.add(res);
  res.once("close", () => {
    state.clients.delete(res);
    if (!state.done && !state.clients.size) setTimeout(() => {
      if (state.done || state.clients.size) return;
      if (state.source && !state.source.destroyed) state.source.destroy();
      if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill("SIGKILL");
    }, 1500);
  });
}

app.get("/mkv-stream", async (req, res) => {
  cors(req, res); res.setHeader("Cache-Control", "no-store"); res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!HAS_FFMPEG) return res.status(503).json({ error: "mkv_unavailable" });
  let streamTicket;
  try { streamTicket = readMkvToken(req.query.token); }
  catch (error) { return res.status(error.status || 403).json({ error: error.code || "bad_token" }); }
  const ip = clientIp(req);
  const sharedKey = streamTicket.video === "h264" && streamTicket.url.startsWith("iptv:") ? streamTicket.url : "";
  if (sharedKey) {
    const state = activeSharedTranscodes.get(sharedKey) || createSharedTranscode(sharedKey, streamTicket, ip);
    return attachSharedTranscode(state, res);
  }
  if (!acquireMkvSlot(ip)) { res.setHeader("Retry-After", "20"); return res.status(503).json({ error: "mkv_busy" }); }
  const transcodeVideo = streamTicket.video === "h264";
  if (transcodeVideo && !acquireMkvTranscodeSlot(ip)) {
    releaseMkvSlot(ip); res.setHeader("Retry-After", "20"); return res.status(503).json({ error: "mkv_transcode_busy" });
  }

  let source = null, ffmpeg = null, released = false, finished = false;
  function release() { if (!released) { released = true; releaseMkvSlot(ip); if (transcodeVideo) releaseMkvTranscodeSlot(ip); } }
  function stop() { if (source && !source.destroyed) source.destroy(); if (ffmpeg && !ffmpeg.killed) { try { ffmpeg.kill("SIGKILL"); } catch (_) {} } release(); }
  res.once("finish", () => { finished = true; release(); });
  res.once("close", () => { if (!finished) stop(); });
  let input;
  try { input = await prepareMkvInput(streamTicket); source = input.source; }
  catch (error) { release(); return res.status(error.status || 502).json({ error: error.code || "mkv_source_failed" }); }
  if (res.destroyed) { stop(); return; }

  const ffmpegArgs = mkvFfmpegArgs(transcodeVideo, input.url);
  ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: [source ? "pipe" : "ignore", "pipe", "pipe"] });
  let ffmpegError = "";
  ffmpeg.stderr.on("data", chunk => { ffmpegError = (ffmpegError + String(chunk)).slice(-8000); });
  if (ffmpeg.stdin) ffmpeg.stdin.on("error", () => {});
  if (source) source.once("error", () => { if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL"); });
  ffmpeg.once("error", () => { if (!res.headersSent) res.status(502).json({ error: "mkv_remux_failed" }); else if (!res.writableEnded) res.end(); stop(); });
  ffmpeg.once("close", code => {
    if (code !== 0 && !res.headersSent) res.status(422).json({ error: "mkv_decode_failed" }); else if (!res.writableEnded) res.end();
    if (code !== 0 && ffmpegError) console.warn("[MKV] FFmpeg stopped:", ffmpegError.replace(/https?:\/\/\S+/g, "[source]").slice(-1000));
    release();
  });
  setMkvStreamHeaders(res);
  if (source) source.pipe(ffmpeg.stdin); ffmpeg.stdout.pipe(res);
});

/* ---- embeddability probe ----
   The room loads arbitrary "video page" links into an iframe. The browser cannot tell the page
   WHY such a frame fails (cross-origin): sites that send X-Frame-Options / frame-ancestors — or
   that redirect to one that does, e.g. youtube.com — only show a browser error page. The front-end
   asks us to follow the link server-side (same SSRF guards as the MKV path) so it can switch to
   the real player, or explain the failure, instead of leaving a dead frame. */
const embedCheckLimiter = makeLimiter(40, 10 * 60 * 1000);
function frameBlockingHeaders(headers) {
  const xfo = String(headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return true;
  const csp = String(headers["content-security-policy"] || "");
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m && !/(^|\s)(\*|https?:)(\s|$)/.test(m[1].trim().toLowerCase())) return true;   // only wildcard policies can frame us
  return false;
}
/* Mirror of the front-end's link detection. Once a redirect lands on something the room can play
   itself, stop and report that URL: fetching it adds nothing, and YouTube answers datacenter IPs
   (Render) with a "sorry" CAPTCHA page, which would otherwise hide the real destination. */
function playableVideoUrl(raw) {
  let u; try { u = new URL(raw); } catch (_) { return false; }
  const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") return true;
  if (host === "vimeo.com" || host === "player.vimeo.com") return true;
  return /\.(mp4|webm|ogg|ogv|m4v|mov|mkv)(?:$|[?#])/i.test(u.pathname);
}
/* if we still ended up on a Google interstitial ("sorry"/captcha, or a /url wrapper), the real target is in the query */
function unwrapGoogleInterstitial(raw) {
  try {
    const u = new URL(raw), host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "google.com" || /\.google\.com$/.test(host)) {
      const target = u.searchParams.get("continue") || u.searchParams.get("url") || u.searchParams.get("q");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch (_) {}
  return raw;
}
function htmlRedirectTarget(body, baseUrl) {
  let m = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?[^"'>]*url\s*=\s*([^"'>\s]+)/i);
  if (!m) m = body.match(/(?:location\.href|location\.replace\(|window\.location(?:\.href)?)\s*[=(]\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) return "";
  try { return new URL(m[1].replace(/&amp;/g, "&"), baseUrl).toString(); } catch (_) { return ""; }
}
function fetchEmbedHead(raw, hops) {
  hops = hops || 0;
  if (hops > 4) return Promise.reject(mkvError("too_many_redirects", 502));
  return validateMkvTarget(raw).then(target => new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.get(target.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SameCouch-EmbedCheck/1.0)", Accept: "text/html,application/xhtml+xml,*/*;q=0.5", "Accept-Encoding": "identity", "Accept-Language": "en" },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        if (options && options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        const next = new URL(response.headers.location, target.url).toString();
        response.resume();
        if (playableVideoUrl(next)) { resolve({ finalUrl: next, status, blocked: false }); return; }   // wrapper → real video: done, the room plays it natively
        resolve(fetchEmbedHead(next, hops + 1));
        return;
      }
      const blocked = frameBlockingHeaders(response.headers);
      const type = String(response.headers["content-type"] || "").toLowerCase();
      const summary = { finalUrl: target.url.toString(), status, blocked };
      if (!blocked && status < 400 && type.includes("text/html")) {
        /* page loads fine per its headers — still sniff a client-side redirect (meta refresh / location.href) */
        let body = "", done = false, timer = null;
        const finish = () => {
          if (done) return; done = true; clearTimeout(timer); response.destroy();
          const jump = htmlRedirectTarget(body, target.url);
          if (jump && playableVideoUrl(jump)) resolve({ finalUrl: jump, status, blocked: false });
          else if (jump && jump !== summary.finalUrl) resolve(fetchEmbedHead(jump, hops + 1).catch(() => summary));
          else resolve(summary);
        };
        response.on("data", chunk => { body += String(chunk); if (body.length > 96 * 1024) finish(); });
        response.once("end", finish); response.once("error", finish);
        timer = setTimeout(finish, 4000);
      } else {
        response.resume(); response.destroy();
        resolve(summary);
      }
    });
    req.setTimeout(10000, () => req.destroy(mkvError("upstream_timeout", 504)));
    req.once("error", error => reject(error && error.code ? error : mkvError("upstream_failed", 502)));
  }));
}
app.get("/embed-check", async (req, res) => {
  cors(req, res); res.setHeader("Cache-Control", "no-store");
  const ip = clientIp(req); if (!embedCheckLimiter(ip)) return tooMany(res);
  try {
    const out = await fetchEmbedHead(req.query.url);
    const finalUrl = unwrapGoogleInterstitial(out.finalUrl);
    res.json({ ok: true, finalUrl, status: out.status, blocked: finalUrl === out.finalUrl && !!out.blocked });
  } catch (error) { res.json({ ok: false, error: (error && error.code) || "probe_failed" }); }
});

/* ---- Web Push subscribe: store a reminder to fire at a scheduled time ---- */
app.options("/push-subscribe", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS"); res.sendStatus(204); });
app.post("/push-subscribe", async (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (!httpLimiter(clientIp(req))) return tooMany(res);
  if (!HAS_PUSH) return res.status(503).json({ error: "push_disabled" });
  const b = req.body || {};
  const sub = b.subscription;
  const at = parseInt(b.at, 10);
  if (!sub || !sub.endpoint || !at) return res.status(400).json({ error: "bad_request" });
  if (at < Date.now() - 60000 || at > Date.now() + REMINDER_MAX_AHEAD) return res.status(400).json({ error: "bad_time" });
  const reminder = {
    id: "pr" + crypto.randomBytes(10).toString("hex"),
    sub,
    at,
    title: String(b.title || "SameCouch").slice(0, 80),
    body: String(b.body || "").slice(0, 140),
    url: String(b.url || "/").slice(0, 400),
    sent: false
  };
  const persisted = await store.addReminder(reminder);
  if (!persisted) { if (reminders.length >= MAX_REMINDERS) reminders.shift(); reminders.push(reminder); }
  res.json({ ok: true });
});

/* ---- "Tell me when the room comes alive": store a push sub per room, fire when an empty room gets its first arrival ---- */
const roomSubs = new Map();        // roomCode -> Map(endpoint -> { sub, name })
const roomNotifiedAt = new Map();  // roomCode -> ts (cooldown so we don't spam)
const MAX_ROOMSUBS = parseInt(process.env.MAX_ROOMSUBS || "20000", 10);
let roomSubCount = 0;
app.options("/room-notify", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS"); res.sendStatus(204); });
app.post("/room-notify", async (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (!httpLimiter(clientIp(req))) return tooMany(res);
  if (!HAS_PUSH) return res.status(503).json({ error: "push_disabled" });
  const b = req.body || {};
  const sub = b.subscription, room = String(b.room || "").slice(0, 80);
  if (!sub || !sub.endpoint || !room) return res.status(400).json({ error: "bad_request" });
  if (roomSubCount >= MAX_ROOMSUBS) return res.status(503).json({ error: "busy" });
  let m = roomSubs.get(room); if (!m) { m = new Map(); roomSubs.set(room, m); }
  if (!m.has(sub.endpoint)) roomSubCount++;
  m.set(sub.endpoint, { sub, name: String(b.name || "Someone").slice(0, 40) });
  await store.addRoomSub(room, String(sub.endpoint).slice(0, 1000), sub, String(b.name || "Someone").slice(0, 40));
  res.json({ ok: true });
});
async function notifyRoomAlive(room, arriverName) {
  if (!HAS_PUSH) return;
  let m = roomSubs.get(room); if (!m) { m = new Map(); roomSubs.set(room, m); }
  const stored = await store.getRoomSubs(room);
  stored.forEach(v => { if (v && v.endpoint && !m.has(v.endpoint)) m.set(v.endpoint, { sub: v.sub, name: v.name }); });
  if (!m.size) return;
  const last = roomNotifiedAt.get(room) || 0;
  if (Date.now() - last < 60000) return;   // at most once a minute per room
  roomNotifiedAt.set(room, Date.now());
  const url = "/?room=" + encodeURIComponent(room);
  const payload = JSON.stringify({ title: "Your living room is live 🛋️", body: (arriverName || "Someone") + " just arrived — come hang out", url, tag: "wmt-room-" + room });
  m.forEach((v, endpoint) => {
    webpush.sendNotification(v.sub, payload).catch(() => { m.delete(endpoint); roomSubCount=Math.max(0,roomSubCount-1); store.delRoomSub(room, endpoint); });   // drop dead subs
  });
}

/* ---- Persistent wall: notes & photos that stay between sessions (the "living room" memory) ---- */
app.options("/wall", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.sendStatus(204); });
/* Wall access control: for PASSWORD-LOCKED rooms the wall is only reachable with a membership token
   that the server hands out on a successful (password-checked) join — guessing a room code is not enough. */
const WALL_TOKEN_SECRET = crypto.randomBytes(32);
function wallTokenFor(room) { return crypto.createHmac("sha256", WALL_TOKEN_SECRET).update("wall|" + room).digest("hex").slice(0, 32); }
async function wallLocked(room) {
  const live = rooms.get(room);
  if (live && (live.pass || live._loadP)) { try { await live._loadP; } catch (e) {} return !!live.pass; }
  const row = await store.getRoom(room).catch(() => null);
  return !!(row && row.passHash);
}
function sha256hex(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

app.get("/wall", async (req, res) => {
  cors(req, res);
  if (!httpLimiter(clientIp(req))) return tooMany(res);
  res.setHeader("Cache-Control", "no-store");
  const room = String(req.query.room || "").slice(0, 80);
  if (!room) return res.json({ enabled: store.enabled(), items: [] });
  if (await wallLocked(room) && !safeEqual(String(req.query.k || ""), wallTokenFor(room))) return res.status(403).json({ error: "locked" });
  const items = await store.getWall(room, 100);
  res.json({ enabled: store.enabled(), items });
});
app.post("/wall", async (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (!wallWriteLimiter(clientIp(req))) return tooMany(res);
  if (!store.enabled()) return res.status(503).json({ error: "no_store" });
  const b = req.body || {};
  const room = String(b.room || "").slice(0, 80);
  if (!room) return res.status(400).json({ error: "bad_request" });
  if (await wallLocked(room) && !safeEqual(String(b.k || ""), wallTokenFor(room))) return res.status(403).json({ error: "locked" });
  const kind = ["photo", "audio", "video"].includes(b.kind) ? b.kind : "note";
  let data, mime = null;
  if (kind === "note") { data = String(b.text || "").trim().slice(0, 1000); if (!data) return res.status(400).json({ error: "empty" }); }
  else {
    data = String(b.data || ""); mime = String(b.mime || "").slice(0, 60) || null;
    const rules = { photo: [/^data:image\//, 3000000], audio: [/^data:audio\//, 2500000], video: [/^data:video\//, 7000000] };
    const [re, cap] = rules[kind];
    if (!re.test(data)) return res.status(400).json({ error: "bad_media" });
    if (data.length > cap) return res.status(413).json({ error: "too_big" });
  }
  const ownerKey = String(b.key || "").slice(0, 64);   // poster keeps the key → only they can remove the item
  const pub = { id: "w" + crypto.randomBytes(6).toString("hex"), room, kind, author: String(b.author || "Someone").slice(0, 40), mime, data, ts: Date.now() };
  await store.addWall(Object.assign({ editKey: ownerKey ? sha256hex(ownerKey) : null }, pub));
  try { const r = rooms.get(room); if (r) broadcastRoom(r, { type: "wall-add", item: pub }); } catch (e) {}   // live members see it instantly
  res.json({ ok: true, item: pub });
});
app.post("/wall-delete", async (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (!wallWriteLimiter(clientIp(req))) return tooMany(res);
  if (!store.enabled()) return res.status(503).json({ error: "no_store" });
  const b = req.body || {};
  const room = String(b.room || "").slice(0, 80), id = String(b.id || "").slice(0, 40), key = String(b.key || "").slice(0, 64);
  if (!room || !id || !key) return res.status(400).json({ error: "bad_request" });
  if (await wallLocked(room) && !safeEqual(String(b.k || ""), wallTokenFor(room))) return res.status(403).json({ error: "locked" });
  const ok = await store.delWall(room, id, sha256hex(key));   // only deletes when the owner key matches
  if (!ok) return res.status(403).json({ error: "not_yours" });
  try { const r = rooms.get(room); if (r) broadcastRoom(r, { type: "wall-remove", id }); } catch (e) {}
  res.json({ ok: true });
});

/* decode the HTML entities YouTube puts in titles (&quot; &#39; &amp; …) */
function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const named = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
    return Object.prototype.hasOwnProperty.call(named, e.toLowerCase()) ? named[e.toLowerCase()] : m;
  });
}
/* ---- YouTube search proxy: the API key stays on the server, never in the browser ---- */
app.get("/yt-search", (req, res) => {
  cors(req, res);
  if (!httpLimiter(clientIp(req))) return tooMany(res);   // also protects the YouTube API quota
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query.q || "").toString().slice(0, 200);
  if (!YT_API_KEY) return res.json({ items: [], error: "no_key" });
  if (!q) return res.json({ items: [] });
  const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=18&q=" +
    encodeURIComponent(q) + "&key=" + encodeURIComponent(YT_API_KEY);
  fetch(url).then(r => r.json()).then(data => {
    const items = (data.items || []).filter(it => it.id && it.id.videoId).map(it => ({
      id: it.id.videoId,
      title: decodeEntities((it.snippet && it.snippet.title) || it.id.videoId),   // YouTube returns HTML-encoded titles (&quot; &#39;) — decode so the browser doesn't show the codes
      thumb: ((it.snippet && it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default)) || {}).url || ""
    }));
    res.json({ items });
  }).catch(() => res.status(502).json({ items: [], error: "upstream" }));
});

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* ---- your own PeerJS signaling server (media transport only) ----
   Both WebSocket servers run in noServer mode; we route upgrades ourselves
   (below) so PeerJS and the control plane don't fight over the same server. */
const peerWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });   // SDP/ICE signaling only; cap oversized frames
const peerServer = ExpressPeerServer(server, { path: "/", allow_discovery: false, createWebSocketServer: () => peerWss });
app.use("/peerjs", peerServer);

/* ---- static front-end + admin ---- */
const PUBLIC = path.join(__dirname, "..", "public");
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC, "admin.html")));
app.use(express.static(PUBLIC, { extensions: ["html"], setHeaders: (res, file) => {
  const name = path.basename(file);
  if (name === "sw.js" || /\.html$/i.test(name) || /^(?:samecouch-app-v3\.js|samecouch-v3\.css|prepaint-v2\.js|iptv-client-v2\.js)$/i.test(name)) res.setHeader("Cache-Control", "no-cache");
  else if (/^samecouch-hero-\d+\.(?:avif|webp)$/i.test(name) || file.includes(path.sep + "vendor" + path.sep))
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  else res.setHeader("Cache-Control", "public, max-age=3600");
} }));

/* ============================================================================
 * Realtime control plane (/rt)
 * ==========================================================================*/
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });   // includes room-synced SRT/VTT text (client cap 512 KB)
const admins = new Set();

/* rooms: Map<roomCode, { members: Map<ws,{peerId,name}>, chat: [], lastActivity }> */
const rooms = new Map();
function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { members: new Map(), chat: [], queue: [], highlights: [], lastActivity: Date.now(), played: false, pass: null, host: null, syncSeq: 0 }; rooms.set(code, r); metrics.roomsCreated++; }
  return r;
}
const { createIptvService } = require("./iptv");
iptvService = createIptvService({
  clientIp,
  makeLimiter,
  authorizeRoom(room, key) {
    const current = rooms.get(String(room || ""));
    return !!(current && current.members.size && safeEqual(String(key || ""), wallTokenFor(room)));
  },
  roomLive(room) { const current = rooms.get(String(room || "")); return !!(current && current.members.size); },   // a provider session dies with the room it was opened for
  makeStreamToken: HAS_FFMPEG ? makeMkvToken : null,   // lets the IPTV remux fallback reuse the /mkv-stream transcoder
  internalBase: "http://127.0.0.1:" + PORT
});
app.use("/iptv", iptvService.router);
function hashPass(p) { return crypto.createHash("sha256").update("wmt:" + String(p || "")).digest("hex"); }
// constant-time string compare (hash first so unequal lengths neither throw nor leak length via timing)
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a == null ? "" : a)).digest();
  const hb = crypto.createHash("sha256").update(String(b == null ? "" : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// clamp gallery metadata coming from a presenter before it's relayed/stored (defense against oversized/garbage fields)
function cleanGalleryItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 300).map(it => ({
    fileId: String((it && it.fileId) || "").slice(0, 64),
    name: String((it && it.name) || "").slice(0, 120),
    type: (it && it.type === "image") ? "image" : "video",
    size: Math.max(0, Math.min(Number((it && it.size)) || 0, 50 * 1024 * 1024 * 1024)),
    mime: String((it && it.mime) || "").slice(0, 60)
  })).filter(it => it.fileId);
}
function cleanQueueUrl(value) {
  const raw = String(value || "").trim().slice(0, 2000);
  try { const u = new URL(raw); return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : ""; }
  catch (e) { return ""; }
}
function queueState(room) {
  return (room.queue || []).map(it => ({ id: it.id, title: it.title, url: it.url, addedBy: it.addedBy, addedName: it.addedName, votes: Array.from(it.votes || []), ts: it.ts }));
}
function addHighlight(room, item) {
  room.highlights = room.highlights || [];
  room.highlights.push(item);
  if (room.highlights.length > 100) room.highlights.splice(0, room.highlights.length - 100);
}

/* ---- lightweight, privacy-friendly growth metrics (aggregate counts only — no personal data) ---- */
const metrics = { startedAt: Date.now(), roomsCreated: 0, joins: 0, firstPlays: 0, shares: 0, sessionsEnded: 0, sessionMsTotal: 0 };
function metricsSnapshot() {
  const avgSessionMin = metrics.sessionsEnded ? Math.round(metrics.sessionMsTotal / metrics.sessionsEnded / 60000 * 10) / 10 : 0;
  const joinRate = metrics.roomsCreated ? Math.round(metrics.joins / metrics.roomsCreated * 100) / 100 : 0;       // avg people per room
  const playRate = metrics.roomsCreated ? Math.round(metrics.firstPlays / metrics.roomsCreated * 100) : 0;        // % of rooms that started a video
  const shareRate = metrics.roomsCreated ? Math.round(metrics.shares / metrics.roomsCreated * 100) : 0;           // shares per 100 rooms
  return { roomsCreated: metrics.roomsCreated, joins: metrics.joins, firstPlays: metrics.firstPlays, shares: metrics.shares,
    avgSessionMin, joinRate, playRate, shareRate, sinceMs: Date.now() - metrics.startedAt };
}
function rosterArr(room) {
  const a = []; room.members.forEach(v => a.push({ peerId: v.peerId, name: v.name })); return a;
}
function sendJSON(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function broadcastRoom(room, obj, exceptWs) { room.members.forEach((v, w) => { if (w !== exceptWs) sendJSON(w, obj); }); }

function stats() {
  let activeConversations = 0, peopleInConversations = 0, totalPresence = 0;
  const list = [];
  rooms.forEach((r, code) => {
    const n = r.members.size; totalPresence += n;
    if (n >= 2) { activeConversations += 1; peopleInConversations += n; }
    if (n > 0) list.push({ room: code, count: n, lastActivity: r.lastActivity });
  });
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  return { activeConversations, peopleInConversations, totalPresence, rooms: list, metrics: metricsSnapshot(), ts: Date.now() };
}
function pushStats() {
  const payload = JSON.stringify({ type: "stats", ...stats() });
  admins.forEach(a => { if (a.readyState === 1) { try { a.send(payload); } catch (e) {} } });
}

function leaveRoom(ws) {
  if (!ws._room) return;
  const r = rooms.get(ws._room);
  if (r) {
    const me = r.members.get(ws);
    r.members.delete(ws);
    if (me) broadcastRoom(r, { type: "peer-left", peerId: me.peerId, name: me.name });
    if (me && r.gallery && r.gallery.presenter === me.peerId) { r.gallery = null; broadcastRoom(r, { type: "gallery-clear", gone: true }); }   // gone:true → viewers keep what they already fully downloaded
    /* Whoever supplied the IPTV login takes it with them; an empty room retires it too, so a
       copied token cannot outlive the evening it was shared in. */
    if (me && r.iptvSource && r.iptvSource.peerId === me.peerId) { iptvService.revoke(r.iptvSource.token); r.iptvSource = null; r.iptvNav = null; broadcastRoom(r, { type: "iptv-source", source: null }); }
    if (r.members.size === 0 && r.iptvSource) { iptvService.revoke(r.iptvSource.token); r.iptvSource = null; r.iptvNav = null; }
    if (me && r.host === me.peerId && r.members.size) {   // host left → promote the longest-present member
      const next = r.members.values().next().value;
      if (next) { r.host = next.peerId; broadcastRoom(r, { type: "host", peerId: r.host }); }
    }
    r.lastActivity = Date.now();
    if (r.members.size === 0 && r.chat.length === 0) rooms.delete(ws._room);
  }
  if (ws._joinedAt) { metrics.sessionsEnded++; metrics.sessionMsTotal += Date.now() - ws._joinedAt; ws._joinedAt = 0; }   // record session length
  ws._room = null;
  pushStats();
}

const MSG = { JOIN: "join", LEAVE: "leave", CHAT: "chat", SYNC: "sync", TALKING: "talking", VIDEO: "video", REACT: "reaction" };
/* modes that can carry room-shared subtitles: native players use a <track>, embedded sites get an overlay the client draws itself */
const SUBTITLE_MODES = new Set(["file", "mkv", "hls", "embed"]);
const SYNC_KINDS = new Set(["play", "pause", "seek", "heartbeat", "buffering", "buffered-play", "countdown"]);
const REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👏", "👍", "🎉"];   // server validates emoji to keep the channel clean

wss.on("connection", (ws) => {
  ws._room = null; ws._peerId = null; ws._name = "Guest"; ws._isAdmin = false; ws._watch = null;
  ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
  // rate-limit bookkeeping (ws._ip is stamped in the upgrade handler)
  ws._msgN = 0; ws._msgReset = 0; ws._chatN = 0; ws._chatReset = 0;
  if (ws._ip) ipConns.set(ws._ip, (ipConns.get(ws._ip) || 0) + 1);

  ws.on("message", async (raw) => {
    // per-connection flood guard: drop messages above the burst budget
    const now = Date.now();
    if (now >= ws._msgReset) { ws._msgReset = now + RL_MSG_WINDOW; ws._msgN = 0; }
    if (++ws._msgN > RL_MSG_MAX) return;

    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    /* ---------- admin ---------- */
    if (m.type === "admin") {
      if ((ws._adminTries = (ws._adminTries || 0) + 1) > 10) return;   // throttle brute-force guesses on this connection
      if (ADMIN_PASSWORD && safeEqual(m.password, ADMIN_PASSWORD)) {   // constant-time compare
        ws._isAdmin = true; ws._adminTries = 0; admins.add(ws);
        sendJSON(ws, { type: "admin_ok" });
        sendJSON(ws, { type: "stats", ...stats() });
        sendJSON(ws, { type: "visitors", today: todayStr(), days: await visitorsReport(30) });
      } else sendJSON(ws, { type: "admin_denied" });
      return;
    }
    if (ws._isAdmin && m.type === "admin_visitors") {
      sendJSON(ws, { type: "visitors", today: todayStr(), days: await visitorsReport(30) });
      return;
    }
    if (ws._isAdmin && m.type === "admin_watch") {
      const code = String(m.room || "");
      ws._watch = code || null;
      const r = rooms.get(code);
      sendJSON(ws, { type: "chatlog", room: code, messages: r ? r.chat.slice(-CHAT_KEEP) : [] });
      return;
    }

    /* ---------- participants ---------- */
    if (m.type === MSG.JOIN) {
      const code = String(m.room || "").slice(0, 80);
      if (!code) return;
      const r = getRoom(code);
      // NOTE: the persisted host peerId is NOT restored — peer ids are random per session, so a stored
      // host can never match anyone again (it made room settings unreachable in existing rooms).
      if (!r._loadP) { r._loadP = store.getRoom(code).then(row => { if (row) { if (row.passHash) r.pass = row.passHash; if (row.expiresAt) r._expiresAt = row.expiresAt; if (row.theme) r.theme = row.theme; if (row.decor) { try { r.decor = JSON.parse(row.decor); } catch (e) {} } } }).catch(() => {}); }
      await r._loadP;   // restore a persisted lock/host (awaited so the password check sees it; concurrent joins share one load)
      if (r._bans && r._bans.has(String(m.peerId || ""))) { sendJSON(ws, { type: "kicked" }); return; }   // removed by host
      if (r.members.size >= MAX_ROOM && !r.members.has(ws)) { sendJSON(ws, { type: "full" }); return; }
      if (r.pass && !r.members.has(ws) && hashPass(m.pass) !== r.pass) {   // protected room → must supply the right password
        sendJSON(ws, { type: "need-pass", wrong: !!(m.pass) });
        return;
      }
      const wasEmpty = r.members.size === 0;   // first arrival → notify anyone watching this room
      const prevPid = r.members.has(ws) ? (r.members.get(ws) || {}).peerId : null;
      ws._room = code;
      ws._peerId = String(m.peerId || "").slice(0, 64) || ("p" + crypto.randomBytes(4).toString("hex"));
      ws._name = (String(m.name || "").trim().slice(0, 40)) || "Guest";
      // Same person re-attaching over a NEW control socket (network blip) → drop the zombie entry
      // SILENTLY. If we let the zombie time out via ping, its leaveRoom would broadcast "peer-left"
      // for a peerId that is alive again — and every client would tear down a WORKING call.
      r.members.forEach((v, w) => { if (w !== ws && v.peerId === ws._peerId) { r.members.delete(w); w._room = null; } });
      if (prevPid && prevPid !== ws._peerId) broadcastRoom(r, { type: "peer-left", peerId: prevPid }, ws);   // client rebuilt under a new id → let the room forget the old one
      r.members.set(ws, { peerId: ws._peerId, name: ws._name });
      // the host must be someone who is actually HERE — if not (empty room reopened, host gone), this joiner takes over
      const hostLive = Array.from(r.members.values()).some(v => v.peerId === r.host);
      if (!hostLive) { r.host = ws._peerId; store.ensureRoom(code, ws._peerId); broadcastRoom(r, { type: "host", peerId: r.host }, ws); }
      if (!r._expiresAt && store.enabled()) r._expiresAt = Date.now() + store.freeDays() * 86400000;   // free wall lifetime
      if (wasEmpty) void notifyRoomAlive(code, ws._name).catch(() => {});
      r.lastActivity = Date.now();
      if (!ws._joinedAt) { ws._joinedAt = Date.now(); metrics.joins++; }   // count this session join once
      // tell the joiner who is already here; tell others someone joined
      sendJSON(ws, { type: "roster", you: { peerId: ws._peerId, name: ws._name }, peers: rosterArr(r), host: r.host === ws._peerId, hasPass: !!r.pass, expiresAt: PAYWALL_ON ? (r._expiresAt || 0) : 0, theme: r.theme || "", decor: Array.isArray(r.decor) ? r.decor : [], wallKey: wallTokenFor(code), queue: queueState(r), highlights: (r.highlights || []).slice(-100) });
      broadcastRoom(r, { type: "peer-joined", peerId: ws._peerId, name: ws._name }, ws);
      if (r.iptvSource && iptvService.hasSession(r.iptvSource.token)) sendJSON(ws, { type: "iptv-source", source: r.iptvSource });   // hasSession, not publicSession: a join must not renew the TTL
      else if (r.iptvSource) { r.iptvSource = null; r.iptvNav = null; }
      if (r.iptvSource && r.iptvNav) sendJSON(ws, { type: "iptv-nav", ...r.iptvNav });
      if (r.gallery && r.gallery.items.length) sendJSON(ws, { type: "gallery", presenter: r.gallery.presenter, items: r.gallery.items, current: r.gallery.current });
      else if (r.media && r.media.url) {
        sendJSON(ws, { type: "video", from: "", ...r.media });   // replay the active link to (re)joiners
        if (r.subtitle && r.subtitle.url === r.media.url) {
          sendJSON(ws, { type: "subtitle", ...r.subtitle });
          if (r.subclock && r.subclock.started) {                       // hand a late joiner the running subtitle clock
            const elapsed = r.subclock.running ? Math.max(0, Date.now() - r.subclock.at) / 1000 : 0;
            sendJSON(ws, { type: "subclock", started: true, running: r.subclock.running, base: Math.max(0, r.subclock.base + elapsed) });
          }
        }
      }
      pushStats();
      return;
    }

    if (m.type === MSG.LEAVE) { leaveRoom(ws); return; }

    if (!ws._room) return;
    const r = rooms.get(ws._room);
    if (!r) return;
    r.lastActivity = Date.now();

    if (m.type === "kick") {                        // only the host may remove someone
      if (r.host !== ws._peerId) return;
      const targetId = String(m.peerId || "");
      if (!targetId || targetId === ws._peerId) return;
      r._bans = r._bans || new Set(); r._bans.add(targetId);   // soft ban for this session so they can't instantly rejoin
      r.members.forEach((v, w) => { if (v.peerId === targetId) { sendJSON(w, { type: "kicked" }); setTimeout(() => { try { w.close(); } catch (e) {} }, 400); } });
      return;
    }

    if (m.type === "room-rename") {                 // only the host may rename; the room + wall + everyone move with it
      if (r.host !== ws._peerId) { sendJSON(ws, { type: "rename-result", ok: false, reason: "denied" }); return; }
      const newCode = String(m.code || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-_]/g, "").replace(/^-+|-+$/g, "").slice(0, 40);
      if (newCode.length < 2) { sendJSON(ws, { type: "rename-result", ok: false, reason: "bad" }); return; }
      if (newCode === ws._room) { sendJSON(ws, { type: "rename-result", ok: true, code: newCode }); return; }
      if (rooms.has(newCode)) { sendJSON(ws, { type: "rename-result", ok: false, reason: "taken" }); return; }
      const okDb = await store.renameRoom(ws._room, newCode);
      if (!okDb) { sendJSON(ws, { type: "rename-result", ok: false, reason: "taken" }); return; }
      rooms.delete(ws._room); rooms.set(newCode, r);
      r.members.forEach((v, w) => { w._room = newCode; });
      broadcastRoom(r, { type: "renamed", code: newCode });   // everyone (incl. host) updates their URL + room name
      pushStats();
      return;
    }

    if (m.type === "set-pass") {                    // only the host may lock/unlock the room
      if (r.host !== ws._peerId) { sendJSON(ws, { type: "pass-set", hasPass: !!r.pass, denied: true }); return; }
      const p = String(m.password || "");
      r.pass = p ? hashPass(p) : null;
      store.setPass(ws._room, r.pass);   // survive restarts
      sendJSON(ws, { type: "pass-set", hasPass: !!r.pass });
      broadcastRoom(r, { type: "room-locked", hasPass: !!r.pass, by: ws._name }, ws);
      return;
    }

    if (m.type === MSG.CHAT) {
      // tighter per-connection limit for chat specifically (anti-spam)
      const cn = Date.now();
      if (cn >= ws._chatReset) { ws._chatReset = cn + RL_CHAT_WINDOW; ws._chatN = 0; }
      if (++ws._chatN > RL_CHAT_MAX) return;
      const text = String(m.text || "").slice(0, 2000);
      if (!text) return;
      const entry = { ts: Date.now(), name: ws._name, peerId: ws._peerId, text };
      r.chat.push(entry); if (r.chat.length > CHAT_KEEP) r.chat.shift();
      // relay to the room
      broadcastRoom(r, { type: "chat", from: entry.name, peerId: entry.peerId, text: entry.text, ts: entry.ts }, ws);
      // mirror to any admin watching this room
      admins.forEach(a => { if (a._watch === ws._room) sendJSON(a, { type: "chat", room: ws._room, from: entry.name, peerId: entry.peerId, text: entry.text, ts: entry.ts }); });
      return;
    }

    if (m.type === MSG.SYNC) {
      const kind = String(m.kind || "");
      if (!SYNC_KINDS.has(kind)) return;
      if ((kind === "heartbeat" || kind === "buffering" || kind === "buffered-play") && r.host !== ws._peerId) return;   // one stable clock; guests may still explicitly play/pause/seek
      const rawTime = Number(m.time); if (!Number.isFinite(rawTime)) return;
      const syncTime = kind === "countdown" ? Math.min(10, Math.max(0, rawTime)) : Math.min(24 * 3600, Math.max(0, rawTime));
      if (kind === "play" && !r.played) { r.played = true; metrics.firstPlays++; }   // first time this room starts playing
      /* the countdown is what starts an embedded film — remember when its "NOW" lands so a late
         joiner's subtitle overlay can pick the clock up mid-film instead of staying blank */
      if (kind === "countdown" && r.media && r.media.mode === "embed" && r.subtitle) {
        const secs = syncTime || 3;
        r.subclock = { started: true, running: true, base: 0, at: Date.now() + secs * 1000 };
      }
      r.syncSeq = (r.syncSeq || 0) + 1;
      broadcastRoom(r, { type: "sync", from: ws._peerId, kind, time: syncTime, playing: !!m.playing, seq: r.syncSeq, serverAt: Date.now() }, ws);
      return;
    }
    if (m.type === "ev") {   // lightweight client analytics events (aggregate only)
      if (m.name === "share") metrics.shares++;
      return;
    }
    if (m.type === MSG.REACT) {
      if (!REACTIONS.includes(m.emoji)) return;   // only allow the known emoji set
      const time = Math.min(24 * 3600, Math.max(0, Number(m.time) || 0));
      const highlight = { id: "h" + crypto.randomBytes(6).toString("hex"), kind: "reaction", emoji: m.emoji, name: ws._name, peerId: ws._peerId, time, mediaUrl: r.media ? r.media.url : "", ts: Date.now() };
      addHighlight(r, highlight);
      broadcastRoom(r, { type: "reaction", from: ws._peerId, name: ws._name, emoji: m.emoji, time, highlightId: highlight.id }, ws);
      return;
    }
    if (m.type === "moment-save") {
      const time = Math.min(24 * 3600, Math.max(0, Number(m.time) || 0));
      const highlight = { id: "h" + crypto.randomBytes(6).toString("hex"), kind: "moment", name: ws._name, peerId: ws._peerId, time, label: String(m.label || "").slice(0, 120), mediaUrl: r.media ? r.media.url : "", ts: Date.now() };
      addHighlight(r, highlight);
      broadcastRoom(r, { type: "highlight-add", item: highlight });
      return;
    }
    if (m.type === "queue-add") {
      const url = cleanQueueUrl(m.url); if (!url) return;
      r.queue = r.queue || [];
      if (r.queue.length >= 60) r.queue.shift();
      const item = { id: "q" + crypto.randomBytes(6).toString("hex"), title: String(m.title || "").trim().slice(0, 100) || url.replace(/^https?:\/\//, "").slice(0, 100), url, addedBy: ws._peerId, addedName: ws._name, votes: new Set([ws._peerId]), ts: Date.now() };
      r.queue.push(item); broadcastRoom(r, { type: "queue-state", items: queueState(r) }); return;
    }
    if (m.type === "queue-vote") {
      const item = (r.queue || []).find(it => it.id === String(m.id || "")); if (!item) return;
      if (item.votes.has(ws._peerId)) item.votes.delete(ws._peerId); else item.votes.add(ws._peerId);
      broadcastRoom(r, { type: "queue-state", items: queueState(r) }); return;
    }
    if (m.type === "queue-remove") {
      const id = String(m.id || ""); const item = (r.queue || []).find(it => it.id === id); if (!item) return;
      if (r.host !== ws._peerId && item.addedBy !== ws._peerId) return;
      r.queue = r.queue.filter(it => it.id !== id); broadcastRoom(r, { type: "queue-state", items: queueState(r) }); return;
    }
    if (m.type === "queue-play") {
      const item = (r.queue || []).find(it => it.id === String(m.id || "")); if (!item) return;
      const highlight = { id: "h" + crypto.randomBytes(6).toString("hex"), kind: "played", name: ws._name, peerId: ws._peerId, time: 0, label: item.title, mediaUrl: item.url, ts: Date.now() };
      addHighlight(r, highlight); broadcastRoom(r, { type: "queue-play", item: { id: item.id, title: item.title, url: item.url }, by: ws._name, from: ws._peerId }); return;
    }
    if (m.type === MSG.TALKING) {
      broadcastRoom(r, { type: "talking", from: ws._peerId, on: !!m.on }, ws);
      return;
    }
    if (m.type === "reneg") {   // a peer asks the caller to re-establish a dropped media connection (clients filter on target)
      const target = String(m.target || "").slice(0, 64);
      if (target) broadcastRoom(r, { type: "reneg", from: ws._peerId, target }, ws);
      return;
    }
    if (m.type === "screen-start" || m.type === "screen-stop") {   // browse-together: notify the room (the screen itself flows P2P)
      broadcastRoom(r, { type: m.type, from: ws._peerId }, ws);
      return;
    }
    if (m.type === "gallery-prog" || m.type === "gallery-ready" || m.type === "gallery-done" || m.type === "gallery-fail") {   // progressive transfer status goes back to the presenter
      broadcastRoom(r, { type: m.type, from: ws._peerId,
        pct: Math.max(0, Math.min(100, Math.round(+m.pct || 0))),
        speed: Math.max(0, Math.min(1024 * 1024 * 1024, Math.round(+m.speed || 0))),
        eta: Math.max(0, Math.min(7 * 24 * 3600, Math.round(+m.eta || 0))),
        paused: !!m.paused, streaming: !!m.streaming,
        fileId: String(m.fileId || "").slice(0, 64) }, ws);
      return;
    }
    if (m.type === "set-theme") {                   // room ambiance — host picks, everyone follows
      if (r.host !== ws._peerId) return;
      const THEME_IDS = ["classic", "party", "cinema", "summer", "winter"];
      const theme = THEME_IDS.includes(m.theme) ? m.theme : "classic";
      r.theme = theme;
      store.setTheme(ws._room, theme === "classic" ? null : theme);   // survive restarts
      broadcastRoom(r, { type: "theme", theme, by: ws._name }, ws);
      return;
    }
    if (m.type === "wall-del") {                    // host moderation: remove ANY item from this room's wall (incl. legacy items without owner key)
      if (r.host !== ws._peerId) return;
      const wid = String(m.id || "").slice(0, 40);
      if (!wid) return;
      store.delWallAny(ws._room, wid).then(ok => { if (ok) broadcastRoom(r, { type: "wall-remove", id: wid }); }).catch(() => {});
      return;
    }
    if (m.type === "set-decor") {                   // host furnishes the room: [{t,x},…] — validated, synced, persisted
      if (r.host !== ws._peerId) return;
      const DECOR_TYPES = ["lamp", "lights", "garland", "plant", "fire", "candles"];
      const items = (Array.isArray(m.items) ? m.items : []).slice(0, 12)
        .filter(it => it && DECOR_TYPES.includes(it.t) && typeof it.x === "number" && isFinite(it.x))
        .map(it => ({ t: it.t, x: Math.min(0.97, Math.max(0.03, Math.round(it.x * 1000) / 1000)) }));
      r.decor = items;
      store.setDecor(ws._room, items.length ? JSON.stringify(items) : null);
      broadcastRoom(r, { type: "decor", items, by: ws._name }, ws);
      return;
    }
    if (m.type === "game") {                        // game-night control messages (start/round/correct/end) — drawing strokes flow P2P
      if (!m.data || typeof m.data !== "object") return;
      let s; try { s = JSON.stringify(m.data); } catch (e) { return; }
      if (s.length > 2000) return;                  // control only; anything bigger doesn't belong here
      broadcastRoom(r, { type: "game", from: ws._peerId, data: m.data }, ws);
      return;
    }
    if (m.type === "iptv-source") {
      const token = String(m.token || "").slice(0, 120);
      if (!token) {   // the host or whoever supplied it may take the source away again
        if (r.host === ws._peerId || (r.iptvSource && r.iptvSource.peerId === ws._peerId)) {
          if (r.iptvSource) iptvService.revoke(r.iptvSource.token);
          r.iptvSource = null; r.iptvNav = null; broadcastRoom(r, { type: "iptv-source", source: null });
        }
        return;
      }
      if (iptvService.sessionRoom(token) !== ws._room) { sendJSON(ws, { type: "iptv-source-error", error: "source_expired" }); return; }   // a token minted for another room is not usable here
      const source = iptvService.publicSession(token);
      if (!source) { sendJSON(ws, { type: "iptv-source-error", error: "source_expired" }); return; }
      if (r.iptvSource && r.iptvSource.token !== source.token) iptvService.revoke(r.iptvSource.token);   // replacing a source retires the old login
      r.iptvSource = { token: source.token, type: source.type, name: source.name, expiresAt: source.expiresAt, by: ws._name, peerId: ws._peerId };
      r.iptvNav = null;
      broadcastRoom(r, { type: "iptv-source", source: r.iptvSource });   // nested: a flat spread would let source.type ("m3u"/"xtream") overwrite the envelope type
      return;
    }
    if (m.type === "iptv-nav") {
      if (!r.iptvSource) return;
      const view = m.view === "series" ? "series" : "catalog";
      const kind = m.kind === "movie" || m.kind === "series" ? m.kind : "live";
      const id = String(m.id || "").replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 140);
      const title = String(m.title || "").slice(0, 180);
      const category = String(m.category || "").slice(0, 120);
      const q = String(m.q || "").slice(0, 120);
      r.iptvNav = { view, kind, id, title, category, q, by: ws._name };
      broadcastRoom(r, { type: "iptv-nav", from: ws._peerId, ...r.iptvNav }, ws);
      return;
    }
    if (m.type === MSG.VIDEO) {
      const mode = String(m.mode || "").slice(0, 16);
      const url = String(m.url || "").slice(0, 2000);
      const id = String(m.id || "").slice(0, 64);
      const title = String(m.title || "").slice(0, 180);
      const live = !!m.live;
      const iptv = !!m.iptv && !!r.iptvSource;
      const iptvFallback = iptv && (m.iptvFallback === "copy" || m.iptvFallback === "h264") ? m.iptvFallback : "";
      const iptvSubtitles = Array.isArray(m.iptvSubtitles) ? m.iptvSubtitles.slice(0, 20).map(sub => ({
        name: String(sub && sub.name || "Subtitles").slice(0, 80),
        lang: String(sub && sub.lang || "und").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "und",
        url: String(sub && sub.url || "").slice(0, 2000)
      })).filter(sub => /^https?:\/\//i.test(sub.url)) : [];
      if (!r.media || r.media.url !== url || !SUBTITLE_MODES.has(mode)) { r.subtitle = null; r.subclock = null; }
      r.media = url ? { mode, url, id, title, live, iptv, iptvFallback, iptvSubtitles } : null;   // remember what's playing → replay to (re)joiners so a missed link never stays blank
      broadcastRoom(r, { type: "video", from: ws._peerId, mode, url, id, title, live, iptv, iptvFallback, iptvSubtitles }, ws);
      return;
    }

    /* SRT is converted to WebVTT in the browser and kept with the active direct-video URL.
       The text-only payload is capped so a subtitle cannot become a general file-upload route. */
    if (m.type === "subtitle") {
      if (!r.media || !SUBTITLE_MODES.has(r.media.mode)) return;
      const url = String(m.url || "").slice(0, 2000);
      const vtt = String(m.vtt || "");
      if (url !== r.media.url || vtt.length < 12 || vtt.length > 600 * 1024 || !/^WEBVTT(?:\s|$)/.test(vtt) || !vtt.includes("-->")) return;
      r.subtitle = { url, name: String(m.name || "subtitles.srt").slice(0, 120), lang: String(m.lang || "und").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "und", vtt };
      r.subclock = null;   // a fresh subtitle file starts unplayed; the countdown starts its clock
      broadcastRoom(r, { type: "subtitle", ...r.subtitle }, ws);
      return;
    }

    /* Embedded sites play in a cross-origin iframe, so subtitles ride our own clock: relay where
       that clock stands (started at the countdown, paused/resumed by hand) to the rest of the room. */
    if (m.type === "subclock") {
      if (!r.media || r.media.mode !== "embed" || !r.subtitle) return;
      const base = Math.min(24 * 3600, Math.max(0, Number(m.base) || 0));
      const started = m.started !== false, running = !!m.running;
      r.subclock = { started, running, base, at: Date.now() };   // keep it for (re)joiners
      broadcastRoom(r, { type: "subclock", started, running, base }, ws);
      return;
    }

    /* ---- shared gallery (photos/videos): only control state is relayed; the bytes go peer-to-peer ---- */
    if (m.type === "gallery") {
      const items = cleanGalleryItems(m.items);
      r.media = null;   // a gallery share replaces a pasted link
      r.subtitle = null; r.subclock = null;
      r.gallery = { presenter: ws._peerId, items, current: String(m.current || "").slice(0, 64) || null };
      // hold is relayed but NOT stored: live viewers wait for the synchronized reveal, late joiners reveal for themselves
      broadcastRoom(r, { type: "gallery", presenter: ws._peerId, items: r.gallery.items, current: r.gallery.current, hold: !!m.hold }, ws);
      return;
    }
    if (m.type === "gallery-show") {
      const fileId = String(m.fileId || "").slice(0, 64);
      if (r.gallery) r.gallery.current = fileId;
      broadcastRoom(r, { type: "gallery-show", fileId }, ws);
      return;
    }
    if (m.type === "gallery-clear") {
      r.gallery = null;   // presenter OR any viewer may end a share (small trusted rooms); explicit stop, so no "gone" flag
      broadcastRoom(r, { type: "gallery-clear" }, ws);
      return;
    }
  });

  ws.on("close", () => {
    admins.delete(ws); leaveRoom(ws);
    if (ws._ip) { const c = (ipConns.get(ws._ip) || 1) - 1; if (c <= 0) ipConns.delete(ws._ip); else ipConns.set(ws._ip, c); }
  });
  ws.on("error", () => {});
});

/* route /rt to the control plane, everything else to PeerJS signaling */
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch (e) {}
  if (pathname === "/rt") {
    const ip = clientIp(req);
    recordVisit(ip);   // WebSocket upgrades skip Express middleware — count the visitor here too
    if (!connLimiter(ip) || (ipConns.get(ip) || 0) >= RL_CONN_CONCURRENT) {
      try { socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); } catch (e) {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws._ip = ip; wss.emit("connection", ws, req); });
  } else {
    peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit("connection", ws, req));
  }
});

/* drop dead sockets so counts stay honest */
const ping = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  });
}, 30000);
wss.on("close", () => clearInterval(ping));

/* Fire due watch-party reminders. The queue is persistent; an always-on instance
   still gives the most punctual delivery, but restarts no longer lose reminders. */
if (HAS_PUSH) {
  let reminderSweepBusy = false;
  setInterval(async () => {
    if (reminderSweepBusy) return;
    reminderSweepBusy = true;
    try {
      const now = Date.now();
      const persisted = await store.dueReminders(now, 100);
      const dueList = persisted.concat(reminders.filter(r => !r.sent && r.at <= now));
      dueList.forEach(r => {
        if (r.sent || r.at > now) return;
        r.sent = true;
        const payload = JSON.stringify({ title: r.title, body: r.body || "Your watch party is starting now! 🍿", url: r.url, tag: "wmt-" + r.at });
        webpush.sendNotification(r.sub, payload).catch(() => {}).finally(() => { if (r.id) store.delReminder(r.id); });
      });
      for (let i = reminders.length - 1; i >= 0; i--) { if (reminders[i].sent || reminders[i].at < now - 3600000) reminders.splice(i, 1); }
      await store.pruneReminders(now - 3600000);
    } finally {
      reminderSweepBusy = false;
    }
  }, 20000).unref();
}

/* prune expired free walls (their memories + room) periodically */
if (store.enabled() && PAYWALL_ON) { store.pruneExpired(); setInterval(() => store.pruneExpired(), 3600000).unref(); }   // free test phase: never delete rooms/walls

server.listen(PORT, () => {
  console.log("SameCouch server on :" + PORT);
  console.log("  app:    http://localhost:" + PORT + "/");
  console.log("  admin:  http://localhost:" + PORT + "/admin");
});
