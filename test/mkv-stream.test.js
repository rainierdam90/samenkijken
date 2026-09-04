"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
let bundledFfmpeg = "";
try { bundledFfmpeg = require("ffmpeg-static"); } catch (_) {}
const FFMPEG = process.env.FFMPEG_PATH || bundledFfmpeg || "/usr/bin/ffmpeg";
const FFMPEG_OK = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startApp(port, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/server.js"], {
      cwd: ROOT,
      env: { ...process.env, ...env, PORT: String(port), ADMIN_PASSWORD: "qa-only" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Server did not start:\n" + output));
    }, 30000);   // test files run in parallel; a cold Node + ffmpeg probe can be slow under that load
    function inspect(chunk) {
      output += String(chunk);
      if (!output.includes("SameCouch server on :" + port)) return;
      clearTimeout(timer); resolve(child);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", code => {
      if (!output.includes("SameCouch server on :" + port)) {
        clearTimeout(timer); reject(new Error("Server exited with " + code + ":\n" + output));
      }
    });
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws)); ws.once("error", reject);
  });
}

function waitForMessage(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error("Timed out waiting for " + type)); }, timeoutMs || 5000);
    function onMessage(raw) {
      let message; try { message = JSON.parse(raw); } catch (_) { return; }
      if (message.type !== type) return;
      clearTimeout(timer); ws.off("message", onMessage); resolve(message);
    }
    ws.on("message", onMessage);
  });
}

test("opaque and redirected MKV sources are remuxed to fragmented browser MP4", { skip: !FFMPEG_OK }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "samecouch-mkv-"));
  const fixture = path.join(temp, "fixture.mkv");
  const dbPath = path.join(temp, "qa.db");

  const made = spawnSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1.2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "ac3", "-b:a", "192k", "-f", "matroska", fixture
  ], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr || "could not create MKV fixture");

  const source = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/opaque-download?ticket=qa" }); res.end(); return; }
    if (req.url === "/opaque-download?ticket=qa") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(fixture).size });
      fs.createReadStream(fixture).pipe(res); return;
    }
    res.writeHead(404); res.end();
  });
  const sourcePort = await listen(source);
  t.after(() => new Promise(resolve => source.close(resolve)));

  const appPort = await freePort();
  const app = await startApp(appPort, {
    DB_PATH: dbPath,
    FFMPEG_PATH: FFMPEG,
    MKV_ALLOWED_PORTS: String(sourcePort),
    MKV_TRUSTED_PRIVATE_HOSTS: "127.0.0.1"
  });
  t.after(async () => {
    if (app.exitCode === null) { app.kill("SIGTERM"); await once(app, "exit").catch(() => {}); }
  });
  // Register filesystem cleanup after servers so Windows no longer sees an open
  // SQLite/stream handle when removing the temporary directory.
  t.after(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); return; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  });

  const base = "http://127.0.0.1:" + appPort;
  const config = await (await fetch(base + "/config")).json();
  assert.equal(config.hasMkv, true);
  assert.equal(config.mkvMode, "remux-aac");

  const opaqueSource = "http://127.0.0.1:" + sourcePort + "/redirect";
  const preparedResponse = await fetch(base + "/mkv-prepare?url=" + encodeURIComponent(opaqueSource));
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.match(prepared.streamPath, /^\/mkv-stream\?token=/);

  const streamUrl = new URL(prepared.streamPath, base);
  const streamResponse = await fetch(streamUrl);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") || "", /video\/mp4/);
  const mp4 = Buffer.from(await streamResponse.arrayBuffer());
  assert.ok(mp4.length > 2000, "remuxed stream is unexpectedly small");
  assert.ok(mp4.includes(Buffer.from("ftyp")), "MP4 ftyp box is missing");
  assert.ok(mp4.includes(Buffer.from("moov")), "MP4 moov box is missing");
  assert.ok(mp4.includes(Buffer.from("moof")), "fragmented MP4 moof box is missing");
  assert.ok(mp4.includes(Buffer.from("avc1")), "H.264 video track is missing");
  assert.ok(mp4.includes(Buffer.from("mp4a")), "AAC audio track is missing");
  const remuxed = path.join(temp, "remuxed.mp4");
  fs.writeFileSync(remuxed, mp4);
  const audible = spawnSync(FFMPEG, [
    "-hide_banner", "-i", remuxed, "-map", "0:a:0", "-t", "0.5",
    "-af", "volumedetect", "-f", "null", "-"
  ], { encoding: "utf8" });
  assert.equal(audible.status, 0, audible.stderr || "could not decode remuxed audio");
  const volume = (audible.stderr || "").match(/mean_volume:\s*(-?[\d.]+) dB/);
  assert.ok(volume && Number(volume[1]) > -80, "remuxed AAC audio is silent");

  const token = streamUrl.searchParams.get("token");
  const tokenParts = token.split("."), signature = tokenParts[1];
  streamUrl.searchParams.set("token", tokenParts[0] + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1));
  assert.equal((await fetch(streamUrl)).status, 403);
});

