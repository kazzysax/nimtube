// Tip verification. The chain is mocked, but every rule the watcher enforces is
// exercised — including the ones that matter if someone lies to the API.
process.env.DB_FILE = './data/tips.db';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = '1';
process.env.NIMIQ_RPC_URL = 'http://mock/rpc';

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/tips.db' + s, { force: true }));

const { db } = await import('../src/core/db.js');
const app = (await import('../src/server.js')).default;
const tips = await import('../src/jobs/tipwatcher.js');

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const srv = app.listen(4477);
const B = 'http://127.0.0.1:4477';
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

// two users
const A = (await j('POST', '/api/session', { address: 'NQ11 AAAA', username: 'alice' })).body;
const C = (await j('POST', '/api/session', { address: 'NQ22 CCCC', username: 'caller' })).body;

const now = new Date().toISOString();
const mk = (id, state) => db.prepare(`INSERT INTO markets
  (id,creator_id,question,category,source_tier,source_name,source_detail,criteria_yes,criteria_no,opens_at,closes_at,resolves_at,state,outcome)
  VALUES (?,2,'Q?','crypto','auto','X','y','a','b',?,?,?,?, 'YES')`).run(id, now, now, now, state);
mk(1, 'resolved');
mk(2, 'open');

const H = n => String(n).repeat(64).slice(0, 64);

// ---- endpoint validation --------------------------------------------------
let r = await j('POST', '/api/markets/1/tip', { toUsername: 'caller', amountNim: 0.5, txHash: 'nope' }, A.token);
is(r.status === 400, 'a malformed transaction hash is refused');

r = await j('POST', '/api/markets/2/tip', { toUsername: 'caller', amountNim: 0.5, txHash: H('a') }, A.token);
is(r.status === 400 && /resolved/.test(r.body.error), 'you cannot tip an unresolved market');

r = await j('POST', '/api/markets/1/tip', { toUsername: 'alice', amountNim: 0.5, txHash: H('a') }, A.token);
is(r.status === 400 && /yourself/.test(r.body.error), 'you cannot tip yourself');

r = await j('POST', '/api/markets/1/tip', { toUsername: 'caller', amountNim: 0.5, txHash: H('a') }, A.token);
is(r.status === 200 && r.body.marker === 'nimtube tip m1', 'a good tip is accepted and returns its on-chain marker');

r = await j('POST', '/api/markets/1/tip', { toUsername: 'caller', amountNim: 0.5, txHash: H('a') }, A.token);
is(r.status === 409, 'the same transaction cannot be submitted twice');

// ---- the checks the watcher applies ---------------------------------------
const tip = { market_id: 1, from_address: 'NQ11 AAAA', to_address: 'NQ22 CCCC', amount_nim: 0.5 };
const data = Buffer.from('nimtube tip m1', 'utf8').toString('hex');
const good = { from: 'NQ11AAAA', to: 'NQ22CCCC', value: 50000, recipientData: data, confirmations: 12 };
const chk = (over, opts) => tips.checkTransaction({ ...good, ...over }, tip, opts);

is(chk({}).state === 'verified', 'a well-formed transaction verifies');
is(chk({}).amountNim === 0.5, 'the amount comes from the chain, not the client');
is(tips.checkTransaction(null, tip).state === 'pending', 'a hash the node has never seen stays pending');
is(chk({ confirmations: 2 }).state === 'pending', 'too few confirmations stays pending');
is(chk({ executionResult: false }).state === 'failed', 'a transaction that failed on chain is rejected');
is(chk({ from: 'NQ99 SOMEONE ELSE' }).state === 'failed', "quoting someone else's payment is rejected");
is(chk({ to: 'NQ99 WRONG' }).state === 'failed', 'a payment to the wrong person is rejected');
is(chk({ recipientData: Buffer.from('nimtube tip m7').toString('hex') }).state === 'failed',
   'a payment tagged for a different market is rejected');
is(chk({ recipientData: '' }).state === 'failed', 'an untagged payment is rejected');
is(chk({ value: 0 }).state === 'failed', 'a zero-value payment is rejected');

// the lie that matters: claim 500 NIM, send 0.5
const liar = { market_id: 1, from_address: 'NQ11 AAAA', to_address: 'NQ22 CCCC', amount_nim: 500 };
const v = tips.checkTransaction(good, liar);
is(v.state === 'verified' && v.amountNim === 0.5, 'an inflated claim is overwritten by the real value');

// addresses with different spacing and case still match
is(chk({ from: 'nq11 aa aa', to: 'NQ22CCCC' }).state === 'verified', 'address spacing and case are normalised');

// ---- the watcher end to end ------------------------------------------------
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ jsonrpc: '2.0', id: 1, result: { data: good } }),
});
await tips.tick();
const row = db.prepare('SELECT verified, amount_nim FROM tips WHERE tx_hash = ?').get(H('a'));
is(row.verified === 1, 'the watcher marks a good tip verified');
is(row.amount_nim === 0.5, 'and rewrites the amount to the on-chain value');

console.log(fails ? `\n${fails} FAILED` : '\nall green');
srv.close();
process.exit(fails ? 1 : 0);
