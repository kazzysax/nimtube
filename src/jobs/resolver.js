import { db } from '../core/db.js';
import { resolve } from '../core/terminal.js';
import { settleMarket } from '../core/markets.js';

const TICK_MS = Number(process.env.RESOLVER_TICK_MS || 60_000);
const MAX_ATTEMPTS = 4;           // retry a flaky source before calling it void
const RETRY_GAP_MS = 30 * 60_000;

const attempts = new Map();

/** Betting closes on the clock, so nobody can wager once the outcome is knowable. */
function closeDueMarkets() {
  const n = db.prepare(
    `UPDATE markets SET state='closed'
     WHERE state='open' AND datetime(closes_at) <= datetime('now')`
  ).run().changes;
  if (n) console.log(`[resolver] closed ${n} market(s)`);
}

async function resolveDueMarkets() {
  const due = db.prepare(
    `SELECT * FROM markets
     WHERE state='closed' AND datetime(resolves_at) <= datetime('now')
     ORDER BY resolves_at ASC LIMIT 10`
  ).all();

  for (const m of due) {
    const tries = attempts.get(m.id) || { count: 0, last: 0 };
    if (tries.count > 0 && Date.now() - tries.last < RETRY_GAP_MS) continue;

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
    if (verdict.outcome === 'VOID' && tries.count < MAX_ATTEMPTS - 1) {
      attempts.set(m.id, { count: tries.count + 1, last: Date.now() });
      console.log(`[resolver] market ${m.id} unsettled, retry ${tries.count + 1}/${MAX_ATTEMPTS}`);
      continue;
    }

    attempts.delete(m.id);
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
