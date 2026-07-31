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

/** Every reason a tip can fail. Ordered so the most diagnostic wins. */
export function checkTransaction(tx, tip, { minConfirmations = MIN_CONFIRMATIONS } = {}) {
  if (!tx) return { state: 'pending', reason: 'Not on chain yet' };

  if (tx.executionResult === false) return { state: 'failed', reason: 'Transaction failed on chain' };

  const conf = tx.confirmations ?? 0;
  if (conf < minConfirmations) {
    return { state: 'pending', reason: `Only ${conf}/${minConfirmations} confirmations` };
  }

  // A hash alone proves nothing — anyone could quote someone else's transaction.
  if (!sameAddress(tx.from, tip.from_address)) {
    return { state: 'failed', reason: 'Sender is not the tipper' };
  }
  if (!sameAddress(tx.to, tip.to_address)) {
    return { state: 'failed', reason: 'Recipient is not the person being tipped' };
  }

  // The marker ties the payment to the intended recipient, on chain, at send time.
  const note = decodeData(tx.recipientData);
  if (!note.includes(tipMarker(tip.to_username))) {
    return { state: 'failed', reason: 'Transaction is not tagged as a tip for this person' };
  }

  const value = Number(tx.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { state: 'failed', reason: 'No value transferred' };
  }

  // The chain decides the amount, not the client.
  return { state: 'verified', amountNim: value / 1e5 };
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
}

export function start() {
  const run = () => tick().catch(e => console.error('[tips]', e));
  run();
  return setInterval(run, TICK_MS);
}
