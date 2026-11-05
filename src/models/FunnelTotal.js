const db = require('../config/db');

/**
 * Anonymous per-day totals for each step of the Formamorph AI offer: a row is a day, a step and a count.
 */
const FunnelTotal = {
  /**
   * Add one to a step's total for a day.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @param {string} step - One of `FUNNEL_STEPS`
   */
  increment: (day, step) => {
    db.prepare(`
      INSERT INTO funnel_totals (day, step, count) VALUES (?, ?, 1)
      ON CONFLICT (day, step) DO UPDATE SET count = count + 1
    `).run(day, step);
  },

  /**
   * Every stored total, newest day first.
   *
   * @returns {Array<{ day: string, step: string, count: number }>}
   */
  all: () => db.prepare('SELECT day, step, count FROM funnel_totals ORDER BY day DESC, step ASC').all(),

  /**
   * Each step's total since a day, inclusive.
   *
   * @param {string} day - 'YYYY-MM-DD', UTC
   * @returns {Map<string, number>} Step to count
   */
  sumsSince: (day) => new Map(db.prepare('SELECT step, SUM(count) AS count FROM funnel_totals WHERE day >= ? GROUP BY step').all(day)
    .map((row) => [row.step, row.count]))
};

module.exports = FunnelTotal;
