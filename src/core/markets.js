import { db } from './db.js';
import { rawWeight, bar, sideTotals, settle, MIN_WAGERS_FOR_CAP } from './math.js';
import { gate } from './terminal.js';

const MAX_MARKETS_PER_DAY = 5;
const MIN_OPEN_MINUTES = 5;
const MAX_OPEN_MINUTES = 7 * 24 * 60;

/** The gate returns durations, not timestamps — models are unreliable at date
 *  arithmetic, and getting it wrong either buries a market a week out or, worse,
 *  opens one that is already past its close and settles on the resolver's next
 *  tick. The clock is applied here, where it is exact.
 *
 *  Out-of-range durations are refused rather than clamped: people wager
 *  reputation against these times, so a deadline nobody chose is not a fix. */
export function scheduleFrom(verdict, nowMs = Date.now()) {
  const open = Number(verdict.closes_in_minutes);
  const settle = Number(verdict.resolves_in_minutes ?? open);

  if (!Number.isFinite(open) || open < MIN_OPEN_MINUTES || open > MAX_OPEN_MINUTES) return null;
  if (!Number.isFinite(settle) || settle < open) return null;

  return {
    closes_at: new Date(nowMs + Math.round(open) * 60_000).toISOString(),
    resolves_at: new Date(nowMs + Math.round(settle) * 60_000).toISOString(),
  };
}

/** `verdict` is supplied when the author already confirmed a draft — reusing it
 *  means the terms they were shown are exactly the terms stored, and saves a
 *  second trip through the gate. */
export async function createMarket(user, rawText, { tipNim = 0, tipWinners = 0, verdict: preGated } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const made = db.prepare(
    "SELECT COUNT(*) n FROM markets WHERE creator_id = ? AND date(created_at) = ?"
  ).get(user.id, today).n;
  if (made >= MAX_MARKETS_PER_DAY) {
    throw Object.assign(new Error('Daily market limit reached'), { status: 429 });
  }

  const verdict = preGated ?? await gate(rawText);
  if (verdict.status !== 'approved') return { approved: false, ...verdict };

  const nowMs = Date.now();
  const when = scheduleFrom(verdict, nowMs);
  if (!when) {
    return {
      approved: false,
      reason: 'That needs a deadline between 5 minutes and 7 days away. Say when it settles.',
      suggested_fix: null,
    };
  }

  const now = new Date(nowMs).toISOString();
  const info = db.prepare(`
    INSERT INTO markets (creator_id, raw_text, question, category, source_tier, source_name,
      source_detail, criteria_yes, criteria_no, opens_at, closes_at, resolves_at,
      bounty_nim, bounty_winners)
    VALUES (@creator_id,@raw_text,@question,@category,@source_tier,@source_name,@source_detail,
      @criteria_yes,@criteria_no,@opens_at,@closes_at,@resolves_at,@bounty_nim,@bounty_winners)
  `).run({
    creator_id: user.id,
    // Kept verbatim. The feed is people talking, not a contract being read aloud.
    raw_text: String(rawText).trim(),
    question: verdict.question,
    category: verdict.category,
    source_tier: verdict.source_tier,
    source_name: verdict.source_name,
    source_detail: verdict.source_detail,
    criteria_yes: verdict.criteria_yes,
    criteria_no: verdict.criteria_no,
    opens_at: now,
    closes_at: when.closes_at,
    resolves_at: when.resolves_at,
    bounty_nim: tipNim,
    bounty_winners: tipWinners,
  });

  return { approved: true, market: getMarket(info.lastInsertRowid) };
}

export const getMarket = id => db.prepare('SELECT * FROM markets WHERE id = ?').get(id);

const wagersFor = id => db.prepare(
  'SELECT id, user_id AS userId, side, stake, weight, placed_at AS placedAt FROM wagers WHERE market_id = ?'
).all(id);

