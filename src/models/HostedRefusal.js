const db = require('../config/db');

/**
 * Per-day totals of refused Formamorph AI calls. `schema/steps/hostedRefusals` says what a row holds.
 */
const HostedRefusal = {
  /**
   * Count one refusal on its UTC day's total: a new total, or one more on the existing one.
   *
   * @param {Object} refusal - `{ userId, subject, tier, code, at }`; `subject` and `tier` may be null
   */
  record: ({ userId, subject, tier, code, at }) => {
    const instant = at.toISOString();
    db.prepare(`
      INSERT INTO hosted_refusals (day, user_id, subject, tier, code, count, first_at, last_at)
      VALUES (@day, @userId, @subject, @tier, @code, 1, @instant, @instant)
      ON CONFLICT (day, user_id, code, tier) DO UPDATE SET
        count = count + 1, last_at = excluded.last_at, subject = excluded.subject
    `).run({ day: instant.slice(0, 10), userId, subject: subject ?? null, tier: tier ?? '', code, instant });
  },

  /**
   * Refusals per UTC day and code since a day, with the distinct accounts. An erased total counts, its account does not.
   *
   * @param {string} sinceDay - 'YYYY-MM-DD', inclusive
   * @returns {{ day: string, code: string, count: number, accounts: number }[]}
   */
  days: (sinceDay) => db.prepare(`
    SELECT day, code, SUM(count) AS count, COUNT(DISTINCT user_id) AS accounts
    FROM hosted_refusals WHERE day >= ? GROUP BY day, code ORDER BY day, code
  `).all(sinceDay),

  /**
   * Refusals per tier and code since a day. A refusal with no tier reports a null tier.
   *
   * @param {string} sinceDay - 'YYYY-MM-DD', inclusive
   * @returns {{ tier: string|null, code: string, count: number, accounts: number }[]}
   */
  tiers: (sinceDay) => db.prepare(`
    SELECT NULLIF(tier, '') AS tier, code, SUM(count) AS count, COUNT(DISTINCT user_id) AS accounts
    FROM hosted_refusals WHERE day >= ? GROUP BY tier, code ORDER BY tier, code
  `).all(sinceDay),

  /**
   * The distinct accounts refused with one code since a day.
   *
   * @param {string} sinceDay - 'YYYY-MM-DD', inclusive
   * @param {string} code - A refusal code
   * @returns {number}
   */
  accountsSince: (sinceDay, code) => db
    .prepare('SELECT COUNT(DISTINCT user_id) AS accounts FROM hosted_refusals WHERE day >= ? AND code = ?')
    .get(sinceDay, code).accounts,

  /**
   * Delete totals whose first refusal was before an instant, so no stored time outlives retention.
   *
   * @param {string} before - ISO instant
   * @returns {number} Totals deleted
   */
  deleteBefore: (before) => db.prepare('DELETE FROM hosted_refusals WHERE first_at < ?').run(before).changes,

  /**
   * Detach an erased account from its totals, which stay.
   *
   * @param {string} userId - The account being erased
   */
  forgetUser: (userId) => {
    db.prepare('UPDATE hosted_refusals SET user_id = NULL WHERE user_id = ?').run(userId);
  }
};

module.exports = HostedRefusal;
