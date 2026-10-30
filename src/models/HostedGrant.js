const db = require('../config/db');

/**
 * Staff grants of a Formamorph AI tier, and the warnings an account has acknowledged.
 *
 * A grant is live from creation until its end date, unless staff revoke it first. Its spend subject is
 * `grant:<id>`.
 */
const HostedGrant = {
  /** The spend subject of a grant. */
  subjectOf: (id) => `grant:${id}`,

  /**
   * @param {Object} grant - `{ userId, tier, endsAt, createdBy }`
   * @returns {Object} The stored grant
   */
  create: ({ userId, tier, endsAt, createdBy }) => {
    const id = Number(db.prepare(`
      INSERT INTO hosted_grants (user_id, tier, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(userId, tier, endsAt, createdBy, new Date().toISOString()).lastInsertRowid);

    return HostedGrant.find(id);
  },

  find: (id) => db.prepare(`
    SELECT g.*, u.username FROM hosted_grants g LEFT JOIN users u ON u.id = g.user_id WHERE g.id = ?
  `).get(id) || null,

  /** Every grant, newest first, with the username it entitles. */
  list: () => db.prepare(`
    SELECT g.*, u.username FROM hosted_grants g LEFT JOIN users u ON u.id = g.user_id ORDER BY g.id DESC
  `).all(),

  /**
   * Revoke a grant. A grant already revoked keeps its first revocation time.
   *
   * @param {number} id - The grant
   * @returns {Object|null} The grant, or null when there is none
   */
  revoke: (id) => {
    db.prepare('UPDATE hosted_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);

    return HostedGrant.find(id);
  },

  /**
   * An account's grants that are live at an instant.
   *
   * @param {string} userId - The account
   * @param {Date} now - The instant
   * @returns {Object[]}
   */
  liveFor: (userId, now) => db
    .prepare('SELECT * FROM hosted_grants WHERE user_id = ? AND revoked_at IS NULL AND ends_at > ?')
    .all(userId, now.toISOString()),

  /**
   * Warnings an account acknowledged in a month.
   *
   * @param {string} userId - The account
   * @param {string} month - `YYYY-MM`, UTC
   * @returns {number[]} Thresholds, ascending
   */
  acknowledged: (userId, month) => db
    .prepare('SELECT threshold FROM hosted_warning_acks WHERE user_id = ? AND month = ? ORDER BY threshold')
    .all(userId, month).map((row) => row.threshold),

  /** Record a warning as acknowledged. Repeating it changes nothing. */
  acknowledge: (userId, month, threshold) => {
    db.prepare('INSERT OR IGNORE INTO hosted_warning_acks (user_id, month, threshold) VALUES (?, ?, ?)')
      .run(userId, month, threshold);
  }
};

module.exports = HostedGrant;
