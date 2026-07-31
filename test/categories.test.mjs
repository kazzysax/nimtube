// The gate used to hand back whatever category string it invented — 'Football',
// 'Weather', 'AI'. The feed's chip row is now a fixed set, so every market has
// to land under one of them.
import { CATEGORIES, normalizeCategory } from '../src/core/categories.js';

let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

is(JSON.stringify(CATEGORIES) === JSON.stringify(['Crypto', 'Sports', 'Music', 'Politics', 'Other']),
   'the taxonomy is exactly the five chips the feed shows');

is(normalizeCategory('Crypto') === 'Crypto', 'an already-correct category passes through');
is(normalizeCategory('crypto') === 'Crypto', 'and is case-insensitive');
is(normalizeCategory('Bitcoin') === 'Crypto', 'a token name maps to Crypto');

is(normalizeCategory('Football') === 'Sports', "'Football' — a real production value — maps to Sports");
is(normalizeCategory('Basketball') === 'Sports', 'so does another sport not in the fixed list');
is(normalizeCategory('Premier League') === 'Sports', 'and a league name');

is(normalizeCategory('Music') === 'Music', 'Music passes through');
is(normalizeCategory('Grammy Awards') === 'Music', 'an awards show maps to Music');

is(normalizeCategory('Politics') === 'Politics', 'Politics passes through');
is(normalizeCategory('US Election') === 'Politics', 'an election maps to Politics');

is(normalizeCategory('Weather') === 'Other', "'Weather' — a real production value — falls into Other");
is(normalizeCategory('AI') === 'Other', "so does 'AI'");
is(normalizeCategory('Entertainment') === 'Other', 'and anything else unrecognised');
is(normalizeCategory('') === 'Other', 'an empty category is Other, never dropped');
is(normalizeCategory(undefined) === 'Other', 'and so is a missing one');
is(normalizeCategory(null) === 'Other', 'and null');

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
