const crypto = require('crypto');
const db = require('../config/db');

/**
 * The Daily Send's live rows: a month's key, and per day a keyed hash with the platform and version.
 *
 * No row holds an account, an address or a raw Install id. A month's key never leaves this module.
 */

/** The month's key, made on its first send. Insert-or-ignore, so two first sends agree on one key. */
const monthKey = (month) => {
  db.prepare('INSERT OR IGNORE INTO active_install_keys (month, secret) VALUES (?, ?)').run(month, crypto.randomBytes(32));

  return db.prepare('SELECT secret FROM active_install_keys WHERE month = ?').get(month).secret;
};

/** Each breakdown row, grouped by the value of its `column` ('day' or 'month'). */
const groupRows = (rows, column) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[column])) groups.set(row[column], []);
    groups.get(row[column]).push({ platform: row.platform, version: row.version, count: row.count });
  }

  return groups;
};

const ActiveInstall = {
  /**
   * Count one Install on one day. A repeat that day changes nothing, so the first version stays.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @param {string} installId - A checked Install id
   * @param {string} platform - The build's platform
   * @param {string} version - The build's version, never version zero
   */
  record: db.transaction((day, installId, platform, version) => {
    const hash = crypto.createHmac('sha256', monthKey(day.slice(0, 7))).update(installId).digest('hex');

    db.prepare('INSERT OR IGNORE INTO active_install_days (day, hash, platform, version) VALUES (?, ?, ?, ?)')
      .run(day, hash, platform, version);
  }),

  /**
   * Each live day's distinct installs since a day, inclusive, by platform and version.
   *
   * @param {string} since - 'YYYY-MM-DD', UTC
   * @returns {Map<string, Array<{ platform: string, version: string, count: number }>>} Day to breakdown
   */
  daysSince: (since) => groupRows(db.prepare(`
    SELECT day, platform, version, COUNT(*) AS count FROM active_install_days
    WHERE day >= ? GROUP BY day, platform, version
  `).all(since), 'day'),

  /**
   * Each live month's distinct installs, each under the platform and version of its first row that month.
   *
   * @returns {Map<string, Array<{ platform: string, version: string, count: number }>>} 'YYYY-MM' to breakdown
   */
  months: () => groupRows(db.prepare(`
    SELECT month, platform, version, COUNT(*) AS count FROM (
      SELECT substr(day, 1, 7) AS month, platform, version,
        ROW_NUMBER() OVER (PARTITION BY substr(day, 1, 7), hash ORDER BY day) AS nth
      FROM active_install_days
    ) WHERE nth = 1 GROUP BY month, platform, version
  `).all(), 'month')
};

module.exports = ActiveInstall;
