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
 *   Video and audio stay peer-to-peer and end-to-end encrypted (WebRTC). They
 *   never pass through this server. CHAT, by design, DOES pass through this
 *   server so it can be moderated. Disclose this in your privacy policy.
 *
 * Deploy on a host with persistent WebSocket support (Render / Railway / Fly /
 * a VPS). It does NOT run on Vercel's serverless functions.
 * ==========================================================================*/
"use strict";

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
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
// In-memory reminder queue. NOTE: lost on restart — use a DB + an always-on instance for production reliability.
const reminders = [];   // { sub, at, title, body, url, sent }
const MAX_REMINDERS = parseInt(process.env.MAX_REMINDERS || "5000", 10);
const REMINDER_MAX_AHEAD = parseInt(process.env.REMINDER_MAX_AHEAD || String(31 * 24 * 3600 * 1000), 10);

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD not set — the admin dashboard will refuse logins.");
if (TURN_URLS_RAW.length && TURN_URLS.length < TURN_URLS_RAW.length) {
  console.warn("[WARN] TURN_URLS has entries that are not turn:/turns:/stun: URLs and were ignored:",
    TURN_URLS_RAW.filter(u => !/^(turns?|stun):/i.test(u)));
}
if (!HAS_TURN) console.warn("[WARN] No usable TURN (need TURN_URLS plus either TURN_SECRET or TURN_USERNAME+TURN_CREDENTIAL) — only public STUN offered; cross-network calls may fail.");

const app = express();
app.disable("x-powered-by");

/* ---- security headers (applied to every response) ----
   The front-end is a single inline-script/style page that embeds YouTube/Vimeo,
   loads PeerJS + qrcode from cdnjs and fonts from Google, talks to this backend
   over https+wss, and lets the host paste any https link to co-watch. The CSP
   below is the tightest policy that keeps all of that working. Keep it in sync
   with vercel.json (the production front-end is served from there). */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://www.youtube.com https://s.ytimg.com https://player.vimeo.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: mediastream:",
  "connect-src 'self' https://watchmovietogether-j59u.onrender.com wss://watchmovietogether-j59u.onrender.com",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), browsing-topics=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if ((req.headers["x-forwarded-proto"] || req.protocol) === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Full CSP only for top-level documents — API responses are JSON and don't need it.
  if (req.method === "GET" && (req.headers.accept || "").indexOf("text/html") !== -1)
    res.setHeader("Content-Security-Policy", CSP);
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
    hasPush: HAS_PUSH,
    vapidPublic: HAS_PUSH ? VAPID_PUBLIC : "",
    hasWall: store.enabled(),
    freeDays: store.freeDays(),
    stripeLink: process.env.STRIPE_LINK || ""
  });
});

