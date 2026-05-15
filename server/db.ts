import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db: Database.Database = new Database(DB_PATH);

// Pragmas: WAL for better concurrency under our read-heavy pattern, foreign
// keys on so cascades behave.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// Phase A schema. Sessions/messages stay in-memory for now (M4 territory);
// what we persist here is identity + binding state.

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    github_id       INTEGER NOT NULL UNIQUE,
    github_login    TEXT NOT NULL,
    email           TEXT,
    name            TEXT,
    avatar_url      TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS browser_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_tokens (
    token           TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name    TEXT,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS pairing_codes (
    code            TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
    device_token    TEXT,
    device_name     TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
`);

console.log(`[db] opened ${DB_PATH}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  github_id: number;
  github_login: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
}

export interface DeviceTokenRow {
  token: string;
  user_id: string;
  display_name: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface PairingCodeRow {
  code: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  user_id: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: number;
  expires_at: number;
}

// ─── Prepared statements ─────────────────────────────────────────────────────

export const stmts = {
  upsertUser: db.prepare<[string, number, string, string | null, string | null, string | null, number]>(`
    INSERT INTO users (id, github_id, github_login, email, name, avatar_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET
      github_login = excluded.github_login,
      email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url
    RETURNING *
  `),
  findUserByGithubId: db.prepare<[number], UserRow>(`SELECT * FROM users WHERE github_id = ?`),
  findUserById: db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`),

  createBrowserSession: db.prepare<[string, string, number, number]>(`
    INSERT INTO browser_sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
  `),
  findUserIdBySessionId: db.prepare<[string], { user_id: string }>(`
    SELECT user_id FROM browser_sessions WHERE id = ?
  `),
  touchBrowserSession: db.prepare<[number, string]>(`
    UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?
  `),
  deleteBrowserSession: db.prepare<[string]>(`DELETE FROM browser_sessions WHERE id = ?`),

  insertPairingCode: db.prepare<[string, string, string | null, number, number]>(`
    INSERT INTO pairing_codes (code, status, device_name, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  findPairingCode: db.prepare<[string], PairingCodeRow>(`SELECT * FROM pairing_codes WHERE code = ?`),
  approvePairingCode: db.prepare<[string, string, string]>(`
    UPDATE pairing_codes
    SET status = 'approved', user_id = ?, device_token = ?
    WHERE code = ? AND status = 'pending'
  `),
  expireOldPairingCodes: db.prepare<[number]>(`
    UPDATE pairing_codes SET status = 'expired' WHERE status = 'pending' AND expires_at < ?
  `),

  insertDeviceToken: db.prepare<[string, string, string | null, number]>(`
    INSERT INTO device_tokens (token, user_id, display_name, created_at) VALUES (?, ?, ?, ?)
  `),
  findDeviceToken: db.prepare<[string], DeviceTokenRow>(`SELECT * FROM device_tokens WHERE token = ?`),
  touchDeviceToken: db.prepare<[number, string]>(`
    UPDATE device_tokens SET last_seen_at = ? WHERE token = ?
  `),
};
