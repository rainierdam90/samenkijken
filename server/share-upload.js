"use strict";
/*
 * SameCouch — phone share upload (upload once, play everywhere)
 *
 * A phone uploads a photo/video ONCE to this server in fixed-size chunks (resumable,
 * retryable, any order). Every participant then plays it over plain HTTPS with Range
 * support, so nobody depends on the phone's uplink, a TURN relay or a service worker.
 * Playback may start while the upload is still running: a read of bytes that have not
 * arrived yet waits (event-driven) for the chunk that holds them.
 *
 * Files live briefly on disk under `dir`, named by an unguessable 128-bit id, and are
 * removed when the presenter deletes them, after `ttlMs`, or once their room has been
 * empty for `emptyRoomTtlMs`. Nothing survives a restart: the dir is purged on startup.
 *
 * Mount BEFORE any global body parser:  app.use("/share", shareUpload.router)
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pipeline, Transform } = require("stream");
const express = require("express");

const MIME_ALLOW = new Set([
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-m4v",
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"
]);
const MIME_ALIAS = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "video/mov": "video/quicktime" };
const MIME_BY_EXT = {
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", qt: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic"
};
const ID_RE = /^[0-9a-f]{32}$/;

function normaliseMime(mime, filename) {
  let m = String(mime || "").split(";")[0].trim().toLowerCase();
  m = MIME_ALIAS[m] || m;
  if (MIME_ALLOW.has(m)) return m;
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(filename || "")) || [])[1];
  return (ext && MIME_BY_EXT[ext.toLowerCase()]) || null;
}
function cleanName(s) { return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120); }

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;              // malformed or multi-range → whole file
  let start, end;
  if (m[1] === "") {                                                 // suffix: last N bytes
    const n = parseInt(m[2], 10);
    if (!(n > 0)) return { unsatisfiable: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return { unsatisfiable: true };
  return { start, end };
}

function createShareUpload(opts) {
  const o = opts || {};
  const dir = path.resolve(o.dir || path.join(__dirname, "..", "data", "shares"));
  const wallAllowed = o.wallAllowed || (() => false);
  const roomLive = o.roomLive || (() => false);
  const broadcast = o.broadcast || (() => {});
  const clientIp = o.clientIp || (req => (req.socket && req.socket.remoteAddress) || "?");
  const makeLimiter = o.makeLimiter || (() => () => true);
  const cors = o.cors || ((req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); });
  const maxBytes = o.maxBytes != null ? o.maxBytes : 2 * 1024 ** 3;
  const roomMaxBytes = o.roomMaxBytes != null ? o.roomMaxBytes : 4 * 1024 ** 3;
  const minFreeBytes = o.minFreeBytes != null ? o.minFreeBytes : 3 * 1024 ** 3;
  const ttlMs = o.ttlMs != null ? o.ttlMs : 6 * 3600 * 1000;
  const emptyRoomTtlMs = o.emptyRoomTtlMs != null ? o.emptyRoomTtlMs : 3600 * 1000;
  const chunkSize = o.chunkSize || 8 * 1024 * 1024;
  const waitMs = o.waitMs != null ? o.waitMs : 30000;               // how long a read waits for a missing chunk
  const sweepMs = o.sweepMs || 5 * 60 * 1000;

  const secret = crypto.randomBytes(32);                             // per process: tokens die with a restart, like the files
  const shares = new Map();                                          // id -> share

  const initLimiter = makeLimiter(30, 10 * 60 * 1000);
  const chunkLimiter = makeLimiter(600, 60 * 1000);                  // 2–3 parallel 8 MiB PUTs on fast Wi-Fi stay far below this
  const readLimiter = makeLimiter(1200, 60 * 1000);                  // media elements issue many small Range requests when seeking
  const metaLimiter = makeLimiter(240, 60 * 1000);

  /* ---- startup: our own leftovers only (32-hex names), never anything else in the dir ---- */
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (ID_RE.test(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* in use / gone */ } }
  }

  function token(id, kind) { return crypto.createHmac("sha256", secret).update(id + "|" + kind).digest("hex").slice(0, 32); }
  function tokenOk(share, kind, given) {
    const want = Buffer.from(token(share.id, kind));
    const got = Buffer.from(String(given || ""));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  function givenToken(req) { return (req.query && typeof req.query.t === "string") ? req.query.t : String(req.headers["x-share-token"] || ""); }
  function chunkLen(share, n) { return n === share.chunks - 1 ? share.size - n * chunkSize : chunkSize; }

  function corsAll(req, res) {
    cors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, X-Share-Token");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  }
  function fail(res, status, error, extra) {
    if (res.headersSent || res.destroyed) return;
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json(Object.assign({ error }, extra || {}));
  }
  function tooMany(res) { res.setHeader("Retry-After", "60"); fail(res, 429, "rate_limited"); }
  function lookup(req, res) {
    const id = String(req.params.id || "");
    const share = ID_RE.test(id) ? shares.get(id) : null;
    if (!share) { fail(res, 404, "not_found"); return null; }
    return share;
  }
  function safeBroadcast(room, msg) { try { broadcast(room, msg); } catch (e) { /* never break an upload over a relay hiccup */ } }

  /* ---- chunk availability: waiters are woken by the upload, never by polling ---- */
  function wake(share) {
    for (const w of Array.from(share.waiters)) { if (share.gone) w.finish(false); else if (share.received[w.idx]) w.finish(true); }
  }
  function waitChunk(share, idx, res) {
    if (share.gone) return Promise.resolve(false);
    if (share.received[idx]) return Promise.resolve(true);
    return new Promise(resolve => {
      const w = { idx, settled: false };
      const onClose = () => w.finish(false);
      w.finish = ok => {
        if (w.settled) return; w.settled = true;
        clearTimeout(w.timer); share.waiters.delete(w); if (res) res.off("close", onClose);
        resolve(ok);
      };
      w.timer = setTimeout(() => w.finish(false), waitMs);
      share.waiters.add(w);
      if (res) res.on("close", onClose);                              // client gave up → stop waiting for it
    });
  }

  function removeShare(share, reason) {
    if (share.gone) return;
    share.gone = true;
    shares.delete(share.id);
    wake(share);
    fsp.unlink(share.file).catch(() => {});
    safeBroadcast(share.room, { type: "share-gone", id: share.id, reason: reason || "deleted" });
  }

  async function freeDiskBytes() {
    if (typeof fsp.statfs !== "function") return Infinity;
    try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; }
  }

  const router = express.Router();
  const jsonInit = express.json({ limit: "8kb" });

  router.options("*", (req, res) => { corsAll(req, res); res.setHeader("Access-Control-Max-Age", "600"); res.sendStatus(204); });

  /* POST /share/init {room,k,name,size,mime,filename,duration} */
  router.post("/init", jsonInit, async (req, res) => {
    corsAll(req, res);
    try {
      if (!initLimiter(clientIp(req))) return tooMany(res);
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const room = typeof b.room === "string" ? b.room.trim().slice(0, 64) : "";
      const k = typeof b.k === "string" ? b.k : "";
      let allowed = false; try { allowed = !!(room && k && wallAllowed(room, k)); } catch (e) { allowed = false; }
      if (!allowed) return fail(res, 403, "forbidden");
      let live = false; try { live = !!roomLive(room); } catch (e) { live = false; }
      if (!live) return fail(res, 404, "room_not_live");
      const size = Number(b.size);
      if (!Number.isSafeInteger(size) || size < 1) return fail(res, 400, "bad_size");
      if (size > maxBytes) return fail(res, 413, "too_large", { maxBytes });
      const filename = cleanName(b.filename || b.name);
      const mime = normaliseMime(b.mime, filename);
      if (!mime) return fail(res, 415, "unsupported_type");
      const duration = Number(b.duration);

      const free = await freeDiskBytes();
      let roomBytes = 0, outstanding = 0;                              // computed after the await so racing inits both count
      shares.forEach(s => { if (s.room === room) roomBytes += s.size; outstanding += s.size - s.bytes; });
      if (roomBytes + size > roomMaxBytes) return fail(res, 413, "room_quota", { roomMaxBytes });
      if (free - outstanding - size < minFreeBytes) return fail(res, 507, "disk_full");

      const id = crypto.randomBytes(16).toString("hex");
      const file = path.join(dir, id);
      const chunks = Math.ceil(size / chunkSize);
      const now = Date.now();
      const share = {
        id, room, file, mime, size, chunks,
        name: cleanName(b.name) || filename, filename,
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        received: new Uint8Array(chunks), count: 0, bytes: 0, done: false, gone: false,
        created: now, lastLive: now, inflight: new Set(), waiters: new Set()
      };
      shares.set(id, share);                                           // reserve before the async create
      try { await fsp.writeFile(file, "", { flag: "wx" }); }
      catch (e) { shares.delete(id); return fail(res, 500, "create_failed"); }
      const upToken = token(id, "up"), viewToken = token(id, "view");
      res.setHeader("Cache-Control", "no-store");
      res.json({ id, chunkSize, chunks, upToken, viewToken, url: "/share/" + id + "/file?t=" + viewToken, mime, size });
    } catch (e) { fail(res, 500, "init_failed"); }
  });

  /* PUT /share/:id/chunk/:n?t=upToken — body streamed straight to disk at n*chunkSize */
  router.put("/:id/chunk/:n", (req, res) => {
    corsAll(req, res);
    if (!chunkLimiter(clientIp(req))) return tooMany(res);
    const share = lookup(req, res); if (!share) return;
    if (!tokenOk(share, "up", givenToken(req))) return fail(res, 403, "forbidden");
    const n = /^\d{1,9}$/.test(String(req.params.n)) ? parseInt(req.params.n, 10) : -1;
    if (n < 0 || n >= share.chunks) return fail(res, 400, "bad_chunk");
    const expected = chunkLen(share, n);
    const cl = req.headers["content-length"];
    if (cl != null && Number(cl) !== expected) return fail(res, 400, "bad_length", { expected });
    res.setHeader("Cache-Control", "no-store");
    if (share.received[n]) {                                           // idempotent retry: keep the bytes we already have
      req.resume();
      return res.json({ ok: true, already: true, bytes: share.bytes, done: share.done });
    }
    if (share.inflight.has(n)) return fail(res, 409, "chunk_in_progress");
    share.inflight.add(n);
    let count = 0;
    const counter = new Transform({
      transform(c, enc, cb) {
        count += c.length;
        if (count > expected) { const err = new Error("too_long"); err.code = "TOO_LONG"; return cb(err); }
        cb(null, c);
      }
    });
    const out = fs.createWriteStream(share.file, { flags: "r+", start: n * chunkSize });
    pipeline(req, counter, out, err => {
      share.inflight.delete(n);
      if (err) return fail(res, 400, err.code === "TOO_LONG" ? "bad_length" : "upload_interrupted", { expected });
      if (count !== expected) return fail(res, 400, "bad_length", { expected, got: count });
      if (share.gone) return fail(res, 404, "not_found");
      if (!share.received[n]) {
        share.received[n] = 1; share.count++; share.bytes += expected;
        if (share.count === share.chunks) share.done = true;
        wake(share);
        safeBroadcast(share.room, { type: "share-prog", id: share.id, bytes: share.bytes, size: share.size, done: share.done });
      }
      res.json({ ok: true, bytes: share.bytes, done: share.done });
    });
  });

  /* GET /share/:id/status?t=upToken — which chunks are already safe on the server (resume) */
  router.get("/:id/status", (req, res) => {
    corsAll(req, res);
    if (!metaLimiter(clientIp(req))) return tooMany(res);
    const share = lookup(req, res); if (!share) return;
    if (!tokenOk(share, "up", givenToken(req))) return fail(res, 403, "forbidden");
    const received = [];
    for (let i = 0; i < share.chunks; i++) if (share.received[i]) received.push(i);
    res.setHeader("Cache-Control", "no-store");
    res.json({ received, done: share.done, bytes: share.bytes, size: share.size, chunks: share.chunks, chunkSize });
  });

  function pump(res, file, start, end) {
    return new Promise((resolve, reject) => {
      if (res.destroyed) return reject(new Error("client_closed"));
      const rs = fs.createReadStream(file, { start, end });
      const onClose = () => { rs.destroy(); reject(new Error("client_closed")); };
      res.on("close", onClose);
      rs.on("error", err => { res.off("close", onClose); rs.unpipe(res); reject(err); });
      rs.on("end", () => { res.off("close", onClose); resolve(); });
      rs.pipe(res, { end: false });
    });
  }

  /* GET|HEAD /share/:id/file?t=viewToken — Range-capable; waits for chunks still being uploaded */
  router.get("/:id/file", async (req, res) => {
    corsAll(req, res);
    if (!readLimiter(clientIp(req))) return tooMany(res);
    const share = lookup(req, res); if (!share) return;
    if (!tokenOk(share, "view", givenToken(req))) return fail(res, 403, "forbidden");
    const size = share.size;
    const range = parseRange(req.headers.range, size);
    if (range && range.unsatisfiable) {
      res.setHeader("Content-Range", "bytes */" + size);
      return fail(res, 416, "range_not_satisfiable");
    }
    const start = range ? range.start : 0, end = range ? range.end : size - 1;
    const isHead = req.method === "HEAD";

    if (!isHead && !share.received[Math.floor(start / chunkSize)]) {
      const ok = await waitChunk(share, Math.floor(start / chunkSize), res);
      if (res.destroyed || res.headersSent) return;
      if (!ok) {
        if (share.gone) return fail(res, 404, "not_found");
        res.setHeader("Retry-After", "5");
        return fail(res, 503, "not_uploaded_yet");
      }
    }

    res.setHeader("Content-Type", share.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    if (range) { res.status(206); res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + size); }
    else res.status(200);
    if (isHead) return res.end();

    try {
      const lastIdx = Math.floor(end / chunkSize);
      let pos = start;
      while (pos <= end) {
        const idx = Math.floor(pos / chunkSize);
        if (!share.received[idx] && !(await waitChunk(share, idx, res))) { res.destroy(); return; }   // stalled upload → truncate; the player re-requests
        let run = idx;
        while (run < lastIdx && share.received[run + 1]) run++;        // stream the whole contiguous run in one read
        const segEnd = Math.min(end, (run + 1) * chunkSize - 1);
        await pump(res, share.file, pos, segEnd);
        pos = segEnd + 1;
      }
      res.end();
    } catch (e) { if (!res.destroyed) res.destroy(); }
  });

  /* DELETE /share/:id?t=upToken — presenter withdraws the file for everyone */
  router.delete("/:id", (req, res) => {
    corsAll(req, res);
    if (!metaLimiter(clientIp(req))) return tooMany(res);
    const share = lookup(req, res); if (!share) return;
    if (!tokenOk(share, "up", givenToken(req))) return fail(res, 403, "forbidden");
    removeShare(share, "deleted");
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  router.use((err, req, res, next) => {                                // bad JSON / oversized init body
    corsAll(req, res);
    if (err && (err.type === "entity.too.large" || err.status === 413)) return fail(res, 413, "body_too_large");
    if (err && (err.type === "entity.parse.failed" || err.status === 400)) return fail(res, 400, "bad_json");
    fail(res, 500, "server_error");
  });

  /* ---- cleanup: hard TTL, plus a shorter grace once the room is no longer live ---- */
  function sweep(now) {
    now = now || Date.now();
    for (const share of Array.from(shares.values())) {
      let live = false; try { live = !!roomLive(share.room); } catch (e) { live = false; }
      if (live) share.lastLive = now;
      if (now - share.created > ttlMs) removeShare(share, "expired");
      else if (now - share.lastLive > emptyRoomTtlMs) removeShare(share, "room_empty");
    }
  }
  const sweepTimer = setInterval(sweep, sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  function stats() {
    let bytesReserved = 0, bytesReceived = 0, uploading = 0, waiting = 0;
    shares.forEach(s => { bytesReserved += s.size; bytesReceived += s.bytes; if (!s.done) uploading++; waiting += s.waiters.size; });
    return { shares: shares.size, uploading, bytesReserved, bytesReceived, waiting, dir };
  }
  function close() {
    clearInterval(sweepTimer);
    shares.forEach(s => { for (const w of Array.from(s.waiters)) w.finish(false); });
  }

  return { router, stats, close, sweep };
}

module.exports = { createShareUpload };
