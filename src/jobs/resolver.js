import { db } from '../core/db.js';
import { resolve } from '../core/terminal.js';
import { settleMarket } from '../core/markets.js';

const TICK_MS = Number(process.env.RESOLVER_TICK_MS || 60_000);
const MAX_ATTEMPTS = 4;           // retry a flaky source before calling it void
const RETRY_GAP_MS = 30 * 60_000;

/** Betting closes on the clock, so nobody can wager once the outcome is knowable. */
function closeDueMarkets() {
  const n = db.prepare(
    `UPDATE markets SET state='closed'
     WHERE state='open' AND datetime(closes_at) <= datetime('now')`
  ).run().changes;
  if (n) console.log(`[resolver] closed ${n} market(s)`);
}

/** A wager with nobody on the other side can never settle — settle() void it
 *  regardless of what the resolver finds (see markets.js). Checking that here,
 *  before paying for a Claude call with web search, means a one-sided market
 *  costs nothing to void and doesn't sit in a retry queue for no reason. */
const isTwoSided = marketId => {
  const sides = db.prepare('SELECT DISTINCT side FROM wagers WHERE market_id = ?').all(marketId);
  return sides.length >= 2;
};

async function resolveDueMarkets() {
  const due = db.prepare(
    `SELECT * FROM markets
     WHERE state='closed' AND datetime(resolves_at) <= datetime('now')
     ORDER BY resolves_at ASC LIMIT 10`
  ).all();

  for (const m of due) {
    if (!isTwoSided(m.id)) {
      settleMarket(m.id, 'VOID', { void_reason: 'No wagers on one side' });
      console.log(`[resolver] market ${m.id} -> VOID (one-sided, skipped resolution)`);
      continue;
    }

    // Retry state lives on the row itself, not in memory, so a deploy mid-retry
    // doesn't quietly reset the clock and retry forever.
    //
    // resolve_last_try is written via strftime(...,'Z') specifically so it is
    // unambiguous UTC — SQLite's own datetime('now') omits the 'Z', and
    // Date.parse() on a 'YYYY-MM-DD HH:MM:SS' string with no zone reads it as
    // *local* time, which silently broke this gap by the server's UTC offset.
    if (m.resolve_attempts > 0 && m.resolve_last_try
        && Date.now() - Date.parse(m.resolve_last_try) < RETRY_GAP_MS) continue;

    let verdict;
    try {
      verdict = await resolve({
        id: m.id,
        question: m.question,
        source_name: m.source_name,
        source_detail: m.source_detail,
        criteria_yes: m.criteria_yes,
        criteria_no: m.criteria_no,
        closes_at: m.closes_at,
        resolves_at: m.resolves_at,
      });
    } catch (e) {
      verdict = { outcome: 'VOID', void_reason: `Resolver error: ${e.message}` };
    }

    // A source can be temporarily unreachable. Don't void on the first miss.
    if (verdict.outcome === 'VOID' && m.resolve_attempts < MAX_ATTEMPTS - 1) {
      db.prepare("UPDATE markets SET resolve_attempts = resolve_attempts + 1, resolve_last_try = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run(m.id);
      console.log(`[resolver] market ${m.id} unsettled, retry ${m.resolve_attempts + 1}/${MAX_ATTEMPTS}`);
      continue;
    }

    const out = settleMarket(m.id, verdict.outcome, verdict);
    console.log(`[resolver] market ${m.id} -> ${verdict.outcome}${out.void ? ' (void, refunded)' : ''}`);
  }
}

export async function tick() {
  closeDueMarkets();
  await resolveDueMarkets();
}

export function start() {
  const run = () => tick().catch(e => console.error('[resolver]', e));
  run();
  return setInterval(run, TICK_MS);
}
