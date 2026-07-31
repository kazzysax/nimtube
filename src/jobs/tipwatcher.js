// Confirms tips against the chain.
//
// The client reports a transaction hash and an amount. Only the hash is worth
// anything — the amount is a claim, and this job replaces it with what the chain
// actually says. Until a tip passes every check below, `verified` stays 0 and it
// counts for nothing on a profile.

import { db } from '../core/db.js';
import { getTransactionByHash, sameAddress, decodeData } from '../core/rpc.js';

const TICK_MS = Number(process.env.TIPWATCHER_TICK_MS || 45_000);
const MIN_CONFIRMATIONS = Number(process.env.TIP_MIN_CONFIRMATIONS || 10);
const MAX_ATTEMPTS = Number(process.env.TIP_MAX_ATTEMPTS || 40);

export const tipMarker = toUsername => `predtube tip @${String(toUsername).toLowerCase()}`;
/** A tip-pool payout carries its own marker so it can never be confused with a
 *  voluntary tip — or reused to settle a different call's debt. */
export const poolMarker = (toUsername, marketId) =>
  `predtube pool @${String(toUsername).toLowerCase()} m${marketId}`;

/** Every reason a payment can fail. Ordered so the most diagnostic wins.
 *  `row.marker` is what the transaction must be tagged with on chain; `row.owed`,
 *  when set, is the minimum the chain must actually show. */
export function checkTransaction(tx, row, { minConfirmations = MIN_CONFIRMATIONS } = {}) {
  if (!tx) return { state: 'pending', reason: 'Not on chain yet' };

  if (tx.executionResult === false) return { state: 'failed', reason: 'Transaction failed on chain' };

  const conf = tx.confirmations ?? 0;
  if (conf < minConfirmations) {
    return { state: 'pending', reason: `Only ${conf}/${minConfirmations} confirmations` };
  }

  // A hash alone proves nothing — anyone could quote someone else's transaction.
  if (!sameAddress(tx.from, row.from_address)) {
    return { state: 'failed', reason: 'Sender is not the payer' };
  }
  if (!sameAddress(tx.to, row.to_address)) {
    return { state: 'failed', reason: 'Recipient is not the person being paid' };
  }

  // The marker ties the payment to the intended recipient, on chain, at send time.
  const marker = row.marker ?? tipMarker(row.to_username);
  const note = decodeData(tx.recipientData);
  if (!note.includes(marker)) {
    return { state: 'failed', reason: 'Transaction is not tagged for this payment' };
  }

  const value = Number(tx.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { state: 'failed', reason: 'No value transferred' };
  }

  // A debt is only settled if the chain shows at least what was promised. The
  // tolerance is one luna — floating point, not generosity.
  const amountNim = value / 1e5;
  if (row.owed != null && amountNim + 1e-5 < row.owed) {
    return { state: 'failed', reason: `Paid ${amountNim} NIM of the ${row.owed} NIM owed` };
  }

  // The chain decides the amount, not the client.
  return { state: 'verified', amountNim };
}

const pending = () => db.prepare(`
  SELECT t.id, t.market_id, t.amount_nim, t.tx_hash, t.attempts,
         f.address AS from_address, u.address AS to_address, u.username AS to_username
  FROM tips t
  JOIN users f ON f.id = t.from_id
  JOIN users u ON u.id = t.to_id
  WHERE t.verified = 0 AND t.failed_reason IS NULL AND t.attempts < ?
  ORDER BY t.created_at ASC LIMIT 25
`).all(MAX_ATTEMPTS);

/** Tip-pool payouts awaiting the chain. The award is only marked paid once the
 *  transaction the author reported clears every check. */
