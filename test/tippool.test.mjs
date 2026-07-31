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

console.log(fails ? `\n${fails} FAILED` : '\nall green');
srv.close();
process.exit(fails ? 1 : 0);
