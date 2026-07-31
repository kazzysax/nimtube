// The whole economy lives here. Nothing else computes weight, bar, or rep.

export const MIN_WAGERS_FOR_CAP = 5;   // below this the 25% cap is unsatisfiable
export const SINGLE_WAGER_CAP = 0.25;  // no wager may exceed 25% of total weight

/** rep factor: 1 + rep/100, floored at 1x, capped at 2x.
 *  Floored deliberately — negative rep must not mute someone. */
export function repFactor(rep) {
  return Math.min(2, Math.max(1, 1 + rep / 100));
}

/** time factor: 1.2x at open, sliding linearly to 1.0x at close. */
export function timeFactor(now, opensAt, closesAt) {
  const t0 = Date.parse(opensAt), t1 = Date.parse(closesAt), t = Date.parse(now);
  if (!(t1 > t0)) return 1;
  const p = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return 1.2 - 0.2 * p;
}

export function rawWeight({ stake, rep, now, opensAt, closesAt }) {
  return stake * repFactor(rep) * timeFactor(now, opensAt, closesAt);
}

/** Apply the 25% cap.
 *  The cap is self-referential (capping changes the total, which changes the cap),
 *  so this iterates to a fixed point. It converges on the largest wager equalling
 *  one third of everyone else's weight combined.
 *
 *  Below 5 wagers the cap is mathematically unsatisfiable — 4 equal wagers are 25%
 *  each, and forcing them lower collapses every weight to zero. Early on the bar's
 *  prior is doing the damping instead. */
export function applyCap(weights) {
  const n = weights.length;
  if (n < MIN_WAGERS_FOR_CAP) return weights.slice();

  let v = weights.slice();
  for (let i = 0; i < 200; i++) {
    const total = v.reduce((a, b) => a + b, 0);
    if (total <= 0) return v;
    const ceiling = SINGLE_WAGER_CAP * total;
    let changed = false;
    v = v.map(w => {
      if (w > ceiling + 1e-12) { changed = true; return ceiling; }
      return w;
    });
    if (!changed) break;
  }
  return v;
}

/** Capped weight totals per side. Everything downstream reads these. */
export function sideTotals(wagers) {
  const capped = applyCap(wagers.map(w => w.weight));
  let yes = 0, no = 0;
  wagers.forEach((w, i) => {
    if (w.side === 'yes') yes += capped[i]; else no += capped[i];
  });
  return { yes, no, total: yes + no, capped };
}

/** Every market opens at 50/50 and is pulled from there by the weight on each
 *  side. The pull is damped by a prior worth PRIOR_WAGERS wagers sitting evenly
 *  on both sides, so one loud early caller cannot swing the bar to an extreme it
 *  has not earned. Once more than PRIOR_WAGERS people have taken sides the prior
 *  is a minority of the weight and the bar reads as the real book.
 *
 *  The prior is display only — settlement uses sideTotals directly, so nobody's
 *  reputation is scored against a number that was partly invented. */
export const PRIOR_WAGERS = 3;

export function bar(wagers) {
  const { yes, total } = sideTotals(wagers);

  // A prior wager weighs the same as the average real one, so the damping keeps
  // its strength whether people are staking 1 point or 20.
  const unit = total > 0 ? total / wagers.length : 1;
  const prior = PRIOR_WAGERS * unit;

  const share = (yes + prior / 2) / (total + prior);

  // Round the distance from 50, not the share itself, so a lone YES and a lone
  // NO move the bar by the same amount instead of one of them winning the tie.
  const dev = share - 0.5;
  return 50 + Math.sign(dev) * Math.round(Math.abs(dev) * 20) * 5;
}

/** Reputation band, keyed on the winning-or-losing side's share of total weight.
 *  One scale, one meaning: how surprising was this outcome. */
export const BANDS = [
  { min: 80, name: 'heavy favourite', win: 1, lose: -2 },
  { min: 60, name: 'favoured',        win: 2, lose: -2 },
  { min: 40, name: 'toss-up',         win: 3, lose: -1 },
  { min: 20, name: 'underdog',        win: 4, lose: -1 },
  { min: 0,  name: 'long shot',       win: 5, lose: -1 },
];

export function bandFor(sharePct) {
  return BANDS.find(b => sharePct >= b.min) || BANDS[BANDS.length - 1];
}

/** Rep delta for one side of a resolved market.
 *  share = that side's percentage of total capped weight at close. */
export function repDelta(sharePct, won) {
  const b = bandFor(sharePct);
  return { delta: won ? b.win : b.lose, band: b.name };
}

/** Full settlement for a market. Pure function — no db, no side effects.
 *  Returns per-user rep deltas and point refunds. */
export function settle(wagers, outcome) {
  const { yes, no, total } = sideTotals(wagers);

  // A wager with nobody on the other side is not a wager.
  if (yes <= 0 || no <= 0) {
    return { void: true, reason: 'No wagers on one side', results: [] };
  }

  const yesShare = (yes / total) * 100;
  const noShare = (no / total) * 100;

  const results = wagers.map(w => {
    const won = w.side === outcome;
    const share = w.side === 'yes' ? yesShare : noShare;
    const { delta, band } = repDelta(share, won);
    return {
      wagerId: w.id,
      userId: w.userId,
      side: w.side,
      won,
      // Winners recover their stake. Losers lose it. Nobody profits in points.
      refund: won ? w.stake : 0,
      repDelta: delta,
      band,
      share: Math.round(share * 10) / 10,
    };
  });

  return { void: false, yesShare, noShare, results };
}
