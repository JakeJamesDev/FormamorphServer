const { HOUR_MS, DAY_MS } = require('./time');

/** Hidden Gems: the few well-liked, low-download worlds the catalog flags. */
module.exports = Object.freeze({
  /** Most worlds one rotation picks. */
  PICK_COUNT: 3,
  /** A rotation is due once the newest is this old. */
  ROTATION_INTERVAL_MS: 12 * HOUR_MS,
  /** A picked world sits out rotations this long; rotations older than this are pruned. */
  COOLDOWN_MS: 7 * DAY_MS,
  /** UTC days of likes and downloads a score reads, ending on the rotation's day. */
  WINDOW_DAYS: 60,
  /** Fewest window likes an eligible world has. */
  MIN_LIKES: 3,
  /** Window downloads must be strictly below this percentile of the population's. */
  DOWNLOAD_PERCENTILE: 75
});
