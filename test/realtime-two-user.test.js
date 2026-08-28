"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");

function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }
    ws.on("message", onMessage);
  });
}

function waitForMessageWhere(ws, predicate, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeout);
    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }
    ws.on("message", onMessage);
  });
}

function expectNoMessageWhere(ws, predicate, label, timeout = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, timeout);
    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(new Error(`Unexpected ${label}`));
    }
    ws.on("message", onMessage);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function rawGet(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: requestPath, headers }, res => {
      res.resume();
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.once("error", reject);
  });
}

function startServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ADMIN_PASSWORD: "qa-only" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Server did not start:\n${output}`));
    }, 30000);   // test files run in parallel; a cold Node + SQLite start can be slow under that load
    function inspect(chunk) {
      output += String(chunk);
      if (!output.includes(`SameCouch server on :${port}`)) return;
      clearTimeout(timer);
      resolve(child);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", code => {
      if (!output.includes(`SameCouch server on :${port}`)) {
        clearTimeout(timer);
        reject(new Error(`Server exited with ${code}:\n${output}`));
      }
    });
  });
}

test("participants relay playback, fast transfer, queue, moments, subtitles, and chat", async t => {
  const port = 19000 + (process.pid % 1000);
  const dbPath = path.join(os.tmpdir(), `samecouch-qa-${process.pid}.db`);
  const server = await startServer(port, dbPath);
  const sockets = [];
  t.after(() => {
    sockets.forEach(ws => { try { ws.close(); } catch (_) {} });
    server.kill("SIGTERM");
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
    }
  });

  const url = `ws://127.0.0.1:${port}/rt`;
  const room = `qa-${Date.now()}`;
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /id="ld_name"[^>]*\brequired\b/);
  const wwwRedirect = await rawGet(port, "/privacy.html?from=qa", { host: "www.samecouch.com" });
  assert.equal(wwwRedirect.status, 308);
  assert.equal(wwwRedirect.headers.location, "https://samecouch.com/privacy.html?from=qa");
  const swResponse = await fetch(`http://127.0.0.1:${port}/sw.js`);
  assert.equal(swResponse.status, 200);
  assert.match(swResponse.headers.get("content-type") || "", /javascript/);
  assert.match(swResponse.headers.get("cache-control") || "", /no-cache/);

  const appResponse = await fetch(`http://127.0.0.1:${port}/samecouch-app-v3.js`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(appResponse.status, 200);
  assert.match(appResponse.headers.get("cache-control") || "", /no-cache/);
  assert.equal(appResponse.headers.get("content-encoding"), "gzip");

  const speedDown = await fetch(`http://127.0.0.1:${port}/speed-test?bytes=65536`);
  assert.equal(speedDown.status, 200);
  assert.equal((await speedDown.arrayBuffer()).byteLength, 65536);
  assert.match(speedDown.headers.get("cache-control") || "", /no-store/);
  assert.equal(speedDown.headers.get("content-encoding"), null);
  const uploadBytes = Buffer.alloc(192 * 1024, 0x51);
  const speedUp = await fetch(`http://127.0.0.1:${port}/speed-test`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: uploadBytes
  });
  assert.equal(speedUp.status, 200);
  assert.deepEqual(await speedUp.json(), { ok: true, bytes: uploadBytes.length });

  const host = await openSocket(url); sockets.push(host);
  const hostRoster = waitForMessage(host, "roster");
  host.send(JSON.stringify({ type: "join", room, name: "Host QA", peerId: "hostqa" }));
  await hostRoster;

  const guest = await openSocket(url); sockets.push(guest);
  const guestRoster = waitForMessage(guest, "roster");
  const joined = waitForMessage(host, "peer-joined");
  guest.send(JSON.stringify({ type: "join", room, name: "Guest QA", peerId: "guestqa" }));
  const [roster, arrival] = await Promise.all([guestRoster, joined]);
  assert.equal(arrival.name, "Guest QA");
  assert.ok(roster.peers.some(peer => peer.name === "Host QA"));

  const queueHost = waitForMessage(host, "queue-state");
  const queueGuest = waitForMessage(guest, "queue-state");
  host.send(JSON.stringify({ type: "queue-add", title: "Friday pick", url: "https://youtu.be/dQw4w9WgXcQ" }));
  const [hostQueue, guestQueue] = await Promise.all([queueHost, queueGuest]);
  assert.equal(hostQueue.items.length, 1);
  assert.equal(guestQueue.items[0].title, "Friday pick");
  assert.equal(guestQueue.items[0].votes.length, 1);
  const queueId = guestQueue.items[0].id;

  const votedHost = waitForMessage(host, "queue-state");
  const votedGuest = waitForMessage(guest, "queue-state");
  guest.send(JSON.stringify({ type: "queue-vote", id: queueId }));
  const [, voted] = await Promise.all([votedHost, votedGuest]);
  assert.equal(voted.items[0].votes.length, 2);

  const reactionPromise = waitForMessage(guest, "reaction");
  host.send(JSON.stringify({ type: "reaction", emoji: "❤️", time: 42.25 }));
  const reaction = await reactionPromise;
  assert.equal(reaction.time, 42.25);
  assert.ok(reaction.highlightId);

  const momentPromise = waitForMessage(host, "highlight-add");
  guest.send(JSON.stringify({ type: "moment-save", time: 87.5, label: "Best scene" }));
  const moment = await momentPromise;
  assert.equal(moment.item.kind, "moment");
  assert.equal(moment.item.time, 87.5);

  const queuePlayPromise = waitForMessage(guest, "queue-play");
  host.send(JSON.stringify({ type: "queue-play", id: queueId }));
  const queuedPlay = await queuePlayPromise;
  assert.equal(queuedPlay.item.url, "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(queuedPlay.from, "hostqa");

  const syncPromise = waitForMessage(host, "sync");
  guest.send(JSON.stringify({ type: "sync", kind: "play", time: 12.5, playing: true }));
  const sync = await syncPromise;
  assert.equal(sync.kind, "play");
  assert.equal(sync.time, 12.5);
  assert.equal(sync.seq, 1);
  assert.ok(Number.isFinite(sync.serverAt));

  const rejectedGuestHeartbeat = expectNoMessageWhere(host,
    message => message.type === "sync" && message.kind === "heartbeat",
    "guest heartbeat relay");
  guest.send(JSON.stringify({ type: "sync", kind: "heartbeat", time: 13, playing: true }));
  await rejectedGuestHeartbeat;

  const hostHeartbeatPromise = waitForMessageWhere(guest,
    message => message.type === "sync" && message.kind === "heartbeat",
    "host heartbeat");
  host.send(JSON.stringify({ type: "sync", kind: "heartbeat", time: 13.25, playing: true }));
  const hostHeartbeat = await hostHeartbeatPromise;
  assert.equal(hostHeartbeat.from, "hostqa");
  assert.equal(hostHeartbeat.time, 13.25);
  assert.equal(hostHeartbeat.seq, 2);

  const rejectedGuestBuffering = expectNoMessageWhere(host,
    message => message.type === "sync" && message.kind === "buffering",
    "guest buffering relay");
  guest.send(JSON.stringify({ type: "sync", kind: "buffering", time: 13.25, playing: true }));
  await rejectedGuestBuffering;

  const hostBufferingPromise = waitForMessageWhere(guest,
    message => message.type === "sync" && message.kind === "buffering",
    "host buffering state");
  host.send(JSON.stringify({ type: "sync", kind: "buffering", time: 13.5, playing: true }));
  const hostBuffering = await hostBufferingPromise;
  assert.equal(hostBuffering.seq, 3);
  assert.equal(hostBuffering.from, "hostqa");

  const readyPromise = waitForMessage(host, "gallery-ready");
  guest.send(JSON.stringify({ type: "gallery-ready", fileId: "film-1" }));
  const ready = await readyPromise;
  assert.equal(ready.from, "guestqa");
  assert.equal(ready.fileId, "film-1");

  const progressPromise = waitForMessage(host, "gallery-prog");
  guest.send(JSON.stringify({ type: "gallery-prog", pct: 23, speed: 2500000, eta: 41, paused: true }));
  const progress = await progressPromise;
  assert.equal(progress.pct, 23);
  assert.equal(progress.speed, 2500000);
  assert.equal(progress.eta, 41);
  assert.equal(progress.paused, true);

  const failurePromise = waitForMessage(host, "gallery-fail");
  guest.send(JSON.stringify({ type: "gallery-fail" }));
  const failure = await failurePromise;
  assert.equal(failure.from, "guestqa");

  const videoUrl = "https://media.example.test/movie.mkv";
  const providerSubtitles = [{ name: "Provider NL", lang: "nl", url: "https://media.example.test/subtitles.nl.vtt" }];
  const videoPromise = waitForMessage(guest, "video");
  host.send(JSON.stringify({ type: "video", mode: "mkv", url: videoUrl, id: "", title: "IPTV Film", live: false, iptvSubtitles: providerSubtitles }));
  const relayedVideo = await videoPromise;
  assert.equal(relayedVideo.url, videoUrl);
  assert.equal(relayedVideo.mode, "mkv");
  assert.equal(relayedVideo.title, "IPTV Film");
  assert.deepEqual(relayedVideo.iptvSubtitles, providerSubtitles);

  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n" + "Movie night!\n".repeat(24000);
  assert.ok(Buffer.byteLength(vtt) > 256 * 1024, "subtitle regression payload must exceed the old WebSocket limit");
  const subtitlePromise = waitForMessage(guest, "subtitle");
  host.send(JSON.stringify({ type: "subtitle", url: videoUrl, name: "movie.nl.srt", lang: "nl", vtt }));
  const subtitle = await subtitlePromise;
  assert.equal(subtitle.name, "movie.nl.srt");
  assert.equal(subtitle.lang, "nl");
  assert.equal(subtitle.vtt, vtt);

  const late = await openSocket(url); sockets.push(late);
  const lateRoster = waitForMessage(late, "roster");
  const lateVideo = waitForMessage(late, "video");
  const lateSubtitle = waitForMessage(late, "subtitle");
  late.send(JSON.stringify({ type: "join", room, name: "Late QA", peerId: "lateqa" }));
  const lateState = await lateRoster;
  assert.equal(lateState.queue.length, 1);
  assert.ok(lateState.highlights.some(item => item.kind === "reaction" && item.time === 42.25));
  assert.ok(lateState.highlights.some(item => item.kind === "moment" && item.time === 87.5));
  const lateMedia = await lateVideo;
  assert.equal(lateMedia.url, videoUrl);
  assert.equal(lateMedia.title, "IPTV Film");
  assert.deepEqual(lateMedia.iptvSubtitles, providerSubtitles);
  assert.equal((await lateSubtitle).vtt, vtt);

  const chatPromise = waitForMessage(guest, "chat");
  host.send(JSON.stringify({ type: "chat", text: "UX regression" }));
  const chat = await chatPromise;
  assert.equal(chat.from, "Host QA");
  assert.equal(chat.text, "UX regression");

  const permissions = pageResponse.headers.get("permissions-policy") || "";
  const csp = pageResponse.headers.get("content-security-policy") || "";
  assert.match(permissions, /screen-wake-lock=\(self\)/);
  assert.match(csp, /media-src[^;]*https:/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
});