/* ---- Web Push subscribe: store a reminder to fire at a scheduled time ---- */
app.options("/push-subscribe", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS"); res.sendStatus(204); });
app.post("/push-subscribe", (req, res) => {
  cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (!httpLimiter(clientIp(req))) return tooMany(res);
  if (!HAS_PUSH) return res.status(503).json({ error: "push_disabled" });
  const b = req.body || {};
  const sub = b.subscription;
  const at = parseInt(b.at, 10);
  if (!sub || !sub.endpoint || !at) return res.status(400).json({ error: "bad_request" });
  if (at < Date.now() - 60000 || at > Date.now() + REMINDER_MAX_AHEAD) return res.status(400).json({ error: "bad_time" });
  if (reminders.length >= MAX_REMINDERS) reminders.shift();
  reminders.push({
    sub,
    at,
    title: String(b.title || "SameCouch").slice(0, 80),
    body: String(b.body || "").slice(0, 140),
    url: String(b.url || "/").slice(0, 400),
    sent: false
  });
  res.json({ ok: true });
});

/* ---- "Tell me when the room comes alive": store a push sub per room, fire when an empty room gets its first arrival ---- */
const roomSubs = new Map();        // roomCode -> Map(endpoint -> { sub, name })
const roomNotifiedAt = new Map();  // roomCode -> ts (cooldown so we don't spam)
const MAX_ROOMSUBS = parseInt(process.env.MAX_ROOMSUBS || "20000", 10);
let roomSubCount = 0;
app.options("/room-notify", (req, res) => { cors(req, res); res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS"); res.sendStatus(204); });
app.post("/room-notify", (req, res) => {
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
  res.json({ ok: true });
});
function notifyRoomAlive(room, arriverName) {
  if (!HAS_PUSH) return;
  const m = roomSubs.get(room); if (!m || !m.size) return;
  const last = roomNotifiedAt.get(room) || 0;
  if (Date.now() - last < 60000) return;   // at most once a minute per room
  roomNotifiedAt.set(room, Date.now());
  const url = "/?room=" + encodeURIComponent(room);
  const payload = JSON.stringify({ title: "Your living room is live 🛋️", body: (arriverName || "Someone") + " just arrived — come hang out", url, tag: "wmt-room-" + room });
  m.forEach((v, endpoint) => {
    webpush.sendNotification(v.sub, payload).catch(() => { m.delete(endpoint); roomSubCount--; });   // drop dead subs
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
      title: (it.snippet && it.snippet.title) || it.id.videoId,
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
app.use(express.static(PUBLIC, { extensions: ["html"], setHeaders: r => r.setHeader("Cache-Control", "no-cache") }));

/* ============================================================================
 * Realtime control plane (/rt)
 * ==========================================================================*/
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });   // control-plane JSON is tiny; cap oversized frames
const admins = new Set();

/* rooms: Map<roomCode, { members: Map<ws,{peerId,name}>, chat: [], lastActivity }> */
const rooms = new Map();
function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { members: new Map(), chat: [], lastActivity: Date.now(), played: false, pass: null, host: null }; rooms.set(code, r); metrics.roomsCreated++; }
  return r;
}
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
    if (me && r.gallery && r.gallery.presenter === me.peerId) { r.gallery = null; broadcastRoom(r, { type: "gallery-clear" }); }
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
      if (wasEmpty) notifyRoomAlive(code, ws._name);
      r.lastActivity = Date.now();
      if (!ws._joinedAt) { ws._joinedAt = Date.now(); metrics.joins++; }   // count this session join once
      // tell the joiner who is already here; tell others someone joined
      sendJSON(ws, { type: "roster", you: { peerId: ws._peerId, name: ws._name }, peers: rosterArr(r), host: r.host === ws._peerId, hasPass: !!r.pass, expiresAt: PAYWALL_ON ? (r._expiresAt || 0) : 0, theme: r.theme || "", decor: Array.isArray(r.decor) ? r.decor : [], wallKey: wallTokenFor(code) });
      broadcastRoom(r, { type: "peer-joined", peerId: ws._peerId, name: ws._name }, ws);
      if (r.gallery && r.gallery.items.length) sendJSON(ws, { type: "gallery", presenter: r.gallery.presenter, items: r.gallery.items, current: r.gallery.current });
      else if (r.media && r.media.url) sendJSON(ws, { type: "video", from: "", mode: r.media.mode, url: r.media.url, id: r.media.id });   // replay the active link to (re)joiners
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
      if (m.kind === "play" && !r.played) { r.played = true; metrics.firstPlays++; }   // first time this room starts playing
      broadcastRoom(r, { type: "sync", from: ws._peerId, kind: m.kind, time: m.time, playing: m.playing }, ws);
      return;
    }
    if (m.type === "ev") {   // lightweight client analytics events (aggregate only)
      if (m.name === "share") metrics.shares++;
      return;
    }
    if (m.type === MSG.REACT) {
      if (!REACTIONS.includes(m.emoji)) return;   // only allow the known emoji set
      broadcastRoom(r, { type: "reaction", from: ws._peerId, name: ws._name, emoji: m.emoji }, ws);
      return;
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
    if (m.type === "gallery-prog" || m.type === "gallery-done") {   // transfer-then-reveal: viewers report share-download progress to the presenter
      broadcastRoom(r, { type: m.type, from: ws._peerId, pct: Math.max(0, Math.min(100, Math.round(+m.pct || 0))) }, ws);
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
    if (m.type === MSG.VIDEO) {
      const mode = String(m.mode || "").slice(0, 16);
      const url = String(m.url || "").slice(0, 2000);
      const id = String(m.id || "").slice(0, 64);
      r.media = url ? { mode, url, id } : null;   // remember what's playing → replay to (re)joiners so a missed link never stays blank
      broadcastRoom(r, { type: "video", from: ws._peerId, mode, url, id }, ws);
      return;
    }

    /* ---- shared gallery (photos/videos): only control state is relayed; the bytes go peer-to-peer ---- */
    if (m.type === "gallery") {
      const items = cleanGalleryItems(m.items);
      r.media = null;   // a gallery share replaces a pasted link
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
      if (r.gallery && r.gallery.presenter === ws._peerId) r.gallery = null;
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

/* fire due watch-party reminders (needs an always-on instance to be reliable) */
if (HAS_PUSH) {
  setInterval(() => {
    const now = Date.now();
    let due = false;
    reminders.forEach(r => {
      if (r.sent || r.at > now) return;
      r.sent = true; due = true;
      const payload = JSON.stringify({ title: r.title, body: r.body || "Your watch party is starting now! 🍿", url: r.url, tag: "wmt-" + r.at });
      webpush.sendNotification(r.sub, payload).catch(() => { /* expired/invalid subscription — drop silently */ });
    });
    // prune sent or long-expired reminders
    if (due || reminders.length > 1000) {
      for (let i = reminders.length - 1; i >= 0; i--) { if (reminders[i].sent || reminders[i].at < now - 3600000) reminders.splice(i, 1); }
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
