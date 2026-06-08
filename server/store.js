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
        CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, passhash TEXT, host TEXT, createdat BIGINT);
        CREATE TABLE IF NOT EXISTS wall (id TEXT PRIMARY KEY, room TEXT, kind TEXT, author TEXT, mime TEXT, data TEXT, ts BIGINT);
        CREATE INDEX IF NOT EXISTS idx_wall_room ON wall (room, ts);
      `);
      ready = true;
      console.log("[store] persistence ON (Postgres)");
    } catch (e) { console.warn("[store] Postgres init failed — " + e.message); }
  })();
  return {
    async getRoom(code) { try { const r = await pool.query("SELECT passhash, host FROM rooms WHERE code=$1", [code]); const row = r.rows[0]; return row ? { passHash: row.passhash, host: row.host } : null; } catch (e) { return null; } },
    async ensureRoom(code, host) { try { await pool.query("INSERT INTO rooms (code, host, createdat) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET host = COALESCE(rooms.host, EXCLUDED.host)", [code, host || null, Date.now()]); } catch (e) {} },
    async setPass(code, passHash) { try { await pool.query("INSERT INTO rooms (code, passhash, createdat) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET passhash = EXCLUDED.passhash", [code, passHash || null, Date.now()]); } catch (e) {} },
    async addWall(it) { try {
        await pool.query("INSERT INTO wall (id, room, kind, author, mime, data, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)", [it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts]);
        await pool.query("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=$1 ORDER BY ts DESC OFFSET $2)", [it.room, WALL_KEEP]);
      } catch (e) {} },
    async getWall(code, limit) { try { const r = await pool.query("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=$1 ORDER BY ts ASC LIMIT $2", [code, limit || WALL_KEEP]); return r.rows; } catch (e) { return []; } }
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
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, passHash TEXT, host TEXT, createdAt INTEGER);
    CREATE TABLE IF NOT EXISTS wall (id TEXT PRIMARY KEY, room TEXT, kind TEXT, author TEXT, mime TEXT, data TEXT, ts INTEGER);
    CREATE INDEX IF NOT EXISTS idx_wall_room ON wall (room, ts);
  `);
  ready = true;
  console.log("[store] persistence ON (SQLite " + DB_PATH + ")");
  return {
    async getRoom(code) { try { return db.prepare("SELECT passHash, host FROM rooms WHERE code=?").get(code) || null; } catch (e) { return null; } },
    async ensureRoom(code, host) { try { db.prepare("INSERT INTO rooms (code, host, createdAt) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET host = COALESCE(rooms.host, excluded.host)").run(code, host || null, Date.now()); } catch (e) {} },
    async setPass(code, passHash) { try { db.prepare("INSERT INTO rooms (code, passHash, createdAt) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET passHash = excluded.passHash").run(code, passHash || null, Date.now()); } catch (e) {} },
    async addWall(it) { try {
        db.prepare("INSERT INTO wall (id, room, kind, author, mime, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts);
        db.prepare("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=? ORDER BY ts DESC LIMIT -1 OFFSET ?)").run(it.room, WALL_KEEP);
      } catch (e) {} },
    async getWall(code, limit) { try { return db.prepare("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=? ORDER BY ts ASC LIMIT ?").all(code, limit || WALL_KEEP); } catch (e) { return []; } }
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
  getRoom: (c) => impl ? impl.getRoom(c) : Promise.resolve(null),
  ensureRoom: (c, h) => impl ? impl.ensureRoom(c, h) : noop(),
  setPass: (c, p) => impl ? impl.setPass(c, p) : noop(),
  addWall: (it) => impl ? impl.addWall(it) : noop(),
  getWall: (c, l) => impl ? impl.getWall(c, l) : Promise.resolve([])
};
