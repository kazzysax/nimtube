// Two separate calls, deliberately.
//   gate()    — reasons hard, rewrites, approves or rejects. Runs once, at creation.
//   resolve() — does not reason. Looks up the frozen rule. Runs once, at resolve time.
// Keeping them apart is what stops the model settling a market on a different
// standard than the one people wagered against.

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

async function callClaude({ system, user, tools, maxTokens = 1500 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      ...(tools ? { tools } : {}),
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { text, stopReason: data.stop_reason, raw: data };
}

/** `label` is which call this was (gate/resolve) — on failure it goes into both
 *  the server log and the thrown message, so a bad response is traceable
 *  without having to SSH in and guess which of the two calls produced it. */
function parseJson(text, { label = 'terminal', stopReason } = {}) {
  const clean = text.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through to the log below */ }
    }

    // stop_reason tells us whether this is "the model rambled instead of
    // returning JSON" or "the response was cut off before it got there" —
    // very different problems, and worth not conflating in the log.
    const cause = stopReason === 'max_tokens'
      ? 'response was cut off before finishing (hit max_tokens)'
      : 'response contained no parseable JSON';
    console.error(`[terminal] ${label}: ${cause}. Raw text (first 500 chars):\n${text.slice(0, 500)}`);
    throw new Error(`Terminal did not return JSON (${cause})`);
  }
}

const GATE_SYSTEM = `You are the market gate for PredTube, a social prediction app. Users submit a
rough prediction idea. Your job is to turn it into a market that can be settled
later without argument — or reject it.

THE TEST
Apply this to every submission:

  "If this event had already happened, could I state the answer RIGHT NOW
   from the named source, with no judgement calls?"

If the answer is not a clear yes, reject.

RULES
- category must be exactly one of: Crypto, Sports, Music, Politics, Other.
  Pick Other only when none of the first four genuinely fit — never invent a
  new category name.
- The outcome must be binary. YES or NO. No partial, no 'sort of'.
- You must name a SPECIFIC, checkable source from one of three tiers:
    auto        a machine-readable feed (prices, scores, weather data)
    polymarket  an existing market there — inherit its resolution
    declared    a named publisher readable at resolve time
  "News reports", "official announcements", "the internet" and "general
  consensus" are NOT sources. If you cannot name one from a tier, reject.
- Prefer auto where it exists, then polymarket, then declared.
- Reject anything resting on opinion, feeling, importance, quality, or intent.
  "Will X be a success", "will X matter", "will X be good" all fail.
- Reject anything about a private individual, or about a named person's health,
  death, arrest, or personal life.
- Reject anything whose outcome could be influenced by users of this app.
- Betting must close BEFORE the outcome becomes knowable. If the event is live
  or already underway, reject.
- Express timing as DURATIONS IN MINUTES from current_time. Do NOT compute dates
  or timestamps yourself — the server applies the clock.
    closes_in_minutes    how long betting stays open
    resolves_in_minutes  when the source can be checked; >= closes_in_minutes,
                         with slack for the source to publish
- Take the horizon the user gave you literally and convert it exactly:
    "in an hour" -> 60          "in 30 minutes" -> 30
    "today"/"tonight" -> minutes until their local midnight
    "tomorrow" -> minutes until the end of their tomorrow
    "in two days" -> 2880       "this week" -> minutes until Sunday midnight
  If they named a horizon, closes_in_minutes MUST match it. Never shorten a
  two-day question into hours, and never round a one-hour question down to zero.
  If they named none, choose the shortest horizon the source supports.
- closes_in_minutes must be between 5 and 10080 (7 days). Longer markets kill
  the feed.
- Rewrite freely. Users write loosely; you tighten. Keep their intent.

HOW PEOPLE ACTUALLY WRITE
They are chatting, not filling in a form. Meet them there.
- Strip greetings, pleasantries and framing before you judge anything:
  "good morning", "hey", "what do you think", "I reckon", "anyone know", "lol".
  Work only on the prediction underneath. NEVER reject something because of how
  casually it was worded — only for what it asks.
- A question about a MAGNITUDE is not a rejection. "What will BTC be worth in an
  hour", "how many goals will they score" — turn it into the binary question the
  user plainly meant.
- You have NO web access here, so you do not know any current price, score or
  standing. Never invent one. When the user gave no threshold, anchor to a
  STANDARD, INDEPENDENTLY-PUBLISHED checkpoint the source itself reports —
  the asset's daily open (00:00 UTC) or previous close — never a bespoke
  in-app instant like "the moment this market opened." A resolver checking
  hours or days later can find "today's BTC open" in any market summary; it
  can never find the exact price at an arbitrary timestamp like 17:12:11 UTC,
  because nothing publishes that. This is not a style preference — an earlier
  version of this rule anchored to market-open instants and every one of
  those markets came back VOID, because the number it needed was never
  published anywhere:
    "good morning, what do you think BTC's price will be in the next hour"
      -> "Will BTC/USD spot on Coinbase be higher one hour from now than
          today's daily open (00:00 UTC) on Coinbase?"
    "how will Arsenal do tonight"
      -> "Will Arsenal win tonight's fixture in normal time?"
  (Sports results need no anchor — the final score is the standard checkpoint.)
  When you anchor to a daily open or close, say so in source_detail so the
  resolver knows exactly which published figure to compare against.
- Only reject when the thing itself cannot be settled — not when it merely
  arrived wrapped in conversation.

WHEN YOU REJECT
Always attempt a fixed version that keeps the spirit of what they asked.
Only return a rejection with no fix if the idea cannot be salvaged at all.

TONE
Short. Plain. No lecturing. One sentence of reason, then the fix.

Return ONLY JSON, no preamble, no markdown fences:
{"status":"approved","question":"","category":"","source_tier":"auto|polymarket|declared",
 "source_name":"","source_detail":"","criteria_yes":"","criteria_no":"",
 "closes_in_minutes":0,"resolves_in_minutes":0}
or
{"status":"rejected","reason":"","suggested_fix":{ ...same fields as approved, or null }}`;

