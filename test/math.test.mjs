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
is(bar([mk('yes',1,1),mk('no',1,2)])===null,'bar: hidden below 5 wagers');
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

console.log(fails? `\n${fails} FAILED`:'\nall green');
process.exit(fails?1:0);