test("IPTV remux is credential-opaque, room-wide, audible for AC-3 and H.264-compatible for HEVC", { skip: !FFMPEG_OK }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "samecouch-iptv-remux-"));
  const liveFile = path.join(temp, "live.ts"), hevcFile = path.join(temp, "hevc.mp4"), dbPath = path.join(temp, "qa.db");
  const liveMade = spawnSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=12",
    "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000",
    "-t", "1.5", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "ac3", "-b:a", "128k", "-f", "mpegts", liveFile
  ], { encoding: "utf8" });
  assert.equal(liveMade.status, 0, liveMade.stderr || "could not create AC-3 live fixture");
  const hevcMade = spawnSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=12",
    "-f", "lavfi", "-i", "sine=frequency=659:sample_rate=48000",
    "-t", "1.5", "-shortest", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
    "-c:a", "ac3", "-b:a", "128k", "-f", "mp4", hevcFile
  ], { encoding: "utf8" });
  assert.equal(hevcMade.status, 0, hevcMade.stderr || "could not create HEVC fixture");

  let providerPort = 0;
  const seen = [], seenRequests = [];
  let interruptedLiveRequests = 0;
  function sendFile(req, res, file, contentType) {
    const stat = fs.statSync(file); let start = 0, end = stat.size - 1;
    const match = String(req.headers.range || "").match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      start = Math.min(end, Number(match[1])); if (match[2]) end = Math.min(end, Number(match[2]));
      res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Type", contentType); res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(file, { start, end }).pipe(res);
  }
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:" + providerPort); seen.push(url.pathname);
    seenRequests.push({ path:url.pathname, range:String(req.headers.range || ""), userAgent:String(req.headers["user-agent"] || "") });
    const json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/player_api.php") {
      if (url.searchParams.get("username") !== "demo" || url.searchParams.get("password") !== "secret") { res.statusCode = 401; return res.end(); }
      const action = url.searchParams.get("action");
      if (!action) return json({ user_info: { auth: 1, status: "Active", exp_date: "1999999999" } });
      if (action === "get_live_categories") return json([{ category_id: "1", category_name: "Live" }]);
      if (action === "get_vod_categories") return json([{ category_id: "2", category_name: "Movies" }]);
      if (action === "get_series_categories" || action === "get_series") return json([]);
      if (action === "get_live_streams") return json([{ stream_id: 10, name: "AC3 Live", category_id: "1" }]);
      if (action === "get_vod_streams") return json([{ stream_id: 20, name: "HEVC Film", category_id: "2", container_extension: "mp4" }]);
      if (action === "get_vod_info") return json({ info: {} });
      return json([]);
    }
    if (url.pathname === "/live/demo/secret/10.ts") {
      interruptedLiveRequests++;
      if (interruptedLiveRequests === 1) {
        /* Real Xtream edges sometimes announce a huge finite body but drop the socket after a
           short live burst. The gateway must reconnect its private FFmpeg feed instead of ending
           the room stream and sending every viewer back into buffering. */
        const body = fs.readFileSync(liveFile), cutoff = Math.max(188, Math.floor(body.length / 3 / 188) * 188);
        res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": String(body.length * 20) });
        res.write(body.subarray(0, cutoff), () => res.socket.destroy());
        return;
      }
      return sendFile(req, res, liveFile, "video/mp2t");
    }
    if (url.pathname === "/movie/demo/secret/20.mp4") return sendFile(req, res, hevcFile, "video/mp4");
    res.statusCode = 404; res.end();
  });
  providerPort = await listen(provider);

  const appPort = await freePort();
  const app = await startApp(appPort, {
    DB_PATH: dbPath, FFMPEG_PATH: FFMPEG,
    IPTV_ALLOWED_PORTS: String(providerPort), IPTV_TRUSTED_PRIVATE_HOSTS: "127.0.0.1",
    MKV_ALLOWED_PORTS: String(providerPort), MKV_TRUSTED_PRIVATE_HOSTS: "127.0.0.1",
    MKV_MAX_STREAMS_PER_IP: "3"
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(ws => { try { ws.close(); } catch (_) {} });
    if (app.exitCode === null) { app.kill("SIGTERM"); await once(app, "exit").catch(() => {}); }
    await new Promise(resolve => provider.close(resolve));
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  });

  const base = "http://127.0.0.1:" + appPort, wsBase = "ws://127.0.0.1:" + appPort + "/rt", room = "iptv-remux-qa";
  const host = await openSocket(wsBase); sockets.push(host);
  const rosterPromise = waitForMessage(host, "roster");
  host.send(JSON.stringify({ type: "join", room, name: "Host", peerId: "host" }));
  const roster = await rosterPromise;
  const connected = await (await fetch(base + "/iptv/connect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "xtream", room, roomKey: roster.wallKey, server: "http://127.0.0.1:" + providerPort, username: "demo", password: "secret" })
  })).json();
  const sourceToken = connected.source.token;
  const sourceEcho = waitForMessage(host, "iptv-source"); host.send(JSON.stringify({ type: "iptv-source", token: sourceToken }));
  assert.equal((await sourceEcho).source.token, sourceToken);

  const guest = await openSocket(wsBase); sockets.push(guest);
  const guestRoster = waitForMessage(guest, "roster"), guestSource = waitForMessage(guest, "iptv-source");
  guest.send(JSON.stringify({ type: "join", room, name: "Guest", peerId: "guest" })); await guestRoster;
  assert.equal((await guestSource).source.token, sourceToken, "late joiner receives the provider session");

  const headers = { "X-SameCouch-IPTV": sourceToken, "content-type": "application/json" };
  assert.equal((await fetch(base + "/iptv/remux-source/not-a-ticket")).status, 404, "the FFmpeg input route is not a public proxy");
  const liveCatalog = await (await fetch(base + "/iptv/catalog?kind=live", { headers })).json();
  const liveRemux = await (await fetch(base + "/iptv/remux", { method: "POST", headers, body: JSON.stringify({ id: liveCatalog.items[0].id, video: "copy" }) })).json();
  const liveUrl = new URL(liveRemux.streamPath, base), livePayload = JSON.parse(Buffer.from(liveUrl.searchParams.get("token").split(".")[0], "base64url").toString("utf8"));
  assert.match(livePayload.url, /^iptv:[A-Za-z0-9_-]+$/); assert.equal(livePayload.video, "copy");
  assert.doesNotMatch(JSON.stringify(livePayload), /demo|secret|\/live\//);
  const liveMp4 = Buffer.from(await (await fetch(liveUrl)).arrayBuffer());
  assert.ok(liveMp4.includes(Buffer.from("avc1")), "live keeps H.264 video");
  assert.ok(liveMp4.includes(Buffer.from("mp4a")), "AC-3 live audio becomes AAC");
  assert.ok(interruptedLiveRequests >= 2, "a prematurely closed live edge is reopened without restarting the player");
  assert.ok(seen.includes("/live/demo/secret/10.ts"));
  assert.ok(seenRequests.some(request => request.path === "/live/demo/secret/10.ts" && /VLC/i.test(request.userAgent)), "media requests use a provider-compatible player identity");

  const movieCatalog = await (await fetch(base + "/iptv/catalog?kind=movie", { headers })).json();
  const resolved = await (await fetch(base + "/iptv/resolve", { method: "POST", headers, body: JSON.stringify({ id: movieCatalog.items[0].id }) })).json();
  assert.equal(resolved.playback.fallback, "h264", "HEVC is detected before the browser gets a black player");
  const movieRemux = await (await fetch(base + "/iptv/remux", { method: "POST", headers, body: JSON.stringify({ id: movieCatalog.items[0].id, video: "h264" }) })).json();
  const guestMovieRemux = await (await fetch(base + "/iptv/remux", { method: "POST", headers, body: JSON.stringify({ id: movieCatalog.items[0].id, video: "h264" }) })).json();
  const movieUrl = new URL(movieRemux.streamPath, base), moviePayload = JSON.parse(Buffer.from(movieUrl.searchParams.get("token").split(".")[0], "base64url").toString("utf8"));
  const guestMovieUrl = new URL(guestMovieRemux.streamPath, base), guestMoviePayload = JSON.parse(Buffer.from(guestMovieUrl.searchParams.get("token").split(".")[0], "base64url").toString("utf8"));
  assert.equal(moviePayload.video, "h264"); assert.doesNotMatch(JSON.stringify(moviePayload), /demo|secret|\/movie\//);
  assert.equal(guestMoviePayload.url, moviePayload.url, "viewers share one HEVC-to-H.264 process");
  const [movieResponse, guestMovieResponse] = await Promise.all([fetch(movieUrl), fetch(guestMovieUrl)]);
  assert.equal(movieResponse.status, 200); assert.equal(guestMovieResponse.status, 200);
  const [movieMp4, guestMovieMp4] = await Promise.all([movieResponse.arrayBuffer(), guestMovieResponse.arrayBuffer()].map(async value => Buffer.from(await value)));
  assert.ok(movieMp4.includes(Buffer.from("avc1")), "HEVC video becomes browser-safe H.264");
  assert.ok(movieMp4.includes(Buffer.from("mp4a")), "HEVC film audio becomes AAC");
  assert.ok(!movieMp4.includes(Buffer.from("hvc1")), "HEVC track is not copied through");
  assert.deepEqual(guestMovieMp4, movieMp4, "both viewers receive the same complete transcoded stream");
  assert.ok(seenRequests.some(request => request.path === "/movie/demo/secret/20.mp4" && /^bytes=/i.test(request.range)), "FFmpeg can seek IPTV VOD through the opaque loopback proxy");

  const sharedVideo = waitForMessage(guest, "video");
  host.send(JSON.stringify({ type: "video", mode: "file", url: resolved.playback.url, id: movieCatalog.items[0].id, title: "HEVC Film", live: false, iptv: true, iptvFallback: "h264" }));
  const relayed = await sharedVideo;
  assert.equal(relayed.iptv, true); assert.equal(relayed.iptvFallback, "h264");
});
