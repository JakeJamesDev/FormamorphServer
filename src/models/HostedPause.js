const db = require('../config/db');

/**
 * Formamorph AI pauses: one row per UTC day whose spend reached the daily ceiling.
 */
const HostedPause = {
  /**
   * The day's pause, or null when the day has none.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @returns {{ day: string, paused_at: string, lifted_at: string|null, lifted_by: string|null }|null}
   */
  forDay: (day) => db.prepare('SELECT * FROM hosted_pause WHERE day = ?').get(day) || null,

  /**
   * Pause a day, unless it already has a pause.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @param {string} at - ISO instant
   * @returns {boolean} Whether this call made the pause
   */
  start: (day, at) => db
    .prepare('INSERT OR IGNORE INTO hosted_pause (day, paused_at) VALUES (?, ?)')
    .run(day, at).changes === 1,

  /**
   * Lift a day's pause for the rest of that day.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @param {string} at - ISO instant
   * @param {string} userId - The admin who lifted it
   * @returns {boolean} Whether a pause was lifted
   */
  lift: (day, at, userId) => db
    .prepare('UPDATE hosted_pause SET lifted_at = ?, lifted_by = ? WHERE day = ? AND lifted_at IS NULL')
    .run(at, userId, day).changes === 1
};

module.exports = HostedPause;
