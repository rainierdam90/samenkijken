/* ============================================================================
 * Persistence (optional, async API). Backends, in order of preference:
 *   1. Postgres  — when DATABASE_URL is set (e.g. Neon). Works on free hosting.
 *   2. SQLite    — Node's built-in node:sqlite (>=22.5), needs a writable DB_PATH.
 *   3. Disabled  — everything degrades to in-memory; the app still works, the
 *                  wall just won't persist.
 * Secrets (DATABASE_URL) come from the environment only — never hard-code them.
 * ==========================================================================*/
"use strict";

const WALL_KEEP = parseInt(process.env.WALL_KEEP || "200", 10);
const FREE_DAYS = parseInt(process.env.FREE_DAYS || "10", 10);   // free wall lifetime
const FREE_MS = FREE_DAYS * 24 * 3600 * 1000;
let ready = false;
let impl = null;

/* ---------------- Postgres (Neon etc.) ---------------- */
function makePg() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // Neon & most managed PG require TLS
    max: parseInt(process.env.PG_POOL_MAX || "5", 10)
  });
  pool.on("error", () => {});   // don't crash on idle client errors
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, passhash TEXT, host TEXT, createdat BIGINT, expiresat BIGINT);
        CREATE TABLE IF NOT EXISTS wall (id TEXT PRIMARY KEY, room TEXT, kind TEXT, author TEXT, mime TEXT, data TEXT, ts BIGINT);
        CREATE INDEX IF NOT EXISTS idx_wall_room ON wall (room, ts);
      `);
      try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expiresat BIGINT"); } catch (e) {}
      ready = true;
      console.log("[store] persistence ON (Postgres)");
    } catch (e) { console.warn("[store] Postgres init failed — " + e.message); }
  })();
  return {
    async getRoom(code) { try { const r = await pool.query("SELECT passhash, host, expiresat FROM rooms WHERE code=$1", [code]); const row = r.rows[0]; return row ? { passHash: row.passhash, host: row.host, expiresAt: row.expiresat ? Number(row.expiresat) : 0 } : null; } catch (e) { return null; } },
    async ensureRoom(code, host) { try { await pool.query("INSERT INTO rooms (code, host, createdat, expiresat) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET host = COALESCE(rooms.host, EXCLUDED.host), expiresat = COALESCE(rooms.expiresat, EXCLUDED.expiresat)", [code, host || null, Date.now(), Date.now() + FREE_MS]); } catch (e) {} },
    async setPass(code, passHash) { try { await pool.query("INSERT INTO rooms (code, passhash, createdat, expiresat) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET passhash = EXCLUDED.passhash", [code, passHash || null, Date.now(), Date.now() + FREE_MS]); } catch (e) {} },
    async extendRoom(code, addMs) { try { await pool.query("UPDATE rooms SET expiresat = GREATEST(COALESCE(expiresat, $2), $2) + $3 WHERE code=$1", [code, Date.now(), addMs]); } catch (e) {} },
    async addWall(it) { try {
        await pool.query("INSERT INTO wall (id, room, kind, author, mime, data, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)", [it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts]);
        await pool.query("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=$1 ORDER BY ts DESC OFFSET $2)", [it.room, WALL_KEEP]);
      } catch (e) {} },
    async getWall(code, limit) { try { const r = await pool.query("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=$1 ORDER BY ts ASC LIMIT $2", [code, limit || WALL_KEEP]); return r.rows; } catch (e) { return []; } },
    async pruneExpired() { try { const now = Date.now(); await pool.query("DELETE FROM wall WHERE room IN (SELECT code FROM rooms WHERE expiresat IS NOT NULL AND expiresat < $1)", [now]); await pool.query("DELETE FROM rooms WHERE expiresat IS NOT NULL AND expiresat < $1", [now]); } catch (e) {} }
  };
}

/* ---------------- SQLite (built-in) ---------------- */
function makeSqlite() {
  const path = require("path");
  const fs = require("fs");
  const { DatabaseSync } = require("node:sqlite");
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "wmt.db");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, passHash TEXT, host TEXT, createdAt INTEGER, expiresAt INTEGER);
    CREATE TABLE IF NOT EXISTS wall (id TEXT PRIMARY KEY, room TEXT, kind TEXT, author TEXT, mime TEXT, data TEXT, ts INTEGER);
    CREATE INDEX IF NOT EXISTS idx_wall_room ON wall (room, ts);
  `);
  try { db.exec("ALTER TABLE rooms ADD COLUMN expiresAt INTEGER"); } catch (e) {}   // migrate older DBs (no-op if exists)
  ready = true;
  console.log("[store] persistence ON (SQLite " + DB_PATH + ")");
  return {
    async getRoom(code) { try { var r = db.prepare("SELECT passHash, host, expiresAt FROM rooms WHERE code=?").get(code); return r ? { passHash: r.passHash, host: r.host, expiresAt: r.expiresAt || 0 } : null; } catch (e) { return null; } },
    async ensureRoom(code, host) { try { db.prepare("INSERT INTO rooms (code, host, createdAt, expiresAt) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET host = COALESCE(rooms.host, excluded.host), expiresAt = COALESCE(rooms.expiresAt, excluded.expiresAt)").run(code, host || null, Date.now(), Date.now() + FREE_MS); } catch (e) {} },
    async setPass(code, passHash) { try { db.prepare("INSERT INTO rooms (code, passHash, createdAt, expiresAt) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET passHash = excluded.passHash").run(code, passHash || null, Date.now(), Date.now() + FREE_MS); } catch (e) {} },
    async extendRoom(code, addMs) { try { var r = db.prepare("SELECT expiresAt FROM rooms WHERE code=?").get(code); var base = Math.max((r && r.expiresAt) || 0, Date.now()); db.prepare("UPDATE rooms SET expiresAt=? WHERE code=?").run(base + addMs, code); } catch (e) {} },
    async addWall(it) { try {
        db.prepare("INSERT INTO wall (id, room, kind, author, mime, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts);
        db.prepare("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=? ORDER BY ts DESC LIMIT -1 OFFSET ?)").run(it.room, WALL_KEEP);
      } catch (e) {} },
    async getWall(code, limit) { try { return db.prepare("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=? ORDER BY ts ASC LIMIT ?").all(code, limit || WALL_KEEP); } catch (e) { return []; } },
    async pruneExpired() { try { var now = Date.now(); db.prepare("DELETE FROM wall WHERE room IN (SELECT code FROM rooms WHERE expiresAt IS NOT NULL AND expiresAt < ?)").run(now); db.prepare("DELETE FROM rooms WHERE expiresAt IS NOT NULL AND expiresAt < ?").run(now); } catch (e) {} }
  };
}

try {
  if (process.env.DATABASE_URL) impl = makePg();
  else impl = makeSqlite();
} catch (e) {
  console.warn("[store] persistence OFF — " + e.message + " (the app still works; the wall just won't persist)");
}

const noop = async () => {};
module.exports = {
  enabled() { return ready; },
  freeDays() { return FREE_DAYS; },
  getRoom: (c) => impl ? impl.getRoom(c) : Promise.resolve(null),
  ensureRoom: (c, h) => impl ? impl.ensureRoom(c, h) : noop(),
  setPass: (c, p) => impl ? impl.setPass(c, p) : noop(),
  extendRoom: (c, ms) => impl && impl.extendRoom ? impl.extendRoom(c, ms) : noop(),
  addWall: (it) => impl ? impl.addWall(it) : noop(),
  getWall: (c, l) => impl ? impl.getWall(c, l) : Promise.resolve([]),
  pruneExpired: () => impl && impl.pruneExpired ? impl.pruneExpired() : noop()
};
