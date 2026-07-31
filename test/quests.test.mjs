// The welcome checklist: follow 2 people, post once, place 3 wagers. Each is
// paid exactly once, the moment its target is first reached — not before, not
// twice, regardless of which of the three call sites triggers the check.
process.env.DB_FILE = './data/quests.db';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = '1';

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/quests.db' + s, { force: true }));

const { db } = await import('../src/core/db.js');
const app = (await import('../src/server.js')).default;

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const srv = app.listen(4477 + 11);
const B = `http://127.0.0.1:${4477 + 11}`;
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const main = (await j('POST', '/api/session', { address: 'NQ01 MAIN', username: 'mainuser' })).body;
const a = (await j('POST', '/api/session', { address: 'NQ02 AAAA', username: 'quester_a' })).body;
const b = (await j('POST', '/api/session', { address: 'NQ03 BBBB', username: 'quester_b' })).body;
const c = (await j('POST', '/api/session', { address: 'NQ04 CCCC', username: 'quester_c' })).body;

const points = tok => j('GET', '/api/me', null, tok).then(r => r.body.points);
const quests = tok => j('GET', '/api/quests', null, tok).then(r => r.body);

// ---- follow2 ----------------------------------------------------------
let before = await points(main.token);
let r = await j('POST', '/api/users/quester_a/follow', null, main.token);
is(r.status === 200, 'following the 1st person succeeds');
is((await points(main.token)) === before, 'following just 1 person pays nothing yet');

let q = await quests(main.token);
const follow2 = k => q.find(x => x.key === k);
is(follow2('follow2').progress === 1 && follow2('follow2').done === false,
   'the checklist shows 1/2, not yet done');

r = await j('POST', '/api/users/quester_b/follow', null, main.token);
is((await points(main.token)) === before + 5, 'following the 2nd person pays the +5 reward');
q = await quests(main.token);
is(follow2('follow2').progress === 2 && follow2('follow2').done === true,
   'and the checklist now shows it done');

before = await points(main.token);
r = await j('POST', '/api/users/quester_c/follow', null, main.token);
is((await points(main.token)) === before, 'a 3rd follow does not pay it again');

// ---- post1 ----------------------------------------------------------
const now = new Date().toISOString(), later = new Date(Date.now() + 6 * 36e5).toISOString();
const mk = (id, creator, side_free = true) => db.prepare(`INSERT INTO markets
  (id,creator_id,raw_text,question,category,source_tier,source_name,source_detail,criteria_yes,criteria_no,
   opens_at,closes_at,resolves_at,state)
  VALUES (?,?,?,?,'Crypto','auto','X','y','a','b',?,?,?,'open')`)
  .run(id, creator, 'raw ' + id, 'Q' + id, now, later, later);

// createMarket is what pays the quest, and it needs a real gate call — instead
// exercise the same code path directly, the way tippool.test.mjs does.
const { createMarket } = await import('../src/core/markets.js');
const verdict = {
  status: 'approved', question: 'Will it happen?', category: 'Crypto',
  source_tier: 'auto', source_name: 'X', source_detail: 'y',
  criteria_yes: 'a', criteria_no: 'b', closes_in_minutes: 60, resolves_in_minutes: 75,
};

before = await points(a.token);
q = await quests(a.token);
is(q.find(x => x.key === 'post1').done === false, 'post1 starts undone');

const mainRow = db.prepare('SELECT id, rep, points FROM users WHERE username = ?').get('quester_a');
const out = await createMarket({ id: mainRow.id, rep: mainRow.rep, points: mainRow.points }, 'my first call', { verdict });
is(out.approved, 'the market itself is created');

// createMarket does not award quests on its own — that happens in the server
// route, one layer up. Call the same check the route calls.
const { checkAndAward } = await import('../src/core/quests.js');
const completed = checkAndAward(mainRow.id);
is(completed.length === 1 && completed[0].key === 'post1', 'checkAndAward reports post1 as newly completed');
is((await points(a.token)) === before + 2, 'and it pays the +2 reward');

const again = checkAndAward(mainRow.id);
is(again.length === 0, 'calling it again after the fact awards nothing');
is((await points(a.token)) === before + 2, 'balance is unchanged');

// ---- wager3 ----------------------------------------------------------
mk(101, mainRow.id, true);
mk(102, mainRow.id, true);
mk(103, mainRow.id, true);
// b takes the other side directly, purely so each market has both sides for
// c to wager into — b's own quest progress is not what's under test here.
const bRow = db.prepare('SELECT id FROM users WHERE username = ?').get('quester_b');
for (const id of [101, 102, 103]) {
  db.prepare('INSERT INTO wagers (market_id,user_id,side,stake,rep_at_time,weight) VALUES (?,?,?,?,0,?)')
    .run(id, bRow.id, 'no', 1, 1);
}

const cBefore = await points(c.token);
r = await j('POST', '/api/markets/101/wager', { side: 'yes', stake: 1 }, c.token);
is(r.status === 200 && r.body.stake === 1, 'placing the 1st wager succeeds and deducts the stake');
is((await points(c.token)) === cBefore - 1, 'balance reflects just that one stake so far');

q = await quests(c.token);
is(q.find(x => x.key === 'wager3').progress === 1 && q.find(x => x.key === 'wager3').done === false,
   'wager3 shows 1/3, not yet done');

r = await j('POST', '/api/markets/102/wager', { side: 'yes', stake: 1 }, c.token);
is((await points(c.token)) === cBefore - 2, 'the 2nd wager still pays nothing extra');

r = await j('POST', '/api/markets/103/wager', { side: 'yes', stake: 1 }, c.token);
const cAfter = await points(c.token);
is(cAfter === cBefore - 3 + 3, 'the 3rd wager stakes 1 and immediately pays the +3 wager3 reward');

q = await quests(c.token);
is(q.find(x => x.key === 'wager3').done === true && q.find(x => x.key === 'wager3').progress === 3,
   'the checklist shows wager3 done at 3/3');

r = await j('POST', '/api/markets/101/wager', { side: 'yes', stake: 1 }, c.token).catch(() => null);
// c already wagered on 101, so this is refused (one wager per market) — the
// point is just that no 4th wager could pay wager3 twice even if it landed.
is(!r || r.status !== 200, 'a repeat on the same market is refused, not a fresh trigger');

console.log(fails ? `\n${fails} FAILED` : '\nall green');
srv.close();
process.exit(fails ? 1 : 0);
