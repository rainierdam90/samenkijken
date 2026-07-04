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
        CREATE TABLE IF NOT EXISTS visits (day TEXT, iphash TEXT, PRIMARY KEY (day, iphash));
        CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (day);
      `);
      try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expiresat BIGINT"); } catch (e) {}
      try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS theme TEXT"); } catch (e) {}
      try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS decor TEXT"); } catch (e) {}
      try { await pool.query("ALTER TABLE wall ADD COLUMN IF NOT EXISTS editkey TEXT"); } catch (e) {}
      ready = true;
      console.log("[store] persistence ON (Postgres)");
    } catch (e) { console.warn("[store] Postgres init failed — " + e.message); }
  })();
  return {
    async getRoom(code) { try { const r = await pool.query("SELECT passhash, host, expiresat, theme, decor FROM rooms WHERE code=$1", [code]); const row = r.rows[0]; return row ? { passHash: row.passhash, host: row.host, expiresAt: row.expiresat ? Number(row.expiresat) : 0, theme: row.theme || null, decor: row.decor || null } : null; } catch (e) { return null; } },
    async setTheme(code, theme) { try { await pool.query("UPDATE rooms SET theme=$2 WHERE code=$1", [code, theme || null]); } catch (e) {} },
    async setDecor(code, decor) { try { await pool.query("UPDATE rooms SET decor=$2 WHERE code=$1", [code, decor || null]); } catch (e) {} },
    async ensureRoom(code, host) { try { await pool.query("INSERT INTO rooms (code, host, createdat, expiresat) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET host = COALESCE(rooms.host, EXCLUDED.host), expiresat = COALESCE(rooms.expiresat, EXCLUDED.expiresat)", [code, host || null, Date.now(), Date.now() + FREE_MS]); } catch (e) {} },
    async setPass(code, passHash) { try { await pool.query("INSERT INTO rooms (code, passhash, createdat, expiresat) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET passhash = EXCLUDED.passhash", [code, passHash || null, Date.now(), Date.now() + FREE_MS]); } catch (e) {} },
    async extendRoom(code, addMs) { try { await pool.query("UPDATE rooms SET expiresat = GREATEST(COALESCE(expiresat, $2), $2) + $3 WHERE code=$1", [code, Date.now(), addMs]); } catch (e) {} },
    async renameRoom(oldCode, newCode) { try {
        const exists = await pool.query("SELECT 1 FROM rooms WHERE code=$1", [newCode]);
        if (exists.rows.length) return false;
        await pool.query("UPDATE rooms SET code=$2 WHERE code=$1", [oldCode, newCode]);
        await pool.query("UPDATE wall SET room=$2 WHERE room=$1", [oldCode, newCode]);
        return true;
      } catch (e) { return false; } },
    async addWall(it) { try {
        await pool.query("INSERT INTO wall (id, room, kind, author, mime, data, ts, editkey) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts, it.editKey || null]);
        await pool.query("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=$1 ORDER BY ts DESC OFFSET $2)", [it.room, WALL_KEEP]);
      } catch (e) {} },
    async delWall(room, id, keyHash) { try { const r = await pool.query("DELETE FROM wall WHERE room=$1 AND id=$2 AND editkey=$3", [room, id, keyHash]); return r.rowCount > 0; } catch (e) { return false; } },
    async getWall(code, limit) { try { const r = await pool.query("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=$1 ORDER BY ts ASC LIMIT $2", [code, limit || WALL_KEEP]); return r.rows; } catch (e) { return []; } },
    async recordVisit(day, ipHash) { try { await pool.query("INSERT INTO visits (day, iphash) VALUES ($1,$2) ON CONFLICT DO NOTHING", [day, ipHash]); } catch (e) {} },
    async visitorDays(limit) { try { const r = await pool.query("SELECT day, COUNT(*)::int AS n FROM visits GROUP BY day ORDER BY day DESC LIMIT $1", [limit || 30]); return r.rows.map(x => ({ day: x.day, count: Number(x.n) })); } catch (e) { return []; } },
    async pruneVisits(beforeDay) { try { await pool.query("DELETE FROM visits WHERE day < $1", [beforeDay]); } catch (e) {} },
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
    CREATE TABLE IF NOT EXISTS visits (day TEXT, ipHash TEXT, PRIMARY KEY (day, ipHash));
    CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (day);
  `);
  try { db.exec("ALTER TABLE rooms ADD COLUMN expiresAt INTEGER"); } catch (e) {}   // migrate older DBs (no-op if exists)
  try { db.exec("ALTER TABLE rooms ADD COLUMN theme TEXT"); } catch (e) {}          // room ambiance theme
  try { db.exec("ALTER TABLE rooms ADD COLUMN decor TEXT"); } catch (e) {}          // user-placed room decorations (JSON)
  try { db.exec("ALTER TABLE wall ADD COLUMN editKey TEXT"); } catch (e) {}         // hashed owner key → lets the poster remove their own item
  ready = true;
  console.log("[store] persistence ON (SQLite " + DB_PATH + ")");
  return {
    async getRoom(code) { try { var r = db.prepare("SELECT passHash, host, expiresAt, theme, decor FROM rooms WHERE code=?").get(code); return r ? { passHash: r.passHash, host: r.host, expiresAt: r.expiresAt || 0, theme: r.theme || null, decor: r.decor || null } : null; } catch (e) { return null; } },
    async setTheme(code, theme) { try { db.prepare("UPDATE rooms SET theme=? WHERE code=?").run(theme || null, code); } catch (e) {} },
    async setDecor(code, decor) { try { db.prepare("UPDATE rooms SET decor=? WHERE code=?").run(decor || null, code); } catch (e) {} },
    async ensureRoom(code, host) { try { db.prepare("INSERT INTO rooms (code, host, createdAt, expiresAt) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET host = COALESCE(rooms.host, excluded.host), expiresAt = COALESCE(rooms.expiresAt, excluded.expiresAt)").run(code, host || null, Date.now(), Date.now() + FREE_MS); } catch (e) {} },
    async setPass(code, passHash) { try { db.prepare("INSERT INTO rooms (code, passHash, createdAt, expiresAt) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET passHash = excluded.passHash").run(code, passHash || null, Date.now(), Date.now() + FREE_MS); } catch (e) {} },
    async extendRoom(code, addMs) { try { var r = db.prepare("SELECT expiresAt FROM rooms WHERE code=?").get(code); var base = Math.max((r && r.expiresAt) || 0, Date.now()); db.prepare("UPDATE rooms SET expiresAt=? WHERE code=?").run(base + addMs, code); } catch (e) {} },
    async renameRoom(oldCode, newCode) { try {
        if (db.prepare("SELECT 1 FROM rooms WHERE code=?").get(newCode)) return false;
        db.prepare("UPDATE rooms SET code=? WHERE code=?").run(newCode, oldCode);
        db.prepare("UPDATE wall SET room=? WHERE room=?").run(newCode, oldCode);
        return true;
      } catch (e) { return false; } },
    async addWall(it) { try {
        db.prepare("INSERT INTO wall (id, room, kind, author, mime, data, ts, editKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(it.id, it.room, it.kind, it.author || null, it.mime || null, it.data || null, it.ts, it.editKey || null);
        db.prepare("DELETE FROM wall WHERE id IN (SELECT id FROM wall WHERE room=? ORDER BY ts DESC LIMIT -1 OFFSET ?)").run(it.room, WALL_KEEP);
      } catch (e) {} },
    async delWall(room, id, keyHash) { try { var r = db.prepare("DELETE FROM wall WHERE room=? AND id=? AND editKey=?").run(room, id, keyHash); return r.changes > 0; } catch (e) { return false; } },
    async getWall(code, limit) { try { return db.prepare("SELECT id, kind, author, mime, data, ts FROM wall WHERE room=? ORDER BY ts ASC LIMIT ?").all(code, limit || WALL_KEEP); } catch (e) { return []; } },
    async recordVisit(day, ipHash) { try { db.prepare("INSERT OR IGNORE INTO visits (day, ipHash) VALUES (?, ?)").run(day, ipHash); } catch (e) {} },
    async visitorDays(limit) { try { return db.prepare("SELECT day, COUNT(*) AS count FROM visits GROUP BY day ORDER BY day DESC LIMIT ?").all(limit || 30); } catch (e) { return []; } },
    async pruneVisits(beforeDay) { try { db.prepare("DELETE FROM visits WHERE day < ?").run(beforeDay); } catch (e) {} },
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
  setTheme: (c, t) => impl && impl.setTheme ? impl.setTheme(c, t) : noop(),
  setDecor: (c, d) => impl && impl.setDecor ? impl.setDecor(c, d) : noop(),
  extendRoom: (c, ms) => impl && impl.extendRoom ? impl.extendRoom(c, ms) : noop(),
  renameRoom: (a, b) => impl && impl.renameRoom ? impl.renameRoom(a, b) : Promise.resolve(true),
  addWall: (it) => impl ? impl.addWall(it) : noop(),
  delWall: (r, i, k) => impl && impl.delWall ? impl.delWall(r, i, k) : Promise.resolve(false),
  getWall: (c, l) => impl ? impl.getWall(c, l) : Promise.resolve([]),
  recordVisit: (d, h) => impl && impl.recordVisit ? impl.recordVisit(d, h) : noop(),
  visitorDays: (n) => impl && impl.visitorDays ? impl.visitorDays(n) : Promise.resolve([]),
  pruneVisits: (d) => impl && impl.pruneVisits ? impl.pruneVisits(d) : noop(),
  pruneExpired: () => impl && impl.pruneExpired ? impl.pruneExpired() : noop()
};
