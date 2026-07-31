import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db } from './core/db.js';
import {
  findOrCreate, issueSession, userForToken, claimAllowance,
  publicProfile, usernameAvailable,
} from './core/users.js';
import { createMarket, placeWager, viewMarket, feed, myPositions } from './core/markets.js';
import { issueChallenge, verifyChallenge, devBypassAllowed } from './core/auth.js';
import { getAccountByAddress } from './core/rpc.js';
import * as resolverJob from './jobs/resolver.js';
import * as tipJob from './jobs/tipwatcher.js';

const app = express();
app.use(express.json());

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
  const { address, username, deviceHash, publicKey, signature, message } = req.body || {};
  if (!address) throw Object.assign(new Error('address required'), { status: 400 });

  let proven = address;
  if (publicKey && signature && message) {
    proven = verifyChallenge({ address, publicKey, signature, message }).address;
  } else if (!devBypassAllowed()) {
    throw Object.assign(new Error('Signature required'), { status: 401 });
  }

  const existing = db.prepare('SELECT * FROM users WHERE address = ?').get(proven);
  if (!existing && !username) return res.json({ needsUsername: true });

  const user = findOrCreate({ address: proven, username, deviceHash });
  const token = issueSession(user.id);
  const allowance = claimAllowance(user);
  res.json({
    token,
    user: { username: user.username, rep: user.rep, points: allowance.points },
    dailyClaimed: allowance.claimed,
  });
}));

app.get('/api/username/:name', wrap((req, res) => res.json(usernameAvailable(req.params.name))));

app.get('/api/me', wrap((req, res) => {
  if (!need(req, res)) return;
  const u = db.prepare('SELECT username, rep, points FROM users WHERE id = ?').get(req.user.id);
  res.json(u);
}));

// ---- markets -------------------------------------------------------------

app.get('/api/feed', wrap((req, res) => {
  res.json(feed({
    user: req.user,
    category: req.query.category,
    state: req.query.state || 'open',
  }));
}));

app.get('/api/markets/:id', wrap((req, res) => {
  const m = viewMarket(Number(req.params.id), req.user);
  if (!m) return res.status(404).json({ error: 'No such market' });
  res.json(m);
}));

/** Posts are the markets. Everything goes through the gate before it exists. */
app.post('/api/markets', wrap(async (req, res) => {
  if (!need(req, res)) return;
  const { text, bountyNim = 0, bountyWinners = 0 } = req.body || {};
  if (!text || text.length < 5) throw Object.assign(new Error('Say more'), { status: 400 });
  if (bountyNim > 0 && bountyWinners < 1) {
    throw Object.assign(new Error('A bounty needs at least one winner'), { status: 400 });
  }
  const out = await createMarket(req.user, text, { bountyNim, bountyWinners });
  res.status(out.approved ? 201 : 200).json(out);
}));

app.post('/api/markets/:id/wager', wrap((req, res) => {
  if (!need(req, res)) return;
  const { side, stake } = req.body || {};
  res.json(placeWager(req.user, Number(req.params.id), side, Number(stake)));
}));

/** The wagers I've placed on other people's calls — my side of the book. */
app.get('/api/positions', wrap((req, res) => {
  if (!need(req, res)) return;
  res.json(myPositions(req.user.id));
}));

// ---- people --------------------------------------------------------------

app.get('/api/users/:username', wrap((req, res) => {
  const p = publicProfile(req.params.username);
  if (!p) return res.status(404).json({ error: 'No such user' });
  res.json(p);
}));

app.post('/api/users/:username/follow', wrap((req, res) => {
  if (!need(req, res)) return;
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'No such user' });
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)')
    .run(req.user.id, target.id);
  res.json({ following: true });
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
 *  watcher has matched sender, recipient, market tag and value. */
app.post('/api/markets/:id/tip', wrap((req, res) => {
  if (!need(req, res)) return;
  const { toUsername, amountNim, txHash } = req.body || {};
  const marketId = Number(req.params.id);

  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
    throw Object.assign(new Error('A valid transaction hash is required'), { status: 400 });
  }

  const market = db.prepare('SELECT state FROM markets WHERE id = ?').get(marketId);
  if (!market) return res.status(404).json({ error: 'No such market' });
  // Tips reward a proven call, so there has to be a call to reward.
  if (market.state !== 'resolved') {
    throw Object.assign(new Error('You can only tip a resolved market'), { status: 400 });
  }

  const to = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
  if (!to) return res.status(404).json({ error: 'No such user' });
  if (to.id === req.user.id) throw Object.assign(new Error('You cannot tip yourself'), { status: 400 });

  try {
    db.prepare(`INSERT INTO tips (market_id, from_id, to_id, amount_nim, tx_hash)
                VALUES (?,?,?,?,?)`)
      .run(marketId, req.user.id, to.id, Number(amountNim) || 0, String(txHash).toLowerCase());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw Object.assign(new Error('That transaction has already been submitted'), { status: 409 });
    }
    throw e;
  }
  res.json({ ok: true, pendingVerification: true, marker: tipJob.tipMarker(marketId) });
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
  const bounties = db.prepare('SELECT * FROM bounty_awards WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  const { points, address } = db.prepare('SELECT points, address FROM users WHERE id=?').get(req.user.id);
  // Best-effort: a dev-mode address has nothing on chain to look up, and the RPC
  // may simply not be configured. Either way the client shows "—", never a false 0.
  const balanceNim = process.env.NIMIQ_RPC_URL && !address.startsWith('NQDEV')
    ? await getAccountByAddress(address) : null;
  res.json({ points, balanceNim, tipsSent: sent, tipsReceived: recv, tipsPending: pendingIn, rejected, bounties });
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
