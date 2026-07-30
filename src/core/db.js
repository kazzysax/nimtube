// Uses node:sqlite, built into Node 22+. No native build step, so this deploys
// anywhere Node runs without a compiler toolchain.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const FILE = process.env.DB_FILE || './data/predtube.db';
mkdirSync(dirname(FILE), { recursive: true });

export const db = new DatabaseSync(FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite has no transaction helper of its own. Same shape as better-sqlite3's,
// so callers read identically: db.transaction(fn)() runs fn atomically.
db.transaction = fn => (...args) => {
  db.exec('BEGIN');
  try {
    const out = fn(...args);
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,        -- Nimiq address, the account
  username      TEXT NOT NULL UNIQUE,
  username_ci   TEXT NOT NULL UNIQUE,        -- case/lookalike-folded, uniqueness key
  device_hash   TEXT,                        -- requestDeviceIdentifier(), anti-sybil signal
  rep           INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 20,
  last_allowance TEXT,                       -- ISO date of last daily 5
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS niches (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS markets (
  id            INTEGER PRIMARY KEY,
  creator_id    INTEGER NOT NULL REFERENCES users(id),
  question      TEXT NOT NULL,
  category      TEXT NOT NULL,
  source_tier   TEXT NOT NULL,               -- auto | polymarket | declared
  source_name   TEXT NOT NULL,
  source_detail TEXT NOT NULL,
  criteria_yes  TEXT NOT NULL,
  criteria_no   TEXT NOT NULL,
  opens_at      TEXT NOT NULL,
  closes_at     TEXT NOT NULL,
  resolves_at   TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open',-- open | closed | resolved | void
  outcome       TEXT,                        -- YES | NO
  void_reason   TEXT,
  resolution_log TEXT,
  bounty_nim    REAL NOT NULL DEFAULT 0,
  bounty_winners INTEGER NOT NULL DEFAULT 0,
  bounty_tx     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_markets_state ON markets(state, resolves_at);
CREATE INDEX IF NOT EXISTS idx_markets_cat   ON markets(category, state);

CREATE TABLE IF NOT EXISTS wagers (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  side       TEXT NOT NULL CHECK (side IN ('yes','no')),
  stake      INTEGER NOT NULL CHECK (stake > 0),
  rep_at_time INTEGER NOT NULL,              -- frozen: rep factor must not drift
  weight     REAL NOT NULL,                  -- uncapped; cap applied at read time
  placed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  settled    INTEGER NOT NULL DEFAULT 0,
  rep_delta  INTEGER,
  UNIQUE (market_id, user_id)                -- one wager per market, enforced by the db
);
CREATE INDEX IF NOT EXISTS idx_wagers_market ON wagers(market_id);
CREATE INDEX IF NOT EXISTS idx_wagers_user   ON wagers(user_id);

CREATE TABLE IF NOT EXISTS tips (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id),
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  amount_nim REAL NOT NULL,
  tx_hash    TEXT NOT NULL UNIQUE,
  verified   INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  failed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tips_pending ON tips(verified, failed_reason);

CREATE TABLE IF NOT EXISTS bounty_awards (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount_nim REAL NOT NULL,
  paid       INTEGER NOT NULL DEFAULT 0,
  tx_hash    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS challenges (
  nonce      TEXT PRIMARY KEY,
  address    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export default db;
