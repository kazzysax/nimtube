// Stubs the Anthropic API so the terminal's parsing, guards and prompt assembly
// can be exercised without a key.
let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };
process.env.ANTHROPIC_API_KEY = 'test-key';

let lastBody = null;
globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  if (globalThis.__fail) return { ok: false, status: 529, text: async () => 'overloaded' };
  return {
    ok: true, status: 200,
    json: async () => ({
      content: [{ type: 'text', text: globalThis.__next }],
      stop_reason: globalThis.__stopReason ?? 'end_turn',
    }),
  };
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

// People type greetings and open-ended questions. Neither is a reason to reject.
is(lastBody.system.includes('good morning'),
   'gate: is told to strip greetings rather than judge them');
is(/NEVER reject something because of how\s+casually it was worded/.test(lastBody.system),
   'gate: is told casual wording is not grounds for rejection');
is(lastBody.system.includes('MAGNITUDE'),
   'gate: is told to turn "what will X be" into the binary question meant');
is(lastBody.system.includes('NO web access here') && lastBody.system.includes('Never invent one'),
   'gate: is told it cannot know current prices, so it must not invent a threshold');
is(lastBody.system.includes("daily open") && lastBody.system.includes('previous close'),
   'gate: anchors magnitude questions to a published checkpoint, not a bespoke instant');
is(lastBody.system.includes('today\'s daily open (00:00 UTC) on Coinbase?'),
   'gate: the worked example anchors to a checkpoint a resolver can actually find');
is(lastBody.system.includes('category must be exactly one of: Crypto, Sports, Music, Politics, Other'),
   'gate: category is constrained to the fixed taxonomy, not freeform text');
is(lastBody.system.includes('If this event had already happened'), 'gate: ships the core test in the system prompt');
is(lastBody.system.includes('polymarket'), 'gate: offers the polymarket source tier');
is(!lastBody.tools, 'gate: no web search at creation time');
is(JSON.parse(lastBody.messages[0].content).raw_text === 'will bitcoin pump this month', 'gate: passes raw text through');

globalThis.__next = '```json\n{"status":"rejected","reason":"\\"Pump\\" has no fixed meaning.","suggested_fix":{"question":"Will BTC close above $120,000?","source_name":"CoinGecko"}}\n```';
r = await gate('will btc pump');
is(r.status === 'rejected', 'gate: parses a rejection wrapped in code fences');
is(!!r.suggested_fix, 'gate: rejection carries a one-tap fix');

// A malformed or truncated response used to fail completely silently — a
// production incident with zero server-side trace of what the model actually
// sent back. It's now logged, and the error tells the two failure modes apart.
{
  const errLog = [];
  const origErr = console.error;
  console.error = (...a) => errLog.push(a.join(' '));

  globalThis.__stopReason = 'end_turn';
  globalThis.__next = 'Sorry, I cannot help with that request.';
  let threw = null;
  try { await gate('anything'); } catch (e) { threw = e; }
  is(threw?.message.includes('no parseable JSON'),
     'gate: a response with no JSON at all is reported as exactly that');
  is(errLog.some(l => l.includes('[terminal] gate') && l.includes('Sorry, I cannot help')),
     'gate: the raw response is logged server-side, not silently dropped');

  errLog.length = 0;
  globalThis.__stopReason = 'max_tokens';
  globalThis.__next = '{"status":"approved","question":"Will BTC clo';  // cut off mid-object
  threw = null;
  try { await gate('will btc pump'); } catch (e) { threw = e; }
  is(threw?.message.includes('cut off before finishing'),
     'gate: a response truncated by max_tokens is distinguished from a genuinely bad one');
  is(errLog.some(l => l.includes('max_tokens')), 'gate: and that distinction is logged too');

  globalThis.__stopReason = 'end_turn';
  console.error = origErr;
}

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
