// Stubs the Anthropic API so the terminal's parsing, guards and prompt assembly
// can be exercised without a key.
let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };
process.env.ANTHROPIC_API_KEY = 'test-key';

let lastBody = null;
globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  if (globalThis.__fail) return { ok: false, status: 529, text: async () => 'overloaded' };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: globalThis.__next }] }) };
};

const { gate, resolve } = await import('../src/core/terminal.js');

globalThis.__next = JSON.stringify({
  status: 'approved',
  question: 'Will BTC close above $120,000 on 31 Aug 2026?',
  category: 'crypto', source_tier: 'auto', source_name: 'CoinGecko',
  source_detail: 'BTC/USD daily close', criteria_yes: 'close > 120000',
  criteria_no: 'close <= 120000',
  closes_in_minutes: 2880, resolves_in_minutes: 2940,
});
let r = await gate('will bitcoin pump this month');
is(r.status === 'approved', 'gate: parses an approval');
is(r.source_tier === 'auto', 'gate: keeps the source tier');
is(r.closes_in_minutes === 2880, 'gate: returns a duration, not a date it computed itself');
is(lastBody.system.includes('DURATIONS IN MINUTES'), 'gate: is told to hand back durations');
is(lastBody.system.includes('"in two days" -> 2880'),
   'gate: is shown the conversion, since it kept turning two days into two hours');
is(lastBody.system.includes('If this event had already happened'), 'gate: ships the core test in the system prompt');
is(lastBody.system.includes('polymarket'), 'gate: offers the polymarket source tier');
is(!lastBody.tools, 'gate: no web search at creation time');
is(JSON.parse(lastBody.messages[0].content).raw_text === 'will bitcoin pump this month', 'gate: passes raw text through');

globalThis.__next = '```json\n{"status":"rejected","reason":"\\"Pump\\" has no fixed meaning.","suggested_fix":{"question":"Will BTC close above $120,000?","source_name":"CoinGecko"}}\n```';
r = await gate('will btc pump');
is(r.status === 'rejected', 'gate: parses a rejection wrapped in code fences');
is(!!r.suggested_fix, 'gate: rejection carries a one-tap fix');

globalThis.__next = 'Here you go:\n{"outcome":"NO","evidence":"CoinGecko close was $118,402.","source_checked":"coingecko.com","void_reason":null}';
r = await resolve({ id: 1, question: 'q', source_name: 'CoinGecko' });
is(r.outcome === 'NO', 'resolver: digs JSON out of a chatty reply');
is(lastBody.tools?.[0]?.name === 'web_search', 'resolver: web search on, so it can actually check the source');
is(lastBody.system.includes('NOT judging'), 'resolver: told explicitly not to re-judge the question');

globalThis.__next = '{"outcome":"MAYBE","evidence":"unclear"}';
r = await resolve({ id: 1 });
is(r.outcome === 'VOID', 'resolver: an unrecognised verdict becomes VOID');
is(r.needs_human === true, 'resolver: and is flagged for a human');

globalThis.__fail = true;
try { await gate('x'); is(false, 'gate: should throw on API failure'); }
catch (e) { is(String(e.message).includes('529'), 'gate: surfaces API failures rather than swallowing them'); }

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
