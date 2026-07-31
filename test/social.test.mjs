// Two strangers. The point of the whole app is that A sees what B called, and
// that following is what shapes whose calls you see.
process.env.DB_FILE = './data/social.db';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = '1';

import fs from 'fs';
['', '-wal', '-shm'].forEach(s => fs.rmSync('./data/social.db' + s, { force: true }));

const { db } = await import('../src/core/db.js');
const app = (await import('../src/server.js')).default;

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const srv = app.listen(4499);
const B_ = 'http://127.0.0.1:4499';
const j = async (m, p, body, tok) => {
  const r = await fetch(B_ + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const alice = (await j('POST', '/api/session', { address: 'NQ01 ALICE', username: 'alice', avatar: 3 })).body;
const bob   = (await j('POST', '/api/session', { address: 'NQ02 BOBBY', username: 'bobby', avatar: 9 })).body;
const cara  = (await j('POST', '/api/session', { address: 'NQ03 CARAX', username: 'caraxx' })).body;

const uid = n => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;

// ---- profile pictures ------------------------------------------------------
is(alice.user.avatar === 3 && bob.user.avatar === 9, 'a chosen face is kept');
const c = db.prepare('SELECT avatar FROM users WHERE username = ?').get('caraxx').avatar;
is(Number.isInteger(c) && c >= 0 && c < 15, 'somebody who picked nothing still gets a real face');

let r = await j('POST', '/api/session', { address: 'NQ04 EVILX', username: 'evilxx', avatar: 999 });
const e = db.prepare('SELECT avatar FROM users WHERE username = ?').get('evilxx').avatar;
is(e >= 0 && e < 15, 'an out-of-range face is replaced, not stored');

// ---- B posts, A must be able to see it ------------------------------------
const now = new Date().toISOString();
const later = new Date(Date.now() + 6 * 36e5).toISOString();
const mk = (id, creator, said) => db.prepare(`INSERT INTO markets
  (id,creator_id,raw_text,question,category,source_tier,source_name,source_detail,criteria_yes,criteria_no,
   opens_at,closes_at,resolves_at,state)
  VALUES (?,?,?,'Formal wording','Crypto','auto','CoinGecko','x','a','b',?,?,?,'open')`)
  .run(id, creator, said, now, later, later);

mk(1, uid('bobby'), 'bob reckons btc rips today');
mk(2, uid('caraxx'), 'cara says arsenal walk it');

// Alice follows nobody yet, so her feed is everything — an empty feed teaches
// a new user nothing and gives them nobody to follow.
r = await j('GET', '/api/feed?state=open', null, alice.token);
is(r.body.length === 2, 'a user following nobody sees every open call');
is(r.body.some(m => m.said === 'bob reckons btc rips today'),
   "USER A CAN SEE USER B'S POST");
is(r.body.every(m => m.creator && m.creator.username),
   'every post says who made it');
is(r.body.every(m => Number.isInteger(m.creator.avatar)),
   'and carries their face, so the feed is not full of blanks');

// The post keeps B's own words, not the formal rewrite.
const bobsPost = r.body.find(m => m.creator.username === 'bobby');
is(bobsPost.said === 'bob reckons btc rips today', "and shows B's own wording");

// A signed-out visitor sees them too.
r = await j('GET', '/api/feed?state=open');
is(r.body.length === 2, 'so does somebody not signed in at all');

// ---- following curates ----------------------------------------------------
r = await j('POST', '/api/users/bobby/follow', null, alice.token);
is(r.status === 200 && r.body.following === true && r.body.followers === 1, 'A can follow B');

r = await j('GET', '/api/feed?state=open', null, alice.token);
is(r.body.length === 1 && r.body[0].creator.username === 'bobby',
   'once A follows B, the feed is B and nobody else');

// Her own calls stay in her feed even though she does not follow herself.
mk(3, uid('alice'), 'my own call');
r = await j('GET', '/api/feed?state=open', null, alice.token);
is(r.body.length === 2 && r.body.some(m => m.creator.username === 'alice'),
   'and her own calls are still there');

// Explore is for people she is NOT already following.
r = await j('GET', '/api/explore', null, alice.token);
const names = r.body.map(p => p.username);
is(!names.includes('bobby'), 'explore stops offering somebody already followed');
is(names.includes('caraxx'), 'and still offers everybody else');
is(!names.includes('alice'), 'and never offers you yourself');

// Unfollowing puts the world back.
r = await j('DELETE', '/api/users/bobby/follow', null, alice.token);
is(r.status === 200 && r.body.following === false && r.body.followers === 0, 'A can unfollow B');
r = await j('GET', '/api/feed?state=open', null, alice.token);
is(r.body.length === 3, 'and the feed opens back up');

r = await j('POST', '/api/users/alice/follow', null, alice.token);
is(r.status === 400, 'nobody can follow themselves');

// ---- the counts a profile reports -----------------------------------------
await j('POST', '/api/users/bobby/follow', null, alice.token);
await j('POST', '/api/users/bobby/follow', null, cara.token);
await j('POST', '/api/users/caraxx/follow', null, alice.token);

r = await j('GET', '/api/users/bobby', null, alice.token);
is(r.body.followers === 2, "B's profile counts both followers");
is(r.body.following === 0, 'and shows B follows nobody');
is(r.body.isFollowing === true, 'and tells A that A follows B');
is(r.body.isMe === false, 'and that it is not A looking at herself');
is(r.body.avatar === 9, "and carries B's face");

r = await j('GET', '/api/users/alice', null, alice.token);
is(r.body.following === 2 && r.body.followers === 0, "A's own profile counts what A follows");
is(r.body.isMe === true, 'and knows it is her own');

// A can read B's posts from the profile too, in B's own words.
r = await j('GET', '/api/users/bobby', null, alice.token);
is(r.body.posts.length === 1 && r.body.posts[0].said === 'bob reckons btc rips today',
   "A CAN READ B'S POSTS ON B'S PROFILE");

console.log(fails ? `\n${fails} FAILED` : '\nall green');
srv.close();
process.exit(fails ? 1 : 0);
