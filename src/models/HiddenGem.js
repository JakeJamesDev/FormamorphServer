const db = require('../config/db');
const { inCirculationClause } = require('../config/listingReview');
const {
  PICK_COUNT, ROTATION_INTERVAL_MS, COOLDOWN_MS, WINDOW_DAYS, MIN_LIKES, DOWNLOAD_PERCENTILE
} = require('../config/hiddenGems');
const { DAY_MS, utcDay } = require('../config/time');
// Registers the `likes_hidden` SQL function the population clause calls.
require('../utils/likeVisibility');

/** The instant before which a pick no longer cools and a rotation is pruned. */
const cooldownCutoff = (now) => new Date(now.getTime() - COOLDOWN_MS).toISOString();

/**
 * The SQL test for the population: in-circulation worlds, not pinned, not Supporter-only, and with likes a
 * guest may read. Takes no parameters.
 *
 * @param {string} w - The worlds alias
 * @param {string} ce - The alias of the contest `events` row joined on `w.contest_event_id`
 * @returns {string} A WHERE fragment
 */
const populationClause = (w, ce) => `${w}.kind = 'world' AND ${inCirculationClause(w)}
  AND ${w}.pinned_at IS NULL AND ${w}.supporter_only = 0
  AND NOT likes_hidden(${w}.contest_event_id, ${ce}.results_announced_at, ${w}.author_id, NULL, NULL)`;

const NEWEST_ORDER = 'ORDER BY rotated_at DESC, id DESC LIMIT 1';

/** The newest rotation's id, as a scalar subquery. */
const NEWEST_ROTATION_SQL = `SELECT id FROM hidden_gem_rotations ${NEWEST_ORDER}`;

/**
 * The SQL test for a flagged row: picked by the newest rotation and still in the population.
 *
 * @param {string} w - The worlds alias
 * @param {string} ce - The contest `events` alias
 * @returns {string} A boolean expression with no parameters
 */
const hiddenGemClause = (w, ce) => `(EXISTS (SELECT 1 FROM hidden_gem_picks hgp
    WHERE hgp.world_id = ${w}.id AND hgp.rotation_id = (${NEWEST_ROTATION_SQL}))
  AND ${populationClause(w, ce)})`;

/** The value at a percentile of an ascending list, by nearest rank. */
const nearestRank = (ascending, percentile) =>
  ascending[Math.max(1, Math.ceil((percentile / 100) * ascending.length)) - 1];

const HiddenGem = {
  /**
   * Every population world with its window likes and downloads.
   *
   * @param {Date} now - The rotation's time; the window ends on its UTC day
   * @returns {Array<{ id: string, likes: number, downloads: number }>}
   */
  population: (now) => {
    const end = utcDay(now);
    const start = utcDay(new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS));

    return db.prepare(`
      SELECT w.id,
        COALESCE((SELECT SUM(d.count) FROM world_download_days d
          WHERE d.world_id = w.id AND d.day BETWEEN @start AND @end), 0) AS downloads,
        (SELECT COUNT(*) FROM world_likes l
          WHERE l.world_id = w.id AND date(l.created_at) BETWEEN @start AND @end)
        + (SELECT COUNT(*) FROM anonymous_likes a
          WHERE a.world_id = w.id AND date(a.created_at) BETWEEN @start AND @end) AS likes
      FROM worlds w
      LEFT JOIN events ce ON ce.id = w.contest_event_id
      WHERE ${populationClause('w', 'ce')}
    `).all({ start, end });
  },

  /**
   * Up to `PICK_COUNT` eligible worlds, best smoothed score first, ties by id.
   *
   * @param {Date} now - The rotation's time
   * @returns {string[]} World ids
   */
  pick: (now) => {
    const rows = HiddenGem.population(now);
    const totalDownloads = rows.reduce((sum, row) => sum + row.downloads, 0);
    if (totalDownloads === 0) return [];

    // Each score is pulled toward the population's like rate by `prior` downloads' worth of evidence.
    const totalLikes = rows.reduce((sum, row) => sum + row.likes, 0);
    const baseRate = totalLikes / totalDownloads;
    const ascending = rows.map((row) => row.downloads).sort((a, b) => a - b);
    const prior = Math.max(1, nearestRank(ascending, 50));
    const cutoff = nearestRank(ascending, DOWNLOAD_PERCENTILE);

    const cooling = new Set(db.prepare(`
      SELECT DISTINCT p.world_id FROM hidden_gem_picks p
      JOIN hidden_gem_rotations r ON r.id = p.rotation_id
      WHERE r.rotated_at > ?
    `).pluck().all(cooldownCutoff(now)));

    return rows
      .filter((row) => row.downloads < cutoff && row.likes >= MIN_LIKES && !cooling.has(row.id))
      .map((row) => ({ id: row.id, score: (row.likes + prior * baseRate) / (row.downloads + prior) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, PICK_COUNT)
      .map((row) => row.id);
  },

  /**
   * Record a new rotation when none exists or the newest is due, then prune old rotations.
   *
   * @param {Date} now - The run's time
   * @returns {string[]|null} The new rotation's picks, or null when none was due
   */
  rotate: (now) => db.transaction(() => {
    const newest = db.prepare(`SELECT rotated_at FROM hidden_gem_rotations ${NEWEST_ORDER}`).get();
    let picks = null;

    if (!newest || now.getTime() - Date.parse(newest.rotated_at) >= ROTATION_INTERVAL_MS) {
      picks = HiddenGem.pick(now);
      const { lastInsertRowid } = db.prepare('INSERT INTO hidden_gem_rotations (rotated_at) VALUES (?)').run(now.toISOString());
      const insert = db.prepare('INSERT INTO hidden_gem_picks (rotation_id, world_id) VALUES (?, ?)');
      for (const id of picks) insert.run(lastInsertRowid, id);
    }

    db.prepare(`
      DELETE FROM hidden_gem_rotations WHERE rotated_at < ? AND id <> (${NEWEST_ROTATION_SQL})
    `).run(cooldownCutoff(now));

    return picks;
  })()
};

module.exports = { HiddenGem, hiddenGemClause };