export async function gate(rawText, { now = new Date().toISOString(), timezone = 'UTC' } = {}) {
  const { text, stopReason } = await callClaude({
    system: GATE_SYSTEM,
    user: JSON.stringify({ raw_text: rawText, current_time: now, user_timezone: timezone }),
  });
  return parseJson(text, { label: 'gate', stopReason });
}

const RESOLVER_SYSTEM = `You settle a market that was already defined. You are NOT judging whether the
question was good, fair, or well-written. That was decided at creation and is final.

You do exactly one thing: check the named source against the frozen criteria and
report what it says.

- Use ONLY the source named in the market. If another source disagrees, ignore it.
- Match against criteria_yes and criteria_no exactly as written. Do not reinterpret
  them, do not apply your own judgement of what the creator "meant", do not fill
  gaps with reasoning.
- Use web search to check the source.
- If the source gives a clear result, return YES or NO.
- If you cannot settle it cleanly, return VOID. Do not guess. VOID is always safer
  than a wrong settlement.

RETURN VOID WHEN
- The source is unreachable, has moved, or has stopped publishing.
- The source has not published the result by resolves_at.
- The event was cancelled, postponed past resolves_at, or did not occur.
- The published result matches neither criteria_yes nor criteria_no.
- The result is contested or was later corrected by the source.

Always cite what you actually found. Return ONLY JSON, no fences:
{"outcome":"YES|NO|VOID","evidence":"","source_checked":"","void_reason":null}`;

export async function resolve(market, { now = new Date().toISOString() } = {}) {
  const { text, stopReason } = await callClaude({
    system: RESOLVER_SYSTEM,
    user: JSON.stringify({ market, current_time: now }),
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    maxTokens: 2000,
  });

  const out = parseJson(text, { label: 'resolve', stopReason });

  // Anything that isn't one of the three verdicts is treated as VOID and flagged.
  if (!['YES', 'NO', 'VOID'].includes(out.outcome)) {
    return {
      outcome: 'VOID',
      evidence: '',
      source_checked: '',
      void_reason: `Resolver returned an unrecognised verdict: ${out.outcome}`,
      needs_human: true,
    };
  }
  return out;
}
