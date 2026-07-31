import crypto from 'crypto';
import { db } from './db.js';

/** Fold a username to its uniqueness key.
 *  Lowercase, strip separators, and collapse lookalikes. Tips are real money,
 *  so a name that *reads* like a high-rep predictor is an impersonation vector:
 *  rn/m, 0/O, 1/l/I, Cyrillic а/Latin a. */
const LOOKALIKE = [
  [/[аА]/g, 'a'], [/[еЕ]/g, 'e'], [/[оО]/g, 'o'], [/[рР]/g, 'p'],
  [/[сС]/g, 'c'], [/[хХ]/g, 'x'], [/[уУ]/g, 'y'], [/[іІ]/g, 'i'],
  [/rn/g, 'm'], [/[0]/g, 'o'], [/[1l]/g, 'i'], [/[5]/g, 's'], [/[8]/g, 'b'],
];

export function fold(username) {
  let s = username.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[._\-\s]/g, '');
  for (const [re, to] of LOOKALIKE) s = s.replace(re, to);
  return s;
}

export const USERNAME_RE = /^[a-zA-Z0-9._]{3,20}$/;

export function usernameAvailable(username) {
  if (!USERNAME_RE.test(username)) return { ok: false, reason: '3-20 characters, letters, numbers, dots and underscores' };
  const taken = db.prepare('SELECT 1 FROM users WHERE username_ci = ?').get(fold(username));
  if (taken) return { ok: false, reason: 'Taken' };
  return { ok: true };
}

/** How many profile pictures live in public/avatars. */
export const AVATAR_COUNT = 15;

const pickAvatar = n => {
  const i = Number(n);
  // Anything unusable — absent, out of range, a string — becomes a random one
  // rather than defaulting everybody to the same bird.
  return Number.isInteger(i) && i >= 0 && i < AVATAR_COUNT
    ? i : Math.floor(Math.random() * AVATAR_COUNT);
};

/** The Nimiq address is the account. Usernames are claimed once and never recycled. */
export function findOrCreate({ address, username, deviceHash, avatar }) {
  const existing = db.prepare('SELECT * FROM users WHERE address = ?').get(address);
  if (existing) {
    if (deviceHash && !existing.device_hash) {
      db.prepare('UPDATE users SET device_hash = ? WHERE id = ?').run(deviceHash, existing.id);
    }
    return existing;
  }

  const check = usernameAvailable(username);
  if (!check.ok) throw Object.assign(new Error(check.reason), { status: 400 });

  const info = db.prepare(
    `INSERT INTO users (address, username, username_ci, device_hash, points, avatar)
     VALUES (?, ?, ?, ?, 20, ?)`
  ).run(address, username, fold(username), deviceHash || null, pickAvatar(avatar));

  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  return db.prepare(
    'SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?'
  ).get(token) || null;
}

export const DAILY_POINTS = 5;

/** Daily points. Idempotent per calendar day — claiming twice does nothing. */
export function claimAllowance(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_allowance === today) return { claimed: 0, points: user.points };
  db.prepare('UPDATE users SET points = points + ?, last_allowance = ? WHERE id = ?')
    .run(DAILY_POINTS, today, user.id);
  const fresh = db.prepare('SELECT points FROM users WHERE id = ?').get(user.id);
  return { claimed: DAILY_POINTS, points: fresh.points };
}

/** Public profile. Stake sizes, weights and points balance are never exposed —
 *  per-market rep is withheld too, since rep plus the closing bar would let anyone
 *  reconstruct how much someone staked. */
export function publicProfile(username, viewer = null) {
  const u = db.prepare('SELECT id, username, address, rep, avatar, created_at FROM users WHERE username_ci = ?')
    .get(fold(username));
  if (!u) return null;

  const settled = db.prepare(`
    SELECT w.side, w.rep_delta, m.outcome
    FROM wagers w JOIN markets m ON m.id = w.market_id
    WHERE w.user_id = ? AND w.settled = 1 AND m.state = 'resolved'`).all(u.id);

  const played = settled.length;
  const correct = settled.filter(r => r.side === r.outcome.toLowerCase()).length;
  const contrarian = settled.filter(r => r.rep_delta >= 4).length;

  const open = db.prepare(`
    SELECT m.id, m.question, w.side
    FROM wagers w JOIN markets m ON m.id = w.market_id
    WHERE w.user_id = ? AND m.state IN ('open','closed')`).all(u.id);

  const tips = db.prepare(
    'SELECT COALESCE(SUM(amount_nim),0) AS total FROM tips WHERE to_id = ? AND verified = 1'
  ).get(u.id);

  // The calls this user made — not the positions they took on other people's.
  const posts = db.prepare(`
    SELECT id, COALESCE(raw_text, question) AS said, question, category, state, outcome, created_at
    FROM markets WHERE creator_id = ? ORDER BY created_at DESC LIMIT 30`).all(u.id);

  const followers = db.prepare('SELECT COUNT(*) n FROM follows WHERE followee_id = ?').get(u.id).n;
  const following = db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(u.id).n;
  const isFollowing = viewer
    ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewer.id, u.id)
    : false;

  return {
    username: u.username,
    // Needed to tip them, and public on chain regardless.
    address: u.address,
    rep: u.rep,
    avatar: u.avatar,
    joined: u.created_at,
    followers,
    following,
    isFollowing,
    isMe: !!viewer && viewer.id === u.id,
    played,
    correct,
    wins: correct,
    losses: played - correct,
    hitRate: played ? Math.round((correct / played) * 100) : null,
    contrarianWins: contrarian,
    tipsReceived: tips.total,
    openPositions: open,
    posts,
  };
}
