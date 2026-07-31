// The resolver job: closes markets on the clock, skips paying for resolution on
// markets that are mathematically guaranteed to void anyway, and survives a
// restart mid-retry because its retry state lives on the row, not in memory.
process.env.DB_FILE = './data/resolver.db';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = '1';
process.env.ANTHROPIC_API_KEY = 'test-key';

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/resolver.db' + s, { force: true }));

let claudeCalls = 0;
globalThis.fetch = async (url, opts) => {
  claudeCalls++;
  return {
    ok: true, status: 200,
    json: async () => ({ content: [{ type: 'text', text: globalThis.__verdict }] }),
  };
};

const { db } = await import('../src/core/db.js');
const { tick } = await import('../src/jobs/resolver.js');

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

// A creator and two callers, so wagers have someone real to belong to.
const mkUser = (id, name) => db.prepare(
  `INSERT INTO users (id,address,username,username_ci,points,rep) VALUES (?,?,?,?,20,0)`
).run(id, 'NQ' + id, name, name);
mkUser(1, 'creator');
mkUser(2, 'yesguy');
mkUser(3, 'noguy');

const iso = ms => new Date(Date.now() + ms).toISOString();
const mkMarket = (id, state, closesInMs, resolvesInMs) => db.prepare(`
  INSERT INTO markets (id,creator_id,question,category,source_tier,source_name,source_detail,
    criteria_yes,criteria_no,opens_at,closes_at,resolves_at,state)
  VALUES (?,1,'Q?','crypto','auto','X','y','a','b',?,?,?,?)`
).run(id, iso(-3600_000), iso(closesInMs), iso(resolvesInMs), state);

const wager = (marketId, userId, side) => db.prepare(
  `INSERT INTO wagers (market_id,user_id,side,stake,rep_at_time,weight) VALUES (?,?,?,1,0,1)`
).run(marketId, userId, side);

const stateOf = id => db.prepare('SELECT state,outcome,void_reason,resolve_attempts FROM markets WHERE id=?').get(id);

// ---- closing on the clock --------------------------------------------------
mkMarket(1, 'open', -1000, 3_600_000);   // closes_at already passed
mkMarket(2, 'open', 3_600_000, 7_200_000); // closes_at still in the future
await tick();
is(stateOf(1).state === 'closed', 'a market past its closes_at is closed');
is(stateOf(2).state === 'open', 'one not due yet is left alone');

// ---- one-sided markets void without paying for resolution -----------------
mkMarket(3, 'closed', -7_200_000, -1000);
wager(3, 2, 'yes'); // only one side has anyone in it
claudeCalls = 0;
await tick();
is(stateOf(3).state === 'void' && stateOf(3).void_reason === 'No wagers on one side',
   'a one-sided market voids on the clock');
is(claudeCalls === 0, 'and the resolver never paid for a Claude call to find that out');

// ---- a real two-sided market gets resolved ---------------------------------
mkMarket(4, 'closed', -7_200_000, -1000);
wager(4, 2, 'yes');
wager(4, 3, 'no');
globalThis.__verdict = JSON.stringify({ outcome: 'YES', evidence: 'e', source_checked: 'x', void_reason: null });
claudeCalls = 0;
await tick();
is(claudeCalls === 1, 'a two-sided market does call the resolver');
is(stateOf(4).state === 'resolved' && stateOf(4).outcome === 'YES',
   'and settles on what it found');
is(db.prepare('SELECT rep FROM users WHERE id=2').get().rep > 0,
   "the winner's reputation actually moved");

// ---- retry state survives a restart (lives on the row, not in memory) -----
mkMarket(5, 'closed', -7_200_000, -1000);
wager(5, 2, 'yes');
wager(5, 3, 'no');
globalThis.__verdict = JSON.stringify({ outcome: 'VOID', evidence: 'e', source_checked: 'x', void_reason: 'source down' });

claudeCalls = 0;
await tick();
is(stateOf(5).state === 'closed' && stateOf(5).resolve_attempts === 1,
   'a VOID verdict on the first try is retried, not settled — attempt count persisted on the row');

// Immediately ticking again must not retry early (RETRY_GAP_MS has not passed).
await tick();
is(claudeCalls === 1, 'ticking again inside the retry gap does not call the resolver a 2nd time');

// Simulate time (and a restart) by backdating resolve_last_try directly in the
// DB — this is the whole point: nothing in-memory has to survive for the next
// tick to know it's allowed to retry.
const backdate = () => db.prepare(
  "UPDATE markets SET resolve_last_try = strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes') WHERE id=5"
).run();

backdate(); await tick();
is(stateOf(5).resolve_attempts === 2, 'once the gap has passed, the retry count advances to 2');
backdate(); await tick();
is(stateOf(5).resolve_attempts === 3, 'and to 3');
backdate(); await tick();
is(stateOf(5).state === 'void' && stateOf(5).void_reason === 'source down',
   'after MAX_ATTEMPTS it finally settles void, with the resolver\'s real reason');

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