/** One wager per market. Enforced by a UNIQUE constraint, not by hope. */
export function placeWager(user, marketId, side, stake) {
  const m = getMarket(marketId);
  if (!m) throw Object.assign(new Error('No such market'), { status: 404 });
  if (m.state !== 'open') throw Object.assign(new Error('Market is closed'), { status: 400 });
  if (Date.parse(m.closes_at) <= Date.now()) {
    throw Object.assign(new Error('Market is closed'), { status: 400 });
  }
  if (!['yes', 'no'].includes(side)) throw Object.assign(new Error('Pick yes or no'), { status: 400 });
  if (!Number.isInteger(stake) || stake < 1) {
    throw Object.assign(new Error('Stake must be a whole number of points'), { status: 400 });
  }
  if (stake > user.points) throw Object.assign(new Error('Not enough points'), { status: 400 });

  const weight = rawWeight({
    stake,
    rep: user.rep,
    now: new Date().toISOString(),
    opensAt: m.opens_at,
    closesAt: m.closes_at,
  });

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO wagers (market_id, user_id, side, stake, rep_at_time, weight)
                VALUES (?,?,?,?,?,?)`).run(marketId, user.id, side, stake, user.rep, weight);
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(stake, user.id);
  });

  try {
    tx();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw Object.assign(new Error('You have already wagered on this market'), { status: 409 });
    }
    throw e;
  }

  return { ok: true, side, stake };
}

/** What a user is allowed to see. Blind until committed: the market detail and
 *  the comment thread are withheld until you've taken a side. The bar is the one
 *  public statistic, and it carries no numbers. */
export function viewMarket(marketId, user) {
  const m = getMarket(marketId);
  if (!m) return null;
  const ws = wagersFor(marketId);
  const mine = user ? ws.find(w => w.userId === user.id) : null;

  const base = {
    id: m.id,
    // What they said, and what it will actually be settled against. The feed
    // shows the first; the terms sheet shows the second.
    said: m.raw_text || m.question,
    question: m.question,
    category: m.category,
    source_tier: m.source_tier,
    source_name: m.source_name,
    source_detail: m.source_detail,
    criteria_yes: m.criteria_yes,
    criteria_no: m.criteria_no,
    closes_at: m.closes_at,
    resolves_at: m.resolves_at,
    state: m.state,
    // Stored in the bounty_* columns for historical reasons; surfaced as what it
    // now is — a tip the author pays to the top scorers when this settles.
    tipPool: m.bounty_nim > 0 ? { nim: m.bounty_nim, winners: m.bounty_winners } : null,
    bar: bar(ws),                    // always shown; starts at 50 and is damped early
    wagerCount: ws.length,
    committed: !!mine,
    mySide: mine ? mine.side : null,
  };

  if (m.state === 'resolved' || m.state === 'void') {
    base.outcome = m.outcome;
    base.void_reason = m.void_reason;
    const { yes, no, total } = sideTotals(ws);
    base.finalBar = total > 0 ? Math.round((yes / total) * 100) : null;
    if (mine) {
      const row = db.prepare('SELECT rep_delta FROM wagers WHERE id = ?').get(mine.id);
      base.myRepDelta = row.rep_delta;
    }
  }
  return base;
}

/** Settlement. Called only by the scheduled job, never by a request. */
export function settleMarket(marketId, outcome, log) {
  const m = getMarket(marketId);
  const ws = wagersFor(marketId);

  const voidIt = (reason) => db.transaction(() => {
    for (const w of ws) {
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(w.stake, w.userId);
      db.prepare('UPDATE wagers SET settled = 1, rep_delta = 0 WHERE id = ?').run(w.id);
    }
    db.prepare(`UPDATE markets SET state='void', void_reason=?, resolution_log=? WHERE id=?`)
      .run(reason, JSON.stringify(log || {}), marketId);
  })();

  if (outcome === 'VOID') { voidIt(log?.void_reason || 'Could not be settled'); return { void: true }; }

  const result = settle(ws, outcome.toLowerCase());
  if (result.void) { voidIt(result.reason); return { void: true }; }

  db.transaction(() => {
    for (const r of result.results) {
      db.prepare('UPDATE wagers SET settled = 1, rep_delta = ? WHERE id = ?')
        .run(r.repDelta, r.wagerId);
      db.prepare('UPDATE users SET points = points + ?, rep = rep + ? WHERE id = ?')
        .run(r.refund, r.repDelta, r.userId);
    }
    db.prepare(`UPDATE markets SET state='resolved', outcome=?, resolution_log=? WHERE id=?`)
      .run(outcome, JSON.stringify(log || {}), marketId);

    // Tip pool: the author promised this much NIM each to the top scorers on
    // this call. Ranked by the reputation the call actually earned them, so the
    // reward tracks how hard the read was — not how much they happened to stake.
    // Ties break towards whoever committed first.
    if (m.bounty_nim > 0 && m.bounty_winners > 0) {
      const placedAt = new Map(ws.map(w => [w.userId, w.placedAt]));
      const picked = result.results
        .filter(r => r.won)
        .sort((a, b) => b.repDelta - a.repDelta
          || String(placedAt.get(a.userId)).localeCompare(String(placedAt.get(b.userId))))
        .slice(0, m.bounty_winners);

      for (const r of picked) {
        db.prepare('INSERT INTO bounty_awards (market_id, user_id, amount_nim) VALUES (?,?,?)')
          .run(marketId, r.userId, m.bounty_nim);
      }
    }
  })();

  return { void: false, results: result.results };
}

/** Every wager this user has placed, newest first — their side of the book,
 *  as opposed to the calls they authored (see users.js publicProfile.posts). */
export function myPositions(userId, limit = 50) {
  return db.prepare(`
    SELECT m.id, COALESCE(m.raw_text, m.question) AS said, m.question, m.category, m.state, m.outcome, m.closes_at,
           w.side, w.stake, w.settled, w.rep_delta
    FROM wagers w JOIN markets m ON m.id = w.market_id
    WHERE w.user_id = ?
    ORDER BY w.placed_at DESC LIMIT ?
  `).all(userId, limit);
}

/** Following curates the feed: once you follow anyone, this is their calls plus
 *  your own. Follow nobody and you get everything — an empty feed teaches you
 *  nothing, and there is nobody to follow until you have seen someone worth it.
 *  `scope: 'all'` asks for everything regardless, which is what Explore uses. */
export function feed({ user, category, state = 'open', limit = 30, scope = 'following' }) {
  const followCount = user
    ? db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(user.id).n
    : 0;
  const curated = scope === 'following' && !!user && followCount > 0;

  const where = ['m.state = ?'];
  const args = [state];
  if (category) { where.push('m.category = ?'); args.push(category); }
  if (curated) {
    where.push(`(m.creator_id = ? OR m.creator_id IN
      (SELECT followee_id FROM follows WHERE follower_id = ?))`);
    args.push(user.id, user.id);
  }
  args.push(limit);

  const rows = db.prepare(`
    SELECT m.id FROM markets m
    WHERE ${where.join(' AND ')}
    ORDER BY m.created_at DESC LIMIT ?
  `).all(...args);

  return rows.map(r => {
    const v = viewMarket(r.id, user);
    const m = getMarket(r.id);
    const creator = db.prepare('SELECT username, rep, avatar FROM users WHERE id = ?').get(m.creator_id);
    return { ...v, creator, curated };
  });
}

export { MIN_WAGERS_FOR_CAP };
