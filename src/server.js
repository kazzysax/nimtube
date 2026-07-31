import express from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db } from './core/db.js';
import {
  findOrCreate, issueSession, userForToken, claimAllowance,
  publicProfile, usernameAvailable, fold,
} from './core/users.js';
import { createMarket, placeWager, viewMarket, feed, myPositions, scheduleFrom } from './core/markets.js';
import { gate as gateText } from './core/terminal.js';
import { issueChallenge, verifyChallenge, devBypassAllowed } from './core/auth.js';
import { getAccountByAddress } from './core/rpc.js';
import * as resolverJob from './jobs/resolver.js';
import * as tipJob from './jobs/tipwatcher.js';

const app = express();
app.use(express.json());

const MAX_TIP_WINNERS = 20;   // a call's tip pool can name at most this many people

const here = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(here, '..', 'public')));

// ---- auth ----------------------------------------------------------------
function auth(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  req.user = userForToken(token);
  next();
}
app.use(auth);

const need = (req, res) => {
  if (!req.user) { res.status(401).json({ error: 'Sign in first' }); return false; }
  return true;
};

// Catches sync and async throws alike. The earlier Promise.resolve(fn(...)) form
// let synchronous throws escape to Express's HTML error page.
const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
};

// ---- session -------------------------------------------------------------

/** Step one: a one-time nonce for the client to sign. */
app.post('/api/challenge', wrap((req, res) => {
  res.json(issueChallenge(req.body?.address));
}));

/** Step two: the account is the Nimiq address, but only once it has been PROVEN.
 *  The client signs the nonce via nimiq.sign(), which Nimiq Pay gates behind a
 *  native dialog. Without this the endpoint would hand out sessions for any
 *  address a caller cared to type.
 *
 *  deviceHash comes from requestDeviceIdentifier() and is stored purely as an
 *  anti-alt signal — the docs are explicit that it must never be an identity. */
app.post('/api/session', wrap((req, res) => {
  const { address, username, deviceHash, avatar, publicKey, signature, message } = req.body || {};
  if (!address) throw Object.assign(new Error('address required'), { status: 400 });

  let proven = address;
  if (publicKey && signature && message) {
    proven = verifyChallenge({ address, publicKey, signature, message }).address;
  } else if (!devBypassAllowed()) {
    throw Object.assign(new Error('Signature required'), { status: 401 });
  }

  const existing = db.prepare('SELECT * FROM users WHERE address = ?').get(proven);
  if (!existing && !username) return res.json({ needsUsername: true });

  const user = findOrCreate({ address: proven, username, deviceHash, avatar });
  const token = issueSession(user.id);
  const allowance = claimAllowance(user);
  res.json({
    token,
    user: { username: user.username, rep: user.rep, points: allowance.points, avatar: user.avatar },
    dailyClaimed: allowance.claimed,
  });
}));

app.get('/api/username/:name', wrap((req, res) => res.json(usernameAvailable(req.params.name))));

app.get('/api/me', wrap((req, res) => {
  if (!need(req, res)) return;
  const u = db.prepare('SELECT username, rep, points, avatar FROM users WHERE id = ?').get(req.user.id);
  res.json(u);
}));

// ---- markets -------------------------------------------------------------

app.get('/api/feed', wrap((req, res) => {
  res.json(feed({
    user: req.user,
    category: req.query.category,
    state: req.query.state || 'open',
    scope: req.query.scope === 'all' ? 'all' : 'following',
  }));
}));

app.get('/api/markets/:id', wrap((req, res) => {
  const m = viewMarket(Number(req.params.id), req.user);
  if (!m) return res.status(404).json({ error: 'No such market' });
  res.json(m);
}));

/** Step one of posting: run the gate and show the author how their words will be
 *  settled, before anything exists. The verdict is held here rather than handed
 *  to the client — otherwise the terms they confirmed and the terms stored could
 *  differ by whatever the client felt like sending back. */
const drafts = new Map();
const DRAFT_TTL_MS = 15 * 60_000;

const reapDrafts = () => {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [id, d] of drafts) if (d.at < cutoff) drafts.delete(id);
};

