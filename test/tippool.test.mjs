// The tip pool an author attaches to a call: X NIM each to the top N scorers,
// paid out when the call settles. Ranking is by the reputation the call earned
// each person — the sharpest reads, not the biggest stakes.
process.env.DB_FILE = './data/tippool.db';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = '1';

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/tippool.db' + s, { force: true }));

const { db } = await import('../src/core/db.js');
const app = (await import('../src/server.js')).default;
const { settleMarket } = await import('../src/core/markets.js');

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const srv = app.listen(4488);
const B = 'http://127.0.0.1:4488';
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const author = (await j('POST', '/api/session', { address: 'NQ01 AUTH', username: 'author' })).body;

// ---- what the post terminal is allowed to send ----------------------------
let r = await j('POST', '/api/markets', { text: 'will it rain tomorrow', tipNim: 0.5 }, author.token);
is(r.status === 400 && /how many people/i.test(r.body.error), 'an amount with nobody to pay is refused');

r = await j('POST', '/api/markets', { text: 'will it rain tomorrow', tipWinners: 5 }, author.token);
is(r.status === 400 && /how much/i.test(r.body.error), 'a headcount with no amount is refused');

r = await j('POST', '/api/markets', { text: 'will it rain tomorrow', tipNim: -1, tipWinners: 5 }, author.token);
is(r.status === 400 && /negative/i.test(r.body.error), 'a negative tip is refused');

r = await j('POST', '/api/markets', { text: 'will it rain tomorrow', tipNim: 0.5, tipWinners: 999 }, author.token);
is(r.status === 400 && /at most/i.test(r.body.error), 'an absurd headcount is refused');

// ---- settlement pays the top scorers, not a random draw -------------------
// Six people take a side. The YES minority is the harder, better-rewarded read,
// so they must outrank the NO majority when the tip is handed out.
const now = new Date().toISOString();
db.prepare(`INSERT INTO markets
  (id,creator_id,question,category,source_tier,source_name,source_detail,criteria_yes,criteria_no,
   opens_at,closes_at,resolves_at,state,bounty_nim,bounty_winners)
  VALUES (1,1,'Q?','crypto','auto','X','y','a','b',?,?,?,'open',0.1,2)`).run(now, now, now);

const users = [];
for (let i = 0; i < 6; i++) {
  const u = (await j('POST', '/api/session', { address: `NQ9${i} U${i}`, username: 'caller' + i })).body;
  users.push(u);
}
const uid = n => db.prepare('SELECT id FROM users WHERE username = ?').get('caller' + n).id;

// p0, p1 on the unpopular YES side; p2..p5 pile onto NO. YES turns out correct.
const wager = (n, side, stake) => db.prepare(
  `INSERT INTO wagers (market_id,user_id,side,stake,rep_at_time,weight,placed_at)
   VALUES (1,?,?,?,0,?,?)`
).run(uid(n), side, stake, stake, `2026-01-0${n + 1}T00:00:00Z`);

wager(0, 'yes', 3);
wager(1, 'yes', 3);
wager(2, 'no', 10);
wager(3, 'no', 10);
wager(4, 'no', 10);
wager(5, 'no', 10);

settleMarket(1, 'YES', {});

const awards = db.prepare(
  'SELECT user_id, amount_nim FROM bounty_awards WHERE market_id = 1 ORDER BY user_id'
).all();

is(awards.length === 2, 'exactly as many people are paid as the author named');
is(awards.every(a => a.amount_nim === 0.1), 'each of them gets the stated amount');

const paid = new Set(awards.map(a => a.user_id));
is(paid.has(uid(0)) && paid.has(uid(1)), 'the two correct minority callers are the ones paid');
is(![2, 3, 4, 5].some(n => paid.has(uid(n))), 'nobody on the losing side is paid');

// A bigger stake on the same side must not buy a place in the pool.
const deltas = db.prepare('SELECT user_id, rep_delta FROM wagers WHERE market_id = 1').all();
const winnerDeltas = deltas.filter(d => paid.has(d.user_id)).map(d => d.rep_delta);
const loserDeltas = deltas.filter(d => !paid.has(d.user_id)).map(d => d.rep_delta);
is(Math.min(...winnerDeltas) > Math.max(...loserDeltas),
   'everyone paid scored strictly higher than everyone who was not');

