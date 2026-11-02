"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const ADMIN = "qa-only";

function waitFor(ws, type, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", on); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
    function on(raw) { const m = JSON.parse(String(raw)); if (m.type !== type) return; clearTimeout(timer); ws.off("message", on); resolve(m); }
    ws.on("message", on);
  });
}
function openSocket(url) {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once("open", () => resolve(ws)); ws.once("error", reject); });
}
function startServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, DATABASE_URL: "", ADMIN_PASSWORD: ADMIN, WALL_TOKEN_SECRET: "", MKV_TOKEN_SECRET: "", TURN_SECRET: "", NIGHT_MIN_MS: "300", NIGHT_GRACE_MS: "200" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Server did not start:\n${output}`)); }, 30000);
    function inspect(chunk) { output += String(chunk); if (output.includes(`SameCouch server on :${port}`)) { clearTimeout(timer); resolve(child); } }
    child.stdout.on("data", inspect); child.stderr.on("data", inspect);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("couch nights are counted per room, celebrate milestones, report return rates, and the next night is kept", async t => {
  const port = 21000 + (process.pid % 1000);
  const dbPath = path.join(os.tmpdir(), `samecouch-nights-${process.pid}-${Date.now()}.db`);
  const room = `nights-${Date.now()}`;
  /* the server only keeps a salted hash of the room code: seed two earlier evenings for this room */
  const secret = crypto.createHash("sha256").update("samecouch-wall|" + ADMIN).digest();
  const key = crypto.createHmac("sha256", secret).update("night|" + room).digest("hex").slice(0, 24);
  const D = 86400000, day = ms => new Date(ms).toISOString().slice(0, 10);
  const seeded = spawnSync(process.execPath, ["-e", `
    const store = require("./server/store");
    (async () => {
      for (const ago of [9, 3]) { const at = Date.now() - ago * ${D}; await store.addNight({ roomHash: "${key}", day: new Date(at).toISOString().slice(0, 10), startedAt: at, durationMs: 40 * 60000, peak: 2, played: true }); }
      console.log("SEEDED");
    })();
  `], { cwd: ROOT, env: { ...process.env, DATABASE_URL: "", DB_PATH: dbPath }, encoding: "utf8", timeout: 10000 });
  assert.match(seeded.stdout, /SEEDED/, seeded.stderr);

  const server = await startServer(port, dbPath);
  const sockets = [];
  t.after(() => {
    sockets.forEach(ws => { try { ws.close(); } catch (_) {} });
    server.kill("SIGTERM");
    for (const s of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + s, { force: true }); } catch (_) {} }
  });
  const url = `ws://127.0.0.1:${port}/rt`;

  const a = await openSocket(url); sockets.push(a);
  const aRoster = waitFor(a, "roster");
  /* Ann arrived through a tagged link (?via=qa-launch) and creates the room → the room remembers the channel */
  assert.equal((await fetch(`http://127.0.0.1:${port}/via?c=QA-Launch!`, { method: "POST" })).status, 204);
  a.send(JSON.stringify({ type: "join", room, name: "Ann", peerId: "annqa", owner: "qa-owner-key-0123456789", via: "qa-launch" }));
  assert.equal((await aRoster).nextNight, null);

  /* the second person on the couch starts night number 3 for this room → everyone sees the milestone */
  const b = await openSocket(url); sockets.push(b);
  const milestoneA = waitFor(a, "milestone"), milestoneB = waitFor(b, "milestone");
  b.send(JSON.stringify({ type: "join", room, name: "Bob", peerId: "bobqa" }));
  const [ma, mb] = await Promise.all([milestoneA, milestoneB]);
  assert.equal(ma.nights, 3); assert.equal(mb.nights, 3);

  /* "same time next week?" is relayed and replayed to whoever joins later */
  const at = Date.now() + 7 * D;
  const relayed = waitFor(b, "next-night");
  a.send(JSON.stringify({ type: "next-night", at, title: "Friday film" }));
  const nn = await relayed;
  assert.equal(nn.at, at); assert.equal(nn.title, "Friday film"); assert.equal(nn.by, "Ann");
  a.send(JSON.stringify({ type: "next-night", at: Date.now() - 1000, title: "in the past" }));   // ignored
  await sleep(500);   // long enough to count (test threshold 300 ms)

  /* a short blip does not split the evening: Bob drops and comes back within the grace period */
  b.close(); await sleep(60);
  const b2 = await openSocket(url); sockets.push(b2);
  const b2Roster = waitFor(b2, "roster");
  b2.send(JSON.stringify({ type: "join", room, name: "Bob", peerId: "bobqa2" }));
  const r2 = await b2Roster;
  assert.equal(r2.nextNight.at, at); assert.equal(r2.nextNight.title, "Friday film");
  await sleep(150);
  b2.close(); await sleep(450);   // past the grace period → the night is stored

  const admin = await openSocket(url); sockets.push(admin);
  const ok = waitFor(admin, "admin_ok");
  admin.send(JSON.stringify({ type: "admin", password: ADMIN }));
  await ok;
  const report = waitFor(admin, "nights");
  admin.send(JSON.stringify({ type: "admin_nights" }));
  const n = await report;
  assert.equal(n.week.nights, 2, "tonight + the evening 3 days ago (one night despite the reconnect)");
  assert.equal(n.week.couches, 1);
  assert.equal(n.week.returningCouches, 1);
  assert.equal(n.week.withVideo, 50);
  assert.deepEqual(n.returnRate, { cohort: 1, returned: 1, pct: 100 }, "first met 9 days ago, met again 6 days later");
  assert.equal(n.repeatCouches, 1);
  assert.deepEqual(n.channels, [{ via: "qa-launch", landings: 1, nights: 1, couches: 1 }], "tonight is credited to the channel that brought the room in");
  assert.ok(n.days.some(d => d.day === day(Date.now())));
  /* nothing that identifies the room or its people reaches the report */
  assert.doesNotMatch(JSON.stringify(n), new RegExp(room + "|Ann|Bob|" + key));
});