app.post('/api/markets/draft', wrap(async (req, res) => {
  if (!need(req, res)) return;
  const { text } = req.body || {};
  if (!text || text.length < 5) throw Object.assign(new Error('Say more'), { status: 400 });

  reapDrafts();
  const verdict = await gateText(text);
  if (verdict.status !== 'approved') return res.json({ approved: false, ...verdict });

  const when = scheduleFrom(verdict);
  if (!when) {
    return res.json({
      approved: false,
      reason: 'That needs a deadline between 5 minutes and 7 days away. Say when it settles.',
      suggested_fix: null,
    });
  }

  const id = randomUUID();
  drafts.set(id, { at: Date.now(), userId: req.user.id, text, verdict });

  res.json({
    approved: true,
    draftId: id,
    said: text,
    terms: {
      question: verdict.question,
      category: verdict.category,
      source_tier: verdict.source_tier,
      source_name: verdict.source_name,
      source_detail: verdict.source_detail,
      criteria_yes: verdict.criteria_yes,
      criteria_no: verdict.criteria_no,
      closes_at: when.closes_at,
      resolves_at: when.resolves_at,
    },
  });
}));

/** Posts are the markets. Everything goes through the gate before it exists. */
app.post('/api/markets', wrap(async (req, res) => {
  if (!need(req, res)) return;
  const { text, draftId } = req.body || {};
  const tipNim = Number(req.body?.tipNim) || 0;
  const tipWinners = Number(req.body?.tipWinners) || 0;

  if (!draftId && (!text || text.length < 5)) {
    throw Object.assign(new Error('Say more'), { status: 400 });
  }
  if (tipNim < 0 || tipWinners < 0) {
    throw Object.assign(new Error('A tip cannot be negative'), { status: 400 });
  }
  if (tipNim > 0 && tipWinners < 1) {
    throw Object.assign(new Error('Say how many people the tip is split between'), { status: 400 });
  }
  if (tipWinners > 0 && tipNim <= 0) {
    throw Object.assign(new Error('Say how much NIM each winner gets'), { status: 400 });
  }
  if (tipWinners > MAX_TIP_WINNERS) {
    throw Object.assign(new Error(`A tip can name at most ${MAX_TIP_WINNERS} people`), { status: 400 });
  }
  // Confirming a draft reuses the verdict the author was actually shown, so the
  // terms they agreed to are the terms stored. No second gate call either.
  let out;
  if (draftId) {
    const d = drafts.get(draftId);
    if (!d || d.userId !== req.user.id) {
      throw Object.assign(new Error('That draft expired. Post it again.'), { status: 410 });
    }
    drafts.delete(draftId);
    out = await createMarket(req.user, d.text, { tipNim, tipWinners, verdict: d.verdict });
  } else {
    out = await createMarket(req.user, text, { tipNim, tipWinners });
  }
  res.status(out.approved ? 201 : 200).json(out);
}));

app.post('/api/markets/:id/wager', wrap((req, res) => {
  if (!need(req, res)) return;
  const { side, stake } = req.body || {};
  res.json(placeWager(req.user, Number(req.params.id), side, Number(stake)));
}));

/** Who took which side, and how hard. Reading the book costs you a position in
 *  it: you only see this once your own points are on the line, so nobody can
 *  farm everyone else's conviction without ever showing their own. */
app.get('/api/markets/:id/voters', wrap((req, res) => {
  if (!need(req, res)) return;
  const id = Number(req.params.id);

  const market = db.prepare('SELECT id FROM markets WHERE id = ?').get(id);
  if (!market) return res.status(404).json({ error: 'No such market' });

  const mine = db.prepare('SELECT 1 FROM wagers WHERE market_id = ? AND user_id = ?').get(id, req.user.id);
  if (!mine) {
    return res.status(403).json({ error: 'Pick a side to see who else is in' });
  }

  const rows = db.prepare(`
    SELECT u.username, u.rep, w.side, w.stake, w.weight, w.placed_at, w.rep_delta, w.settled
    FROM wagers w JOIN users u ON u.id = w.user_id
    WHERE w.market_id = ?
    ORDER BY w.weight DESC, w.placed_at ASC
  `).all(id);

  // Conviction is shown relative to the loudest voice in the room, so the shape
  // of the book reads at a glance without publishing anyone's balance.
  const loudest = rows.reduce((n, r) => Math.max(n, r.weight), 0) || 1;
  res.json(rows.map(r => ({
    username: r.username,
    rep: r.rep,
    side: r.side,
    stake: r.stake,
    conviction: Math.round((r.weight / loudest) * 100),
    settled: !!r.settled,
    rep_delta: r.rep_delta,
    isMe: r.username === req.user.username,
  })));
}));

/** The wagers I've placed on other people's calls — my side of the book. */
app.get('/api/positions', wrap((req, res) => {
  if (!need(req, res)) return;
  res.json(myPositions(req.user.id));
}));