// ---- the wallet reports what is owed --------------------------------------
const w = (await j('GET', '/api/wallet', null, users[0].token)).body;
is(w.pool.wins === 1 && w.pool.owed === 0.1, 'the winner sees the tip as owed until it is paid');
is(w.bounties === undefined, 'the wallet no longer speaks of bounties');

// ---- paying it -------------------------------------------------------------
const tips = await import('../src/jobs/tipwatcher.js');
const H = n => String(n).repeat(64).slice(0, 64);

let owed = (await j('GET', '/api/payouts', null, author.token)).body;
is(owed.length === 2, 'the author is shown both debts');
is(owed.every(a => a.address && a.marker), 'each debt carries the address to pay and the marker to tag it with');
is(owed[0].marker === `predtube pool @${owed[0].username} m1`, 'the marker names the recipient and the call');

const mine = (await j('GET', '/api/payouts', null, users[0].token)).body;
is(mine.length === 0, 'a winner is not shown debts that are not theirs');

r = await j('POST', `/api/payouts/${owed[0].id}`, { txHash: 'nope' }, author.token);
is(r.status === 400, 'a malformed hash is refused');

r = await j('POST', `/api/payouts/${owed[0].id}`, { txHash: H('a') }, users[0].token);
is(r.status === 403, 'somebody else cannot mark the debt paid');

r = await j('POST', `/api/payouts/${owed[0].id}`, { txHash: H('a') }, author.token);
is(r.status === 200, 'the author can report the transaction that pays it');

owed = (await j('GET', '/api/payouts', null, author.token)).body;
is(owed.find(a => a.id === owed[0].id) === undefined || owed[0].submitted,
   'a reported debt shows as confirming, not as still unpaid work');

// The watcher decides whether it really cleared.
const target = db.prepare(`SELECT a.id, a.amount_nim, u.username, u.address, c.address AS from_address
  FROM bounty_awards a JOIN markets m ON m.id=a.market_id
  JOIN users u ON u.id=a.user_id JOIN users c ON c.id=m.creator_id WHERE a.id = ?`).get(owed[0].id ?? 1);

const marker = tips.poolMarker(target.username, 1);
const good = {
  from: target.from_address, to: target.address,
  value: Math.round(target.amount_nim * 1e5),
  recipientData: Buffer.from(marker, 'utf8').toString('hex'),
  confirmations: 12,
};
const row = { from_address: target.from_address, to_address: target.address, marker, owed: target.amount_nim };
const chk = over => tips.checkTransaction({ ...good, ...over }, row);

is(chk({}).state === 'verified', 'a correctly tagged, full payment verifies');
is(chk({ value: Math.round(target.amount_nim * 1e5) - 1000 }).state === 'failed',
   'underpaying the promised amount does not clear the debt');
is(chk({ recipientData: Buffer.from(tips.tipMarker(target.username)).toString('hex') }).state === 'failed',
   'a plain tip cannot be passed off as a pool payout');
is(chk({ recipientData: Buffer.from(tips.poolMarker(target.username, 999)).toString('hex') }).state === 'failed',
   "another call's payout cannot settle this one");
is(chk({ from: 'NQ77 STRANGER' }).state === 'failed', 'a payment from somebody else does not count');

// End to end: the watcher marks it paid and the debt disappears. The RPC mock
// has to be put back afterwards — this test talks to its own server over fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { data: good } }),
});
process.env.NIMIQ_RPC_URL = 'http://mock/rpc';
await tips.tick();
globalThis.fetch = realFetch;

is(db.prepare('SELECT paid FROM bounty_awards WHERE id = ?').get(target.id).paid === 1,
   'the watcher marks the award paid');
const after = (await j('GET', '/api/payouts', null, author.token)).body;
is(after.length === 1, 'and it drops off what the author still owes');
is(after[0].id !== target.id, 'the one still owed is the other winner');

console.log(fails ? `\n${fails} FAILED` : '\nall green');
srv.close();
process.exit(fails ? 1 : 0);
