"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startApp(port, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ADMIN_PASSWORD: "qa-only" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Server did not start:\n" + output));
    }, 30000);
    function inspect(chunk) {
      output += String(chunk);
      if (!output.includes("SameCouch server on :" + port)) return;
      clearTimeout(timer);
      resolve(child);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", code => {
      if (!output.includes("SameCouch server on :" + port)) {
        clearTimeout(timer);
        reject(new Error("Server exited with " + code + ":\n" + output));
      }
    });
  });
}

test("config advertises the HTTPS reverse-proxy port used by PeerJS", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "samecouch-config-"));
  const port = await freePort();
  const app = await startApp(port, path.join(temp, "qa.db"));
  t.after(async () => {
    if (app.exitCode === null) {
      app.kill("SIGTERM");
      await once(app, "exit").catch(() => {});
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const response = await fetch("http://127.0.0.1:" + port + "/config", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "turn.watchmovietogether.com:8445",
      "x-forwarded-port": "8445"
    }
  });
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.peerHost, "turn.watchmovietogether.com");
  assert.equal(config.peerPort, 8445);
  assert.equal(config.peerSecure, true);
});
