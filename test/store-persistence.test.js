"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function runStoreScript(dbPath, source) {
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: "", DB_PATH: dbPath },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith("STORE_RESULT="));
  assert.ok(line, `store result missing:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("STORE_RESULT=".length));
}

test("push reminders and room subscriptions survive a process restart", t => {
  const dbPath = path.join(os.tmpdir(), `samecouch-store-${process.pid}-${Date.now()}.db`);
  t.after(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
    }
  });

  const written = runStoreScript(dbPath, `
    const store = require("./server/store");
    (async () => {
      const sub = { endpoint: "https://push.example.test/device-1", keys: { auth: "a", p256dh: "b" } };
      const reminder = { id: "persist-1", sub, at: 12345, title: "Movie", body: "Now", url: "/?room=qa" };
      const a = await store.addReminder(reminder);
      const b = await store.addRoomSub("qa-room", sub.endpoint, sub, "QA user");
      console.log("STORE_RESULT=" + JSON.stringify({ a, b }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  assert.deepEqual(written, { a: true, b: true });

  const restored = runStoreScript(dbPath, `
    const store = require("./server/store");
    (async () => {
      const reminders = await store.dueReminders(Date.now(), 10);
      const subscriptions = await store.getRoomSubs("qa-room");
      console.log("STORE_RESULT=" + JSON.stringify({ reminders, subscriptions }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(restored.reminders.length, 1);
  assert.equal(restored.reminders[0].id, "persist-1");
  assert.equal(restored.reminders[0].sub.endpoint, "https://push.example.test/device-1");
  assert.equal(restored.subscriptions.length, 1);
  assert.equal(restored.subscriptions[0].name, "QA user");
});
