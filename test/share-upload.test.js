"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createShareUpload } = require("../server/share-upload");

const CHUNK = 64 * 1024;
const ROOM = "ROOM1";
const KEY = "good-key";

function makeLimiter() { return () => true; }

async function startServer(t, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-share-"));
  const live = new Set([ROOM]);
  const messages = [];
  const share = createShareUpload(Object.assign({
    dir,
    wallAllowed: (room, k) => room === ROOM && k === KEY,
    roomLive: room => live.has(room),
    broadcast: (room, msg) => messages.push({ room, msg }),
    clientIp: req => req.socket.remoteAddress,
    makeLimiter,
    cors: (req, res) => res.setHeader("Access-Control-Allow-Origin", "*"),
    chunkSize: CHUNK,
    maxBytes: 1024 * 1024,
    roomMaxBytes: 1536 * 1024,
    minFreeBytes: 0,
    waitMs: 1000
  }, extra || {}));
  const app = express();
  app.use("/share", share.router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    share.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, dir, live, messages, share };
}

function init(base, body) {
  return fetch(base + "/share/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function putChunk(base, info, n, buf, token) {
  return fetch(base + "/share/" + info.id + "/chunk/" + n + "?t=" + (token || info.upToken), {
    method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: buf
  });
}
function slice(data, n) { return data.subarray(n * CHUNK, Math.min(data.length, (n + 1) * CHUNK)); }
function testData(len) { return Buffer.from(Uint8Array.from({ length: len }, (_, i) => (i * 31 + (i >> 8)) & 255)); }

test("init rejects a wrong room key, a room that is not live, bad types and oversized files", async t => {
  const { base } = await startServer(t);
  let r = await init(base, { room: ROOM, k: "nope", size: 1000, mime: "video/mp4" });
  assert.equal(r.status, 403);
  r = await init(base, { room: "OTHER", k: KEY, size: 1000, mime: "video/mp4" });
  assert.equal(r.status, 403);
  r = await init(base, { room: ROOM, k: KEY, size: 2 * 1024 * 1024, mime: "video/mp4" });
  assert.equal(r.status, 413);
  r = await init(base, { room: ROOM, k: KEY, size: 1000, mime: "text/html", filename: "x.html" });
  assert.equal(r.status, 415);
  r = await init(base, { room: ROOM, k: KEY, size: 0, mime: "video/mp4" });
  assert.equal(r.status, 400);
});

test("room quota and non-live rooms are enforced", async t => {
  const { base, live } = await startServer(t);
  const a = await init(base, { room: ROOM, k: KEY, size: 1024 * 1024, mime: "video/mp4" });
  assert.equal(a.status, 200);
  const b = await init(base, { room: ROOM, k: KEY, size: 1024 * 1024, mime: "video/mp4" });
  assert.equal(b.status, 413);
  assert.equal((await b.json()).error, "room_quota");
  live.delete(ROOM);
  const c = await init(base, { room: ROOM, k: KEY, size: 100, mime: "video/mp4" });
  assert.equal(c.status, 404);
});

test("empty or unknown MIME types are normalised from the file extension", async t => {
  const { base } = await startServer(t);
  const r = await init(base, { room: ROOM, k: KEY, size: 500, mime: "", filename: "IMG_0001.MOV" });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.mime, "video/quicktime");
  assert.equal(info.chunks, 1);
  assert.match(info.id, /^[0-9a-f]{32}$/);
  assert.equal(info.url, "/share/" + info.id + "/file?t=" + info.viewToken);
});

