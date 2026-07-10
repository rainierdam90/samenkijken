"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
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
    }, 8000);
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

test("participants relay playback, progressive transfer, subtitles, and chat", async t => {
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
  const swResponse = await fetch(`http://127.0.0.1:${port}/sw.js`);
  assert.equal(swResponse.status, 200);
  assert.match(swResponse.headers.get("content-type") || "", /javascript/);

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

  const syncPromise = waitForMessage(host, "sync");
  guest.send(JSON.stringify({ type: "sync", kind: "play", time: 12.5, playing: true }));
  const sync = await syncPromise;
  assert.equal(sync.kind, "play");
  assert.equal(sync.time, 12.5);

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
  const videoPromise = waitForMessage(guest, "video");
  host.send(JSON.stringify({ type: "video", mode: "mkv", url: videoUrl, id: "" }));
  const relayedVideo = await videoPromise;
  assert.equal(relayedVideo.url, videoUrl);
  assert.equal(relayedVideo.mode, "mkv");

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
  await lateRoster;
  assert.equal((await lateVideo).url, videoUrl);
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
});
