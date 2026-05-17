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

  -- device_tokens stores only the hash of the secret half of the token.
  -- The actual token presented by the daemon is "<id>.<secret>"; the server
  -- looks up the row by id, then constant-time-compares sha256(secret) to
  -- secret_hash. A DB leak therefore can't be replayed against /client.
  CREATE TABLE IF NOT EXISTS device_tokens (
    id              TEXT PRIMARY KEY,
    secret_hash     TEXT NOT NULL,
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

  -- pairing_codes adds an explicit 'claimed' status so pair-status can only
  -- hand out the token exactly once. Older deployments may still have the
  -- column-free shape; the migration block below handles it.

  CREATE TABLE IF NOT EXISTS agent_sessions (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent                 TEXT NOT NULL,
    cwd                   TEXT NOT NULL,
    title                 TEXT NOT NULL,
    resume_token          TEXT,
    preferred_device_id   TEXT,
    model                 TEXT,
    created_at            INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    meta            TEXT,
    ts              INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_session_ts ON agent_messages(session_id, ts);
`);

// Seed a synthetic 'anon' user so dev mode (no GitHub OAuth) can satisfy
// the FK constraints from agent_sessions etc. without bypassing them.
db.prepare(`
  INSERT INTO users (id, github_id, github_login, email, name, avatar_url, created_at)
  VALUES ('anon', 0, 'anonymous', NULL, 'Anonymous (dev)', NULL, ?)
  ON CONFLICT(id) DO NOTHING
`).run(Date.now());

// Additive migrations on agent_sessions. CREATE TABLE IF NOT EXISTS won't
// touch an existing table, so columns added after first deploy need an
// explicit ALTER when missing.
{
  const cols = db.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'preferred_device_id')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN preferred_device_id TEXT`);
  }
  if (!cols.some((c) => c.name === 'model')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN model TEXT`);
  }
}

// One-shot migration from the M3 device_tokens shape (PK was raw token) to
// the hashed-secret shape introduced in M4.6. We detect the legacy column
// and drop existing rows: the only deployment in flight has one developer
// and a single paired daemon, so the cost of re-pairing is trivial compared
// to writing a non-trivial back-fill that could leak plaintext tokens.
{
  const cols = db.prepare(`PRAGMA table_info(device_tokens)`).all() as Array<{ name: string }>;
  const hasLegacyTokenCol = cols.some((c) => c.name === 'token');
  const hasNewIdCol = cols.some((c) => c.name === 'id');
  if (hasLegacyTokenCol && !hasNewIdCol) {
    console.warn('[db] migrating device_tokens to hashed shape — existing tokens will be invalidated, re-run `vvibe login` on each daemon');
    db.exec(`
      DROP TABLE device_tokens;
      CREATE TABLE device_tokens (
        id              TEXT PRIMARY KEY,
        secret_hash     TEXT NOT NULL,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name    TEXT,
        created_at      INTEGER NOT NULL,
        last_seen_at    INTEGER
      );
      CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);
    `);
  }
}

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

export interface AgentSessionRow {
  id: string;
  user_id: string;
  agent: string;
  cwd: string;
  title: string;
  resume_token: string | null;
  preferred_device_id: string | null;
  model: string | null;
  created_at: number;
}

export interface AgentMessageRow {
  id: string;
  session_id: string;
  role: string;
  text: string;
  meta: string | null;
  ts: number;
}

export interface DeviceTokenRow {
  id: string;
  secret_hash: string;
  user_id: string;
  display_name: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface PairingCodeRow {
  code: string;
  status: 'pending' | 'approved' | 'claimed' | 'denied' | 'expired';
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
  // Mark a pairing row as having handed out its token. Combined with the
  // status check in pairStatus, this guarantees the token is returned at
  // most once per code — a second poll after approval will see 'claimed'.
  claimPairingCode: db.prepare<[string]>(`
    UPDATE pairing_codes
    SET status = 'claimed', device_token = NULL
    WHERE code = ? AND status = 'approved'
  `),
  // Expire both 'pending' codes (never approved) AND 'approved' codes whose
  // daemon never polled to claim them. The latter matters because an approved
  // row holds the plaintext token in device_token until claim — letting it
  // sit forever would re-create the DB-leak primitive we eliminated by
  // hashing device_tokens. NULL the column on sweep.
  expireOldPairingCodes: db.prepare<[number]>(`
    UPDATE pairing_codes
    SET status = 'expired', device_token = NULL
    WHERE status IN ('pending', 'approved') AND expires_at < ?
  `),

  insertDeviceToken: db.prepare<[string, string, string, string | null, number]>(`
    INSERT INTO device_tokens (id, secret_hash, user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)
  `),
  findDeviceTokenById: db.prepare<[string], DeviceTokenRow>(`
    SELECT * FROM device_tokens WHERE id = ?
  `),
  findDeviceLabelById: db.prepare<[string], { display_name: string | null }>(`
    SELECT display_name FROM device_tokens WHERE id = ?
  `),
  touchDeviceToken: db.prepare<[number, string]>(`
    UPDATE device_tokens SET last_seen_at = ? WHERE id = ?
  `),

  // Agent sessions ─────────────────────────────────────────────────────────
  insertAgentSession: db.prepare<[string, string, string, string, string, string | null, string | null, number]>(`
    INSERT INTO agent_sessions (id, user_id, agent, cwd, title, preferred_device_id, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateAgentSessionPreferredDevice: db.prepare<[string | null, string]>(`
    UPDATE agent_sessions SET preferred_device_id = ? WHERE id = ?
  `),
  updateAgentSessionTitle: db.prepare<[string, string]>(`
    UPDATE agent_sessions SET title = ? WHERE id = ?
  `),
  updateAgentSessionResumeToken: db.prepare<[string | null, string]>(`
    UPDATE agent_sessions SET resume_token = ? WHERE id = ?
  `),
  deleteAgentSession: db.prepare<[string]>(`DELETE FROM agent_sessions WHERE id = ?`),
  listAgentSessions: db.prepare<[], AgentSessionRow>(`
    SELECT * FROM agent_sessions ORDER BY created_at ASC
  `),

  // Agent messages ─────────────────────────────────────────────────────────
  insertAgentMessage: db.prepare<[string, string, string, string, string | null, number]>(`
    INSERT INTO agent_messages (id, session_id, role, text, meta, ts) VALUES (?, ?, ?, ?, ?, ?)
  `),
  listAgentMessagesBySession: db.prepare<[string], AgentMessageRow>(`
    SELECT * FROM agent_messages WHERE session_id = ? ORDER BY ts ASC, id ASC
  `),
};
