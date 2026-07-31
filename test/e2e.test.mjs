process.env.DB_FILE='./data/test.db'; process.env.NODE_ENV='test'; process.env.ALLOW_DEV_LOGIN='1';
import fs from 'fs'; fs.rmSync('./data/test.db',{force:true}); fs.rmSync('./data/test.db-wal',{force:true}); fs.rmSync('./data/test.db-shm',{force:true});
const {db}=await import('../src/core/db.js');
const app=(await import('../src/server.js')).default;
const {settleMarket}=await import('../src/core/markets.js');

const srv=app.listen(4321);
const B='http://127.0.0.1:4321';
const j=async(m,p,body,tok)=>{const r=await fetch(B+p,{method:m,headers:{'content-type':'application/json',...(tok?{authorization:'Bearer '+tok}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
let fails=0; const is=(c,m)=>{if(!c)fails++;console.log((c?'ok  ':'FAIL')+' '+m);};

// signup requires a username the first time
let r=await j('POST','/api/session',{address:'NQ11 AAAA'});
is(r.body.needsUsername===true,'new address is asked for a username');

r=await j('POST','/api/session',{address:'NQ11 AAAA',username:'chidi',deviceHash:'d1'});
const chidi=r.body.token;
is(r.body.user.points===25,'new user gets 20 + 5 daily on first session');

// lookalike impersonation is blocked
r=await j('GET','/api/username/chidl');   // l for i
is(r.body.ok===false,'lookalike username rejected (chidl vs chidi)');
r=await j('GET','/api/username/CHIDI');
is(r.body.ok===false,'case variant rejected');
r=await j('GET','/api/username/nkechi');
is(r.body.ok===true,'unrelated username available');

// five more users
const toks={chidi};
for(const n of ['nkechi','dami','fold','obi','ada']){
  const s=await j('POST','/api/session',{address:'NQ11 '+n.toUpperCase(),username:n,deviceHash:'d_'+n});
  toks[n]=s.body.token;
}

// a market, inserted directly so the test doesn't need an API key
const now=new Date(), close=new Date(Date.now()+3600e3), res_=new Date(Date.now()+7200e3);
db.prepare(`INSERT INTO markets (id,creator_id,question,category,source_tier,source_name,source_detail,
  criteria_yes,criteria_no,opens_at,closes_at,resolves_at) VALUES (1,1,'Will BTC close above 120k on 31 Aug?',
  'crypto','auto','CoinGecko','BTC/USD daily close','close > 120000','close <= 120000',?,?,?)`)
  .run(now.toISOString(),close.toISOString(),res_.toISOString());

// an untouched market opens at 50/50
r=await j('GET','/api/markets/1',null,toks.chidi);
is(r.body.bar===50,'a market with no calls opens at 50/50');
is(r.body.committed===false,'not committed yet');

// and the book is shut to anyone who has not taken a side
r=await j('GET','/api/markets/1/voters',null,toks.chidi);
is(r.status===403&&/pick a side/i.test(r.body.error),'the book is closed until you have a position in it');

// wagers: one long shot on yes, five on no
await j('POST','/api/markets/1/wager',{side:'yes',stake:2},toks.chidi);
for(const n of ['nkechi','dami','fold','obi','ada']) await j('POST','/api/markets/1/wager',{side:'no',stake:10},toks[n]);

// one wager only
r=await j('POST','/api/markets/1/wager',{side:'no',stake:5},toks.chidi);
is(r.status===409,'second wager on the same market is refused');

// points were deducted
r=await j('GET','/api/me',null,toks.chidi);
is(r.body.points===23,'stake deducted from balance');

// bar leaning heavily to no now the book is deep enough to say so
r=await j('GET','/api/markets/1',null,toks.chidi);
is(typeof r.body.bar==='number','bar visible at 6 wagers');
is(r.body.bar<=25,'bar reflects the lopsided book ('+r.body.bar+'% yes)');
is(r.body.committed===true&&r.body.mySide==='yes','own side visible after committing');

// having taken a side, the book opens
r=await j('GET','/api/markets/1/voters',null,toks.chidi);
is(r.status===200&&r.body.length===6,'a committed user sees every call on the market');
const meRow=r.body.find(p=>p.isMe);
is(meRow&&meRow.side==='yes'&&meRow.stake===2,'their own call is marked and carries the stake');
is(r.body.every(p=>p.conviction>=0&&p.conviction<=100),'conviction is relative, never a raw balance');
is(r.body.every(p=>p.points===undefined),'nobody else\'s point balance leaks through');

// settle: the long shot was right
const out=settleMarket(1,'YES',{evidence:'test'});
is(out.void===false,'market settles');
const chidiRow=db.prepare("SELECT rep,points FROM users WHERE username='chidi'").get();
is(chidiRow.rep===5,'long shot correct -> +5 rep (got '+chidiRow.rep+')');
is(chidiRow.points===25,'winner recovers stake, gains nothing (got '+chidiRow.points+')');
const nk=db.prepare("SELECT rep,points FROM users WHERE username='nkechi'").get();
is(nk.rep===-2,'heavy favourite wrong -> -2 rep (got '+nk.rep+')');
is(nk.points===15,'loser forfeits stake (got '+nk.points+')');

// profile hides what it should
r=await j('GET','/api/users/chidi');
is(r.body.rep===5&&r.body.hitRate===100,'profile shows rep and hit rate');
is(!('points' in r.body)&&!('stake' in r.body),'profile hides balance and stakes');

// one-sided market voids and refunds
db.prepare(`INSERT INTO markets (id,creator_id,question,category,source_tier,source_name,source_detail,
  criteria_yes,criteria_no,opens_at,closes_at,resolves_at) VALUES (2,1,'One-sided?','crypto','auto','X','y','a','b',?,?,?)`)
  .run(now.toISOString(),close.toISOString(),res_.toISOString());
await j('POST','/api/markets/2/wager',{side:'yes',stake:3},toks.dami);
const before=db.prepare("SELECT points FROM users WHERE username='dami'").get().points;
settleMarket(2,'YES',{});
const after=db.prepare("SELECT points FROM users WHERE username='dami'").get().points;
is(after===before+3,'no opponent -> void and full refund');
is(db.prepare('SELECT state FROM markets WHERE id=2').get().state==='void','market marked void');

srv.close();
console.log(fails?`\n${fails} FAILED`:'\nall green');
process.exit(fails?1:0);
