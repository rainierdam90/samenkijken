"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
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
    }, 10000);
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

test("opaque and redirected MKV sources are remuxed to fragmented browser MP4", { skip: !FFMPEG_OK }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "samecouch-mkv-"));
  const fixture = path.join(temp, "fixture.mkv");
  const dbPath = path.join(temp, "qa.db");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const made = spawnSync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1.2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "matroska", fixture
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

  const token = streamUrl.searchParams.get("token");
  const tokenParts = token.split("."), signature = tokenParts[1];
  streamUrl.searchParams.set("token", tokenParts[0] + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1));
  assert.equal((await fetch(streamUrl)).status, 403);
});