test("chunked upload in any order, retries, status, Range reads and waiting for missing bytes", async t => {
  const { base, messages } = await startServer(t);
  const data = testData(CHUNK * 3 + 1000);                          // 4 chunks, the last one short
  const r = await init(base, { room: ROOM, k: KEY, name: "Holiday", filename: "holiday.mp4", size: data.length, mime: "video/mp4", duration: 12.5 });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.chunks, 4);
  assert.equal(info.chunkSize, CHUNK);

  // out of order: 2, 0, 3 (short last chunk)
  for (const n of [2, 0, 3]) {
    const p = await putChunk(base, info, n, slice(data, n));
    assert.equal(p.status, 200, "chunk " + n);
  }
  // retried chunk is idempotent
  const again = await putChunk(base, info, 0, slice(data, 0));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).already, true);
  // wrong length is rejected and not marked as received
  const wrong = await putChunk(base, info, 1, slice(data, 1).subarray(0, 100));
  assert.equal(wrong.status, 400);
  // out-of-range chunk index
  assert.equal((await putChunk(base, info, 4, Buffer.alloc(10))).status, 400);

  let st = await (await fetch(base + "/share/" + info.id + "/status?t=" + info.upToken)).json();
  assert.deepEqual(st.received, [0, 2, 3]);
  assert.equal(st.done, false);

  // a Range inside an uploaded chunk returns exactly those bytes
  const fileUrl = base + info.url;
  const part = await fetch(fileUrl, { headers: { Range: "bytes=" + (CHUNK * 2 + 10) + "-" + (CHUNK * 2 + 5009) } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes " + (CHUNK * 2 + 10) + "-" + (CHUNK * 2 + 5009) + "/" + data.length);
  assert.equal(part.headers.get("content-type"), "video/mp4");
  assert.equal(part.headers.get("x-content-type-options"), "nosniff");
  assert.equal(part.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(part.headers.get("accept-ranges"), "bytes");
  assert.equal(part.headers.get("cache-control"), "private, max-age=3600");
  assert.match(part.headers.get("access-control-expose-headers"), /Content-Range/);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), data.subarray(CHUNK * 2 + 10, CHUNK * 2 + 5010));

  // suffix range (last 100 bytes) lives in the uploaded short last chunk
  const tail = await fetch(fileUrl, { headers: { Range: "bytes=-100" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), data.subarray(data.length - 100));

  // a range spanning the missing chunk 1 waits, then succeeds once it arrives
  const spanStart = CHUNK - 50, spanEnd = CHUNK * 2 + 50;
  const t0 = Date.now();
  const pending = fetch(fileUrl, { headers: { Range: "bytes=" + spanStart + "-" + spanEnd } });
  await new Promise(resolve => setTimeout(resolve, 300));
  const late = await putChunk(base, info, 1, slice(data, 1));
  assert.equal(late.status, 200);
  assert.equal((await late.json()).done, true);
  const spanned = await pending;
  assert.equal(spanned.status, 206);
  assert.deepEqual(Buffer.from(await spanned.arrayBuffer()), data.subarray(spanStart, spanEnd + 1));
  assert.ok(Date.now() - t0 >= 250, "the read waited for the upload");

  st = await (await fetch(base + "/share/" + info.id + "/status?t=" + info.upToken)).json();
  assert.deepEqual(st.received, [0, 1, 2, 3]);
  assert.equal(st.done, true);

  // whole file without Range → 200 and identical bytes; HEAD → headers only
  const whole = await fetch(fileUrl);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), String(data.length));
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), data);
  const head = await fetch(fileUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(data.length));

  // unsatisfiable range
  const bad = await fetch(fileUrl, { headers: { Range: "bytes=" + data.length + "-" } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), "bytes */" + data.length);

  // progress was broadcast to the room after every new chunk, finishing with done
  const prog = messages.filter(m => m.msg.type === "share-prog" && m.msg.id === info.id);
  assert.equal(prog.length, 4);
  assert.ok(prog.every(m => m.room === ROOM && m.msg.size === data.length));
  assert.deepEqual(prog[prog.length - 1].msg, { type: "share-prog", id: info.id, bytes: data.length, size: data.length, done: true });
});

test("a read of bytes that never arrive returns 503 with Retry-After", async t => {
  const { base } = await startServer(t);
  const info = await (await init(base, { room: ROOM, k: KEY, size: CHUNK * 2, mime: "video/webm" })).json();
  const r = await fetch(base + info.url, { headers: { Range: "bytes=0-99" } });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "5");
});

test("tokens are checked per capability (upload vs view)", async t => {
  const { base } = await startServer(t);
  const info = await (await init(base, { room: ROOM, k: KEY, size: 1000, mime: "image/jpeg" })).json();
  assert.equal((await putChunk(base, info, 0, Buffer.alloc(1000), info.viewToken)).status, 403);
  assert.equal((await putChunk(base, info, 0, Buffer.alloc(1000), "0".repeat(32))).status, 403);
  assert.equal((await fetch(base + "/share/" + info.id + "/status?t=" + info.viewToken)).status, 403);
  assert.equal((await fetch(base + "/share/" + info.id + "/file?t=" + info.upToken)).status, 403);
  assert.equal((await fetch(base + "/share/" + info.id + "?t=" + info.viewToken, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(base + "/share/" + "f".repeat(32) + "/file?t=" + info.viewToken)).status, 404);
});

test("delete removes the file for everyone and announces it", async t => {
  const { base, dir, messages, share } = await startServer(t);
  const info = await (await init(base, { room: ROOM, k: KEY, size: 1000, mime: "video/mp4" })).json();
  assert.equal((await putChunk(base, info, 0, Buffer.alloc(1000, 7))).status, 200);
  assert.ok(fs.existsSync(path.join(dir, info.id)));
  const del = await fetch(base + "/share/" + info.id + "?t=" + info.upToken, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await fetch(base + info.url)).status, 404);
  assert.equal((await fetch(base + "/share/" + info.id + "/status?t=" + info.upToken)).status, 404);
  assert.ok(messages.some(m => m.msg.type === "share-gone" && m.msg.id === info.id));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(dir, info.id)), false);
  assert.equal(share.stats().shares, 0);
});

test("startup purges only our own leftovers and the sweep expires empty rooms", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-share-purge-"));
  const stale = path.join(dir, "a".repeat(32));
  const keep = path.join(dir, "README.txt");
  fs.writeFileSync(stale, "old");
  fs.writeFileSync(keep, "not ours");
  const { base, live, share } = await startServer(t, { dir, emptyRoomTtlMs: 1000 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(keep), true);

  const info = await (await init(base, { room: ROOM, k: KEY, size: 1000, mime: "video/mp4" })).json();
  share.sweep(Date.now() + 5000);                                     // room still live → kept
  assert.equal(share.stats().shares, 1);
  live.delete(ROOM);
  share.sweep(Date.now() + 5500);                                     // within the grace after it was last seen live → kept
  assert.equal(share.stats().shares, 1);
  share.sweep(Date.now() + 10000);                                    // room gone longer than the grace → removed
  assert.equal(share.stats().shares, 0);
  assert.equal((await fetch(base + info.url)).status, 404);
});
