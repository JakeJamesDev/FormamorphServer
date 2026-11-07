const crypto = require('crypto');
const db = require('../config/db');

/**
 * The Daily Send's live rows (a month's key, and per day a keyed hash with the platform and version) and
 * the totals a Month Close leaves.
 *
 * No row holds an account, an address or a raw Install id. A month's key never leaves this module.
 */

/** The month's key, made on its first send. Insert-or-ignore, so two first sends agree on one key. */
const monthKey = (month) => {
  db.prepare('INSERT OR IGNORE INTO active_install_keys (month, secret) VALUES (?, ?)').run(month, crypto.randomBytes(32));

  return db.prepare('SELECT secret FROM active_install_keys WHERE month = ?').get(month).secret;
};

/** Each breakdown row, grouped by the value of its `column`. */
const groupRows = (rows, column) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[column])) groups.set(row[column], []);
    groups.get(row[column]).push({ platform: row.platform, version: row.version, count: row.count });
  }

  return groups;
};

/** Each live row with its month and its place among that hash's rows that month, oldest first. */
const rankedInMonth = (where) => `
  SELECT substr(day, 1, 7) AS month, platform, version,
    ROW_NUMBER() OVER (PARTITION BY substr(day, 1, 7), hash ORDER BY day) AS nth
  FROM active_install_days ${where}
`;

/** Closed periods of one kind from `since` on, inclusive, grouped by period. */
const closedSince = (kind, since) => groupRows(db.prepare(`
  SELECT period, platform, version, count FROM active_install_totals WHERE kind = ? AND period >= ?
`).all(kind, since), 'period');

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
   * Each day's distinct installs since a day, inclusive, by platform and version. A closed day reads its totals.
   *
   * @param {string} since - 'YYYY-MM-DD', UTC
   * @returns {Map<string, Array<{ platform: string, version: string, count: number }>>} Day to breakdown
   */
  daysSince: (since) => new Map([
    ...groupRows(db.prepare(`
      SELECT day, platform, version, COUNT(*) AS count FROM active_install_days
      WHERE day >= ? GROUP BY day, platform, version
    `).all(since), 'day'),
    ...closedSince('day', since)
  ]),

  /**
   * Each month's distinct installs, each under the platform and version of its first row that month.
   * A closed month reads its totals.
   *
   * @returns {Map<string, Array<{ platform: string, version: string, count: number }>>} 'YYYY-MM' to breakdown
   */
  months: () => new Map([
    ...groupRows(db.prepare(`
      SELECT month, platform, version, COUNT(*) AS count FROM (${rankedInMonth('')})
      WHERE nth = 1 GROUP BY month, platform, version
    `).all(), 'month'),
    ...closedSince('month', '')
  ]),

  /**
   * Month Close: write totals for every month before `current`, then delete its rows and every older key.
   * A month that already has totals keeps them, and only its rows go.
   *
   * @param {string} current - 'YYYY-MM', UTC; this month stays live
   * @returns {number} Months that gained totals
   */
  closeMonthsBefore: db.transaction((current) => {
    const months = db.prepare('SELECT DISTINCT substr(day, 1, 7) AS month FROM active_install_days WHERE day < ?')
      .all(`${current}-01`).map((row) => row.month);
    let closed = 0;

    for (const month of months) {
      if (!db.prepare("SELECT 1 FROM active_install_totals WHERE kind = 'month' AND period = ?").get(month)) {
        closed += 1;
        db.prepare(`
          INSERT INTO active_install_totals (kind, period, platform, version, count)
          SELECT 'day', day, platform, version, COUNT(*) FROM active_install_days
          WHERE substr(day, 1, 7) = ? GROUP BY day, platform, version
        `).run(month);
        db.prepare(`
          INSERT INTO active_install_totals (kind, period, platform, version, count)
          SELECT 'month', month, platform, version, COUNT(*) FROM (${rankedInMonth('WHERE substr(day, 1, 7) = ?')})
          WHERE nth = 1 GROUP BY platform, version
        `).run(month);
      }
      db.prepare('DELETE FROM active_install_days WHERE substr(day, 1, 7) = ?').run(month);
    }

    db.prepare('DELETE FROM active_install_keys WHERE month < ?').run(current);

    return closed;
  })
};

module.exports = ActiveInstall;
