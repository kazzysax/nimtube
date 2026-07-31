// The welcome checklist on Explore. Three one-time nudges, each paid exactly
// once — the moment its target is first reached, not on every render.
import { db } from './db.js';

export const QUESTS = [
  { key: 'follow2', label: 'Follow 2 people', reward: 5, target: 2 },
  { key: 'post1', label: 'Make a post', reward: 2, target: 1 },
  { key: 'wager3', label: 'Place 3 convictions', reward: 3, target: 3 },
];

const counts = userId => ({
  follow2: db.prepare('SELECT COUNT(*) n FROM follows WHERE follower_id = ?').get(userId).n,
  post1: db.prepare('SELECT COUNT(*) n FROM markets WHERE creator_id = ?').get(userId).n,
  wager3: db.prepare('SELECT COUNT(*) n FROM wagers WHERE user_id = ?').get(userId).n,
});

/** What the checklist shows: every quest, how far along, and whether it is
 *  already banked. Read-only — never awards anything itself. */
export function progress(userId) {
  const n = counts(userId);
  const done = new Set(
    db.prepare('SELECT quest_key FROM quest_progress WHERE user_id = ?').all(userId).map(r => r.quest_key)
  );
  return QUESTS.map(q => ({
    ...q,
    progress: Math.min(n[q.key], q.target),
    done: done.has(q.key),
  }));
}

/** Call after any action that could complete a quest: following, posting, or
 *  wagering. Cheap — three COUNT(*) queries — and idempotent: a quest already
 *  in quest_progress is never re-awarded, so calling this from three different
 *  call sites can never double-pay the same quest.
 *
 *  Returns the quests newly completed by this call, for an optional toast. */
export function checkAndAward(userId) {
  const n = counts(userId);
  const completed = [];

  for (const q of QUESTS) {
    if (n[q.key] < q.target) continue;

    const result = db.prepare(
      'INSERT OR IGNORE INTO quest_progress (user_id, quest_key) VALUES (?, ?)'
    ).run(userId, q.key);

    // changes === 0 means a row already existed — already paid, skip it.
    if (result.changes === 1) {
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(q.reward, userId);
      completed.push(q);
    }
  }

  return completed;
}