// ---- people --------------------------------------------------------------

app.get('/api/users/:username', wrap((req, res) => {
  const p = publicProfile(req.params.username, req.user);
  if (!p) return res.status(404).json({ error: 'No such user' });
  res.json(p);
}));

const followTarget = (req, res) => {
  const t = db.prepare('SELECT id, username FROM users WHERE username_ci = ?').get(fold(req.params.username));
  if (!t) { res.status(404).json({ error: 'No such user' }); return null; }
  if (t.id === req.user.id) {
    throw Object.assign(new Error('You cannot follow yourself'), { status: 400 });
  }
  return t;
};

const followCounts = id => ({
  followers: db.prepare('SELECT COUNT(*) n FROM follows WHERE followee_id = ?').get(id).n,
});

app.post('/api/users/:username/follow', wrap((req, res) => {
  if (!need(req, res)) return;
  const target = followTarget(req, res);
  if (!target) return;
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)')
    .run(req.user.id, target.id);
  res.json({ following: true, ...followCounts(target.id) });
}));

app.delete('/api/users/:username/follow', wrap((req, res) => {
  if (!need(req, res)) return;
  const target = followTarget(req, res);
  if (!target) return;
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .run(req.user.id, target.id);
  res.json({ following: false, ...followCounts(target.id) });
}));

/** Explore is discovery: people you are not already following, ranked by record
 *  but never empty — a new app has nobody with ten settled calls yet. */
app.get('/api/explore', wrap((req, res) => {
  const me = req.user?.id ?? -1;
  res.json(db.prepare(`
    SELECT u.username, u.rep, u.avatar,
           (SELECT COUNT(*) FROM wagers w WHERE w.user_id = u.id AND w.settled = 1) AS played,
           (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers,
           (SELECT COUNT(*) FROM markets mk WHERE mk.creator_id = u.id) AS posts
    FROM users u
    WHERE u.id != ?
      AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
    ORDER BY u.rep DESC, followers DESC, posts DESC
    LIMIT 50
  `).all(me, me));
}));

/** Ranked by average rep per market, with a floor on markets played so a
 *  3-for-3 newcomer cannot top a veteran. Total shown alongside. */
app.get('/api/leaderboard', wrap((req, res) => {
  const MIN_PLAYED = Number(process.env.LEADERBOARD_MIN_PLAYED || 10);
  res.json(db.prepare(`
    SELECT u.username, u.rep, COUNT(w.id) AS played,
           ROUND(CAST(u.rep AS REAL) / COUNT(w.id), 2) AS average
    FROM users u JOIN wagers w ON w.user_id = u.id AND w.settled = 1
    GROUP BY u.id HAVING played >= ?
    ORDER BY average DESC, played DESC LIMIT 50
  `).all(MIN_PLAYED));
}));

// ---- money ---------------------------------------------------------------
// NIM never touches a wager. Tips and bounties are the only places it appears,
// and neither one can move reputation.

/** The client sends NIM through Nimiq Pay's own confirmation dialog, then reports
 *  the hash here. Nothing else it says is trusted: the amount recorded now is
 *  provisional and gets overwritten by the chain, and `verified` stays 0 until the
 *  watcher has matched sender, recipient, marker and value. Tipping is general —
 *  from the wallet by username, or from a profile's tip button — not tied to any
 *  particular market. */
app.post('/api/tips', wrap((req, res) => {
  if (!need(req, res)) return;
  const { toUsername, amountNim, txHash } = req.body || {};

  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
    throw Object.assign(new Error('A valid transaction hash is required'), { status: 400 });
  }
  if (!(Number(amountNim) > 0)) {
    throw Object.assign(new Error('Enter an amount'), { status: 400 });
  }

  const to = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
  if (!to) return res.status(404).json({ error: 'No such user' });
  if (to.id === req.user.id) throw Object.assign(new Error('You cannot tip yourself'), { status: 400 });

  try {
    db.prepare(`INSERT INTO tips (market_id, from_id, to_id, amount_nim, tx_hash)
                VALUES (NULL,?,?,?,?)`)
      .run(req.user.id, to.id, Number(amountNim), String(txHash).toLowerCase());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw Object.assign(new Error('That transaction has already been submitted'), { status: 409 });
    }
    throw e;
  }
  res.json({ ok: true, pendingVerification: true, marker: tipJob.tipMarker(toUsername) });
}));

/** What I owe as an author: the tip pools my settled calls promised their top
 *  scorers. Includes each winner's address so the client can pay them. */
