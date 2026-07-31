// Uses node:sqlite, built into Node 22+. No native build step, so this deploys
// anywhere Node runs without a compiler toolchain.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { normalizeCategory } from './categories.js';

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
  avatar        INTEGER NOT NULL DEFAULT 0,  -- index into public/avatars
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
  raw_text      TEXT,                        -- what the user actually said; the feed shows this
  question      TEXT NOT NULL,               -- the tightened wording the resolver settles against
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
  resolve_attempts INTEGER NOT NULL DEFAULT 0,  -- durable retry count; survives a deploy
  resolve_last_try TEXT,
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
  market_id  INTEGER REFERENCES markets(id),        -- NULL for a general user-to-user tip
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

-- Tip-pool awards: what a call's author owes its top scorers. Carries the same
-- retry bookkeeping as tips, because paying one is verified the same way.
CREATE TABLE IF NOT EXISTS bounty_awards (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount_nim REAL NOT NULL,
  paid       INTEGER NOT NULL DEFAULT 0,
  tx_hash    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  failed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_awards_tx ON bounty_awards(tx_hash) WHERE tx_hash IS NOT NULL;

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

-- Welcome checklist. One row per quest a user has completed; the reward is
-- paid exactly once, the moment the row is first inserted.
CREATE TABLE IF NOT EXISTS quest_progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_key    TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, quest_key)
);
`);

// Older deployments created `tips.market_id` as NOT NULL, back when every tip was
// tied to a resolved call. Tipping is now general user-to-user, so market_id must
// accept NULL. SQLite can't drop a column constraint in place — rebuild the table.
//
// This is the only migration that destroys anything, so it runs inside a
// transaction: a deploy that dies between the copy and the rename must roll back
// to the old table rather than leave the tips gone.
{
  const marketIdCol = db.prepare("PRAGMA table_info(tips)").all().find(c => c.name === 'market_id');
  if (marketIdCol && marketIdCol.notnull) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
      CREATE TABLE tips_new (
        id         INTEGER PRIMARY KEY,
        market_id  INTEGER REFERENCES markets(id),
        from_id    INTEGER NOT NULL REFERENCES users(id),
        to_id      INTEGER NOT NULL REFERENCES users(id),
        amount_nim REAL NOT NULL,
        tx_hash    TEXT NOT NULL UNIQUE,
        verified   INTEGER NOT NULL DEFAULT 0,
        attempts   INTEGER NOT NULL DEFAULT 0,
        failed_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tips_new SELECT * FROM tips;
      DROP TABLE tips;
      ALTER TABLE tips_new RENAME TO tips;
      CREATE INDEX IF NOT EXISTS idx_tips_pending ON tips(verified, failed_reason);
    `);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Settled wagers are reported back to the user the next time they open the app,
// so both sides of that need a clock: when the result landed, and how far the
// user has already been shown. Existing accounts start caught up — nobody wants
// a wall of results from before the feature existed.
{
  const wcols = db.prepare('PRAGMA table_info(wagers)').all().map(c => c.name);
  if (!wcols.includes('settled_at')) db.exec('ALTER TABLE wagers ADD COLUMN settled_at TEXT');

  const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!ucols.includes('results_seen_at')) {
    db.exec('ALTER TABLE users ADD COLUMN results_seen_at TEXT');
    db.exec("UPDATE users SET results_seen_at = datetime('now')");
  }
}

// Categories used to be freeform text from the model ('Football', 'Weather',
// 'AI', ...). Fold every existing market into the fixed taxonomy so old posts
// still show up under one of the feed's chips instead of under none of them.
{
  const dirty = db.prepare(
    `SELECT id, category FROM markets WHERE category NOT IN ('Crypto','Sports','Music','Politics','Other')`
  ).all();
  for (const r of dirty) {
    db.prepare('UPDATE markets SET category = ? WHERE id = ?').run(normalizeCategory(r.category), r.id);
  }
}

// Retry state used to live only in the resolver's in-memory Map, reset by
// every deploy. Older databases predate the durable columns.
{
  const cols = db.prepare('PRAGMA table_info(markets)').all().map(c => c.name);
  if (!cols.includes('resolve_attempts')) {
    db.exec('ALTER TABLE markets ADD COLUMN resolve_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('resolve_last_try')) {
    db.exec('ALTER TABLE markets ADD COLUMN resolve_last_try TEXT');
  }
}

// Accounts predate profile pictures. Give everyone who already exists one, spread
// across the set rather than all landing on the same bird.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('avatar')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE users SET avatar = ABS(RANDOM()) % 15');
  }
}

// Markets used to store only the rewritten question. Older rows have nothing to
// show as "what they said", so they fall back to the formal wording.
{
  const cols = db.prepare('PRAGMA table_info(markets)').all().map(c => c.name);
  if (!cols.includes('raw_text')) {
    db.exec('ALTER TABLE markets ADD COLUMN raw_text TEXT');
    db.exec('UPDATE markets SET raw_text = question WHERE raw_text IS NULL');
  }
}

// Awards predate the payout flow, so older databases lack its bookkeeping.
for (const [col, decl] of [['attempts', 'INTEGER NOT NULL DEFAULT 0'], ['failed_reason', 'TEXT']]) {
  const has = db.prepare('PRAGMA table_info(bounty_awards)').all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE bounty_awards ADD COLUMN ${col} ${decl}`);
}

export default db;
