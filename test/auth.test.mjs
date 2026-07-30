// Proves the session endpoint can no longer be handed an address it hasn't
// verified. Uses real Nimiq keypairs and real signatures.
process.env.DB_FILE = './data/auth.db';
process.env.NODE_ENV = 'test';
delete process.env.ALLOW_DEV_LOGIN;

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/auth.db' + s, { force: true }));

import { KeyPair } from '@nimiq/core';
const app = (await import('../src/server.js')).default;

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const srv = app.listen(4455);
const B = 'http://127.0.0.1:4455';
const j = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

const victim = KeyPair.generate();
const victimAddr = victim.toAddress().toUserFriendlyAddress();
const attacker = KeyPair.generate();

// --- the attack this closes -----------------------------------------------
let r = await j('POST', '/api/session', { address: victimAddr, username: 'victim' });
is(r.status === 401, 'address alone is refused — no session without proof');

// --- honest sign-in --------------------------------------------------------
r = await j('POST', '/api/challenge', { address: victimAddr });
const { message } = r.body;
is(/^PredTube login: [0-9a-f]{48}$/.test(message), 'challenge is a one-time nonce');

const sign = (kp, msg) => {
  const sig = kp.sign(Buffer.from(msg, 'utf8'));
  return { publicKey: kp.publicKey.toHex(), signature: sig.toHex() };
};

const proof = sign(victim, message);
r = await j('POST', '/api/session', { address: victimAddr, username: 'victim', message, ...proof });
is(r.status === 200 && !!r.body.token, 'a valid signature gets a session');
is(r.body.user.username === 'victim', 'the right account is opened');

// --- replay ----------------------------------------------------------------
r = await j('POST', '/api/session', { address: victimAddr, message, ...proof });
is(r.status === 401, 'the same challenge cannot be replayed');

// --- impersonation ---------------------------------------------------------
r = await j('POST', '/api/challenge', {});
const m2 = r.body.message;
const forged = sign(attacker, m2);                 // attacker signs, claims victim's address
r = await j('POST', '/api/session', { address: victimAddr, message: m2, ...forged });
is(r.status === 401, "signing with your own key while claiming someone else's address fails");
is(/does not match/i.test(r.body.error), 'and says exactly why');

// --- tampering -------------------------------------------------------------
r = await j('POST', '/api/challenge', {});
const m3 = r.body.message;
const good = sign(attacker, m3);
r = await j('POST', '/api/session', {
  address: attacker.toAddress().toUserFriendlyAddress(),
  message: m3.replace(/.$/, '0'), ...good,
});
is(r.status === 401, 'a tampered challenge is rejected');

// --- unknown nonce ---------------------------------------------------------
const fakeMsg = 'PredTube login: ' + 'a'.repeat(48);
r = await j('POST', '/api/session', { address: victimAddr, message: fakeMsg, ...sign(victim, fakeMsg) });
is(r.status === 401, 'a nonce the server never issued is rejected');

srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
