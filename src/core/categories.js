// The fixed taxonomy every market gets slotted into. Free-text categories from
// the model — or from rows created before this taxonomy existed — are folded
// into one of these five, so the feed's category chips are exhaustive: nothing
// falls through a gap the UI has no tab for.
export const CATEGORIES = ['Crypto', 'Sports', 'Music', 'Politics', 'Other'];

const RULES = [
  [/crypto|bitcoin|\bbtc\b|\beth\b|ethereum|defi|\bnft\b|blockchain|altcoin|\btoken\b|solana|\bsol\b|dogecoin|memecoin/i, 'Crypto'],
  [/sport|football|soccer|basketball|\bnba\b|\bnfl\b|tennis|cricket|boxing|\bufc\b|\bmma\b|olympic|hockey|baseball|\bmlb\b|golf|rugby|formula ?1|\bf1\b|athletics|premier league|champions league|world cup/i, 'Sports'],
  [/music|song|album|concert|grammy|billboard|spotify|chart|single release|tour dates/i, 'Music'],
  [/politic|election|government|senate|congress|president|policy|parliament|\bvote\b|referendum|white house|prime minister/i, 'Politics'],
];

/** Case-insensitive; first matching rule wins. Anything unmatched — including
 *  empty or missing input — lands in Other rather than being dropped. */
export function normalizeCategory(raw) {
  const s = String(raw || '');
  for (const [re, cat] of RULES) if (re.test(s)) return cat;
  return 'Other';
}
