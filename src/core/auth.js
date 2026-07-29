// Proof of address ownership.
//
// Without this, /api/session takes whatever address the client sends. Anyone could
// post someone else's Nimiq address and receive a valid session for their account —
// their reputation, their points, their tip destination. The provider exposes
// `sign()`, so there is no excuse for trusting the client here.
//
// Flow: server issues a one-time nonce -> client signs it through Nimiq Pay's native
// dialog -> server checks the signature and that the public key derives to the
// claimed address.

import crypto from 'crypto';
import { PublicKey, Signature, Hash } from '@nimiq/core';
import { db } from './db.js';

const TTL_MS = 5 * 60_000;

export function issueChallenge(address) {
  const nonce = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO challenges (nonce, address) VALUES (?, ?)').run(nonce, address || null);
  db.prepare("DELETE FROM challenges WHERE created_at < datetime('now', '-1 hour')").run();
  return { nonce, message: `NimTube login: ${nonce}` };
}

/** Nimiq's convention for signed messages prefixes and hashes the payload before
 *  signing. Nimiq Pay's `sign()` may or may not apply it, so both are tried. */
function prefixedDigest(message) {
  const msg = Buffer.from(message, 'utf8');
  const prefix = Buffer.from('\x16Nimiq Signed Message:\n', 'utf8');
  const len = Buffer.from(String(msg.length), 'utf8');
  return Buffer.from(Hash.computeSha256(Buffer.concat([prefix, len, msg])));
}

export function verifyChallenge({ address, publicKey, signature, message }) {
  const m = /NimTube login: ([0-9a-f]{48})/.exec(message || '');
  if (!m) throw Object.assign(new Error('Malformed challenge'), { status: 400 });
  const nonce = m[1];

  const row = db.prepare('SELECT * FROM challenges WHERE nonce = ?').get(nonce);
  if (!row) throw Object.assign(new Error('Unknown or already-used challenge'), { status: 401 });

  // One use only, whatever happens next.
  db.prepare('DELETE FROM challenges WHERE nonce = ?').run(nonce);

  if (Date.now() - Date.parse(row.created_at + 'Z') > TTL_MS) {
    throw Object.assign(new Error('Challenge expired'), { status: 401 });
  }

  let pk, sig;
  try {
    pk = PublicKey.fromHex(publicKey);
    sig = Signature.fromHex(signature);
  } catch {
    throw Object.assign(new Error('Malformed key or signature'), { status: 400 });
  }

  // The public key must actually belong to the address being claimed.
  const derived = pk.toAddress().toUserFriendlyAddress();
  const norm = s => String(s).replace(/\s+/g, '').toUpperCase();
  if (norm(derived) !== norm(address)) {
    throw Object.assign(new Error('Signature does not match that address'), { status: 401 });
  }

  const raw = Buffer.from(message, 'utf8');
  const ok = pk.verify(sig, raw) || pk.verify(sig, prefixedDigest(message));
  if (!ok) throw Object.assign(new Error('Bad signature'), { status: 401 });

  return { address: derived };
}

/** Outside Nimiq Pay there is no wallet to sign with, so local development would be
 *  impossible. Allowed only when explicitly enabled, never in production. */
export function devBypassAllowed() {
  return process.env.ALLOW_DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';
}