app.get('/api/payouts', wrap((req, res) => {
  if (!need(req, res)) return;
  const rows = db.prepare(`
    SELECT a.id, a.market_id, a.amount_nim, a.failed_reason,
           a.tx_hash IS NOT NULL AS submitted,
           u.username, u.address, m.question
    FROM bounty_awards a
    JOIN markets m ON m.id = a.market_id
    JOIN users u ON u.id = a.user_id
    WHERE m.creator_id = ? AND a.paid = 0
    ORDER BY a.created_at ASC
  `).all(req.user.id);

  res.json(rows.map(r => ({
    ...r,
    submitted: !!r.submitted,
    marker: tipJob.poolMarker(r.username, r.market_id),
  })));
}));

/** Record the transaction that pays one award. Same trust model as tips: the
 *  hash is a claim, and the watcher decides whether the debt is actually clear. */
app.post('/api/payouts/:id', wrap((req, res) => {
  if (!need(req, res)) return;
  const { txHash } = req.body || {};
  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
    throw Object.assign(new Error('A valid transaction hash is required'), { status: 400 });
  }

  const award = db.prepare(`
    SELECT a.id, a.paid, m.creator_id FROM bounty_awards a
    JOIN markets m ON m.id = a.market_id WHERE a.id = ?`).get(Number(req.params.id));

  if (!award) return res.status(404).json({ error: 'No such award' });
  if (award.creator_id !== req.user.id) {
    throw Object.assign(new Error('Only the author of that call can pay it'), { status: 403 });
  }
  if (award.paid) throw Object.assign(new Error('That one is already paid'), { status: 409 });

  // A fresh attempt clears the last failure, otherwise the watcher would skip it.
  try {
    db.prepare('UPDATE bounty_awards SET tx_hash = ?, failed_reason = NULL, attempts = 0 WHERE id = ?')
      .run(String(txHash).toLowerCase(), award.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw Object.assign(new Error('That transaction has already been submitted'), { status: 409 });
    }
    throw e;
  }
  res.json({ ok: true, pendingVerification: true });
}));

app.get('/api/wallet', wrap(async (req, res) => {
  if (!need(req, res)) return;
  const sent = db.prepare('SELECT COALESCE(SUM(amount_nim),0) t FROM tips WHERE from_id=?').get(req.user.id).t;
  const recv = db.prepare('SELECT COALESCE(SUM(amount_nim),0) t FROM tips WHERE to_id=? AND verified=1').get(req.user.id).t;
  const pendingIn = db.prepare(
    'SELECT COALESCE(SUM(amount_nim),0) t FROM tips WHERE to_id=? AND verified=0 AND failed_reason IS NULL'
  ).get(req.user.id).t;
  const rejected = db.prepare(
    'SELECT tx_hash, failed_reason FROM tips WHERE from_id=? AND failed_reason IS NOT NULL ORDER BY created_at DESC LIMIT 10'
  ).all(req.user.id);
  // Tip-pool wins: NIM promised by a call's author for finishing among its top
  // scorers. Owed until the author pays it, so keep paid and unpaid apart.
  const pool = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN paid = 1 THEN amount_nim ELSE 0 END), 0) AS paid,
           COALESCE(SUM(CASE WHEN paid = 0 THEN amount_nim ELSE 0 END), 0) AS owed,
           COUNT(*) AS wins
    FROM bounty_awards WHERE user_id = ?`).get(req.user.id);
  const { points, address } = db.prepare('SELECT points, address FROM users WHERE id=?').get(req.user.id);
  // Best-effort: a dev-mode address has nothing on chain to look up, and the RPC
  // may simply not be configured. Either way the client shows "—", never a false 0.
  const balanceNim = process.env.NIMIQ_RPC_URL && !address.startsWith('NQDEV')
    ? await getAccountByAddress(address) : null;
  res.json({ points, balanceNim, tipsSent: sent, tipsReceived: recv, tipsPending: pendingIn, rejected, pool });
}));

// ---- ops -----------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/admin/tick', wrap(async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'nope' });
  }
  await resolverJob.tick();
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`PredTube on :${PORT}`);
    if (process.env.ANTHROPIC_API_KEY) resolverJob.start();
    else console.warn('[warn] ANTHROPIC_API_KEY unset — resolver idle, market creation will fail');
    if (process.env.NIMIQ_RPC_URL) tipJob.start();
    else console.warn('[warn] NIMIQ_RPC_URL unset — tips will never be verified');
  });
}

export default app;