const pendingPayouts = () => db.prepare(`
  SELECT a.id, a.market_id, a.amount_nim AS owed, a.tx_hash, a.attempts,
         c.address AS from_address, u.address AS to_address, u.username AS to_username
  FROM bounty_awards a
  JOIN markets m ON m.id = a.market_id
  JOIN users c ON c.id = m.creator_id
  JOIN users u ON u.id = a.user_id
  WHERE a.paid = 0 AND a.tx_hash IS NOT NULL AND a.failed_reason IS NULL AND a.attempts < ?
  ORDER BY a.created_at ASC LIMIT 25
`).all(MAX_ATTEMPTS).map(a => ({ ...a, marker: poolMarker(a.to_username, a.market_id) }));

export async function tick() {
  if (!process.env.NIMIQ_RPC_URL) return;

  for (const tip of pending()) {
    let tx = null;
    try {
      tx = await getTransactionByHash(tip.tx_hash);
    } catch (e) {
      // Node trouble is not the tipper's fault — retry, never fail them for it.
      db.prepare('UPDATE tips SET attempts = attempts + 1 WHERE id = ?').run(tip.id);
      console.warn(`[tips] ${tip.tx_hash.slice(0, 12)}… rpc error: ${e.message}`);
      continue;
    }

    const verdict = checkTransaction(tx, tip);

    if (verdict.state === 'verified') {
      db.prepare('UPDATE tips SET verified = 1, amount_nim = ?, attempts = attempts + 1 WHERE id = ?')
        .run(verdict.amountNim, tip.id);
      console.log(`[tips] verified ${verdict.amountNim} NIM to @${tip.to_username}`);
    } else if (verdict.state === 'failed') {
      db.prepare('UPDATE tips SET failed_reason = ?, attempts = attempts + 1 WHERE id = ?')
        .run(verdict.reason, tip.id);
      console.warn(`[tips] rejected ${tip.tx_hash.slice(0, 12)}…: ${verdict.reason}`);
    } else {
      const next = tip.attempts + 1;
      db.prepare('UPDATE tips SET attempts = ? WHERE id = ?').run(next, tip.id);
      // A transaction that never lands would otherwise be retried forever.
      if (next >= MAX_ATTEMPTS) {
        db.prepare('UPDATE tips SET failed_reason = ? WHERE id = ?')
          .run('Never confirmed on chain', tip.id);
      }
    }
  }

  for (const a of pendingPayouts()) {
    let tx = null;
    try {
      tx = await getTransactionByHash(a.tx_hash);
    } catch (e) {
      db.prepare('UPDATE bounty_awards SET attempts = attempts + 1 WHERE id = ?').run(a.id);
      console.warn(`[pool] ${a.tx_hash.slice(0, 12)}… rpc error: ${e.message}`);
      continue;
    }

    const verdict = checkTransaction(tx, a);

    if (verdict.state === 'verified') {
      db.prepare('UPDATE bounty_awards SET paid = 1, attempts = attempts + 1 WHERE id = ?').run(a.id);
      console.log(`[pool] paid ${verdict.amountNim} NIM to @${a.to_username} on market ${a.market_id}`);
    } else if (verdict.state === 'failed') {
      // Clearing the hash lets the author try again rather than stranding the debt.
      db.prepare('UPDATE bounty_awards SET failed_reason = ?, tx_hash = NULL, attempts = attempts + 1 WHERE id = ?')
        .run(verdict.reason, a.id);
      console.warn(`[pool] rejected ${a.tx_hash.slice(0, 12)}…: ${verdict.reason}`);
    } else {
      const next = a.attempts + 1;
      db.prepare('UPDATE bounty_awards SET attempts = ? WHERE id = ?').run(next, a.id);
      if (next >= MAX_ATTEMPTS) {
        db.prepare('UPDATE bounty_awards SET failed_reason = ?, tx_hash = NULL WHERE id = ?')
          .run('Never confirmed on chain', a.id);
      }
    }
  }
}

export function start() {
  const run = () => tick().catch(e => console.error('[tips]', e));
  run();
  return setInterval(run, TICK_MS);
}
