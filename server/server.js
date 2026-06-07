/* ============================================================================
 * WatchMovieTogether — single backend
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

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_URLS_RAW = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TURN_URLS = TURN_URLS_RAW.filter(u => /^(turns?|stun):/i.test(u));
const TURN_TTL = parseInt(process.env.TURN_TTL || "3600", 10);
const MAX_ROOM = parseInt(process.env.MAX_ROOM || "8", 10);
const CHAT_KEEP = parseInt(process.env.CHAT_KEEP || "300", 10);
const YT_API_KEY = process.env.YT_API_KEY || "";   // YouTube Data API v3 key — stays server-side, never sent to the browser

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD not set — the admin dashboard will refuse logins.");
if (TURN_URLS_RAW.length && TURN_URLS.length < TURN_URLS_RAW.length) {
  console.warn("[WARN] TURN_URLS has entries that are not turn:/turns:/stun: URLs and were ignored:",
    TURN_URLS_RAW.filter(u => !/^(turns?|stun):/i.test(u)));
}
if (!TURN_SECRET || !TURN_URLS.length) console.warn("[WARN] TURN_SECRET / TURN_URLS not set — only public STUN will be offered (no relay fallback).");

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);

/* ---- small CORS for the public GET endpoints (front-end may be on another origin) ---- */
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ---- short-lived TURN credentials (coturn "use-auth-secret" REST scheme) ---- */
function makeTurnCredentials() {
  const stun = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  if (!TURN_SECRET || !TURN_URLS.length) return stun;
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = expiry + ":" + crypto.randomBytes(6).toString("hex");
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
  return stun.concat([{ urls: TURN_URLS, username, credential }]);
}

app.get("/turn-credentials", (req, res) => {
  cors(req, res);
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
    hasTurn: !!(TURN_SECRET && TURN_URLS.length),
    hasYouTube: !!YT_API_KEY
  });
});

/* ---- YouTube search proxy: the API key stays on the server, never in the browser ---- */
app.get("/yt-search", (req, res) => {
  cors(req, res);
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
const peerWss = new WebSocketServer({ noServer: true });
const peerServer = ExpressPeerServer(server, { path: "/", allow_discovery: false, createWebSocketServer: () => peerWss });
app.use("/peerjs", peerServer);

/* ---- static front-end + admin ---- */
const PUBLIC = path.join(__dirname, "..", "public");
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC, "admin.html")));
app.use(express.static(PUBLIC, { extensions: ["html"], setHeaders: r => r.setHeader("Cache-Control", "no-cache") }));

/* ============================================================================
 * Realtime control plane (/rt)
 * ==========================================================================*/
const wss = new WebSocketServer({ noServer: true });
const admins = new Set();

/* rooms: Map<roomCode, { members: Map<ws,{peerId,name}>, chat: [], lastActivity }> */
const rooms = new Map();
function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { members: new Map(), chat: [], lastActivity: Date.now() }; rooms.set(code, r); }
  return r;
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
  return { activeConversations, peopleInConversations, totalPresence, rooms: list, ts: Date.now() };
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
    r.lastActivity = Date.now();
    if (r.members.size === 0 && r.chat.length === 0) rooms.delete(ws._room);
  }
  ws._room = null;
  pushStats();
}

const MSG = { JOIN: "join", LEAVE: "leave", CHAT: "chat", SYNC: "sync", TALKING: "talking", VIDEO: "video" };

wss.on("connection", (ws) => {
  ws._room = null; ws._peerId = null; ws._name = "Guest"; ws._isAdmin = false; ws._watch = null;
  ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    /* ---------- admin ---------- */
    if (m.type === "admin") {
      if (ADMIN_PASSWORD && m.password === ADMIN_PASSWORD) {
        ws._isAdmin = true; admins.add(ws);
        sendJSON(ws, { type: "admin_ok" });
        sendJSON(ws, { type: "stats", ...stats() });
      } else sendJSON(ws, { type: "admin_denied" });
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
      if (r.members.size >= MAX_ROOM && !r.members.has(ws)) { sendJSON(ws, { type: "full" }); return; }
      ws._room = code;
      ws._peerId = String(m.peerId || "").slice(0, 64) || ("p" + crypto.randomBytes(4).toString("hex"));
      ws._name = (String(m.name || "").trim().slice(0, 40)) || "Guest";
      r.members.set(ws, { peerId: ws._peerId, name: ws._name });
      r.lastActivity = Date.now();
      // tell the joiner who is already here; tell others someone joined
      sendJSON(ws, { type: "roster", you: { peerId: ws._peerId, name: ws._name }, peers: rosterArr(r) });
      broadcastRoom(r, { type: "peer-joined", peerId: ws._peerId, name: ws._name }, ws);
      pushStats();
      return;
    }

    if (m.type === MSG.LEAVE) { leaveRoom(ws); return; }

    if (!ws._room) return;
    const r = rooms.get(ws._room);
    if (!r) return;
    r.lastActivity = Date.now();

    if (m.type === MSG.CHAT) {
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
      broadcastRoom(r, { type: "sync", from: ws._peerId, kind: m.kind, time: m.time, playing: m.playing }, ws);
      return;
    }
    if (m.type === MSG.TALKING) {
      broadcastRoom(r, { type: "talking", from: ws._peerId, on: !!m.on }, ws);
      return;
    }
    if (m.type === MSG.VIDEO) {
      broadcastRoom(r, { type: "video", from: ws._peerId, mode: m.mode, url: m.url, id: m.id }, ws);
      return;
    }
  });

  ws.on("close", () => { admins.delete(ws); leaveRoom(ws); });
  ws.on("error", () => {});
});

/* route /rt to the control plane, everything else to PeerJS signaling */
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch (e) {}
  if (pathname === "/rt") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
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

server.listen(PORT, () => {
  console.log("WatchMovieTogether server on :" + PORT);
  console.log("  app:    http://localhost:" + PORT + "/");
  console.log("  admin:  http://localhost:" + PORT + "/admin");
});
