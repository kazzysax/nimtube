import {applyCap,bar,settle,repFactor,timeFactor,bandFor,sideTotals} from '../src/core/math.js';
let fails=0;
const eq=(a,b,m)=>{const ok=Math.abs(a-b)<1e-6;if(!ok)fails++;console.log((ok?'ok  ':'FAIL')+' '+m);};
const is=(c,m)=>{if(!c)fails++;console.log((c?'ok  ':'FAIL')+' '+m);};

eq(repFactor(0),1,'rep factor: 0 rep -> 1x');
eq(repFactor(100),2,'rep factor: 100 rep -> 2x');
eq(repFactor(500),2,'rep factor: capped at 2x');
eq(repFactor(-50),1,'rep factor: negative rep floored at 1x, never muted');

const o='2026-01-01T00:00:00Z',c='2026-01-11T00:00:00Z';
eq(timeFactor(o,o,c),1.2,'time factor: 1.2x at open');
eq(timeFactor(c,o,c),1.0,'time factor: 1.0x at close');
eq(Math.round(timeFactor('2026-01-06T00:00:00Z',o,c)*100)/100,1.1,'time factor: linear midpoint');

const v=applyCap([100,1,1,1,1]),T=v.reduce((a,b)=>a+b,0);
eq(Math.round(v[0]/T*1e6)/1e6,0.25,'cap: whale trimmed to exactly 25% of total');
eq(Math.round(v[0]*1e4)/1e4,1.3333,'cap: converges to a third of everyone else combined');
is(applyCap([100,1,1]).join()==='100,1,1','cap: dormant below 5 wagers (unsatisfiable there)');

const mk=(side,weight,i,stake=1)=>({id:i,userId:i,side,stake,weight});

// Every market opens at 50/50 and is pulled from there, damped early so a thin
// book cannot read as a landslide.
eq(bar([]),50,'bar: an empty market sits at 50/50');
eq(bar([mk('yes',1,1)]),65,'bar: one call moves it, but nowhere near all the way');
eq(bar([mk('no',1,1)]),35,'bar: and moves it the same distance the other way');
eq(bar([mk('yes',1,1),mk('no',1,2)]),50,'bar: an even book stays at 50/50');
is(bar(Array.from({length:3},(_,i)=>mk('yes',1,i)))===75,
   'bar: three calls one way is still short of the extreme');
is(bar(Array.from({length:20},(_,i)=>mk('yes',1,i)))>=90,
   'bar: a deep one-sided book does reach the extreme');
eq(bar([mk('yes',20,1)]),65,
   'bar: a lone whale moves it no further than a lone minnow — damping scales with stake');
eq(bar([mk('yes',3,1),mk('yes',3,2),mk('no',2,3),mk('no',1,4),mk('no',1,5)]),50,
   'bar: two oversized wagers get trimmed, 60/40 becomes 50/50');
const st=sideTotals([mk('yes',3,1),mk('yes',3,2),mk('no',2,3),mk('no',1,4),mk('no',1,5)]);
eq(Math.round(st.yes*1e4)/1e4,4,'bar: capped yes total');

const ws=[mk('yes',2,1,2),mk('no',20,2),mk('no',20,3),mk('no',20,4),mk('no',20,5)];
const r=settle(ws,'yes');
eq(r.results[0].repDelta,5,'settle: long shot correct -> +5');
eq(r.results[1].repDelta,-2,'settle: heavy favourite wrong -> -2');
eq(r.results[0].refund,2,'settle: winner recovers stake, no profit');
eq(r.results[1].refund,0,'settle: loser forfeits stake');
is(r.results[0].band==='long shot','settle: band named on the receipt');

const t=[mk('yes',10,1),mk('yes',10,2),mk('no',10,3),mk('no',10,4),mk('no',10,5)];
const rt=settle(t,'yes');
eq(rt.results[0].repDelta,3,'settle: 40% side wins -> +3 toss-up');
eq(rt.results[2].repDelta,-2,'settle: 60% side loses -> -2 favoured');

const ev=[mk('yes',10,1),mk('yes',10,2),mk('yes',10,3),mk('yes',10,4),mk('no',10,5),mk('no',10,6)];
eq(settle(ev,'no').results[4].repDelta,4,'settle: 33% underdog wins -> +4');
eq(settle(ev,'no').results[0].repDelta,-2,'settle: 67% favourite loses -> -2');

is(settle([mk('yes',1,1),mk('yes',1,2)],'yes').void,'settle: one-sided market voids');
is(bandFor(60).name==='favoured','bands: exactly 60% sits in favoured');
is(bandFor(80).name==='heavy favourite','bands: exactly 80% sits in favourite');
is(bandFor(19.9).name==='long shot','bands: just under 20% is a long shot');

// ---- the clock ------------------------------------------------------------
// The gate returns durations because models fumble date arithmetic: a "two day"
// question came back as two hours, and a "one hour" one came back already past
// its close, so the resolver settled it on the next tick.
const { scheduleFrom } = await import('../src/core/markets.js');
const T0 = Date.parse('2026-07-31T12:00:00.000Z');
const at = v => scheduleFrom(v, T0);

is(at({closes_in_minutes:60,resolves_in_minutes:75}).closes_at==='2026-07-31T13:00:00.000Z',
   'clock: an hour from now is an hour from now');
is(at({closes_in_minutes:2880,resolves_in_minutes:2940}).closes_at==='2026-08-02T12:00:00.000Z',
   'clock: two days is two days, not two hours');
is(at({closes_in_minutes:60,resolves_in_minutes:75}).resolves_at==='2026-07-31T13:15:00.000Z',
   'clock: resolution leaves the slack the gate asked for');

is(at({closes_in_minutes:-30})===null,'clock: a market cannot open already closed');
is(at({closes_in_minutes:0})===null,'clock: nor close the instant it opens');
is(at({closes_in_minutes:1})===null,'clock: nor close too soon to wager on');
is(at({closes_in_minutes:10081})===null,'clock: nor run longer than a week');
is(at({closes_in_minutes:60,resolves_in_minutes:30})===null,'clock: nor resolve before it closes');
is(at({closes_in_minutes:'soon'})===null,'clock: a non-numeric duration is refused');
is(at({})===null,'clock: a missing duration is refused');
is(at({closes_in_minutes:60}).resolves_at==='2026-07-31T13:00:00.000Z',
   'clock: with no resolve time given, it resolves at close');

console.log(fails? `\n${fails} FAILED`:'\nall green');
process.exit(fails?1:0);
