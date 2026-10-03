const db = require('../config/db');

/**
 * The link between an account and a Patreon user.
 *
 * One row per account and one per Patreon user ID. A link to a Patreon user ID that another account holds
 * is refused, never moved: the member unlinks there first.
 */

/** Thrown by `link` when another account holds the Patreon user ID. */
class PatreonUserTaken extends Error {}

const isHeldElsewhere = (patreonUserId, userId) => {
  const holder = db.prepare('SELECT user_id FROM patreon_links WHERE patreon_user_id = ?').get(patreonUserId);
  return Boolean(holder) && holder.user_id !== userId;
};

const replaceLink = db.transaction(({ userId, patreonUserId, tier, pledgeStart, checkedAt, now }) => {
  if (isHeldElsewhere(patreonUserId, userId)) throw new PatreonUserTaken();

  // A relink is an unlink plus a link, so the flair toggle starts fresh with the new row.
  db.prepare('DELETE FROM patreon_links WHERE user_id = ?').run(userId);
  db.prepare(`
    INSERT INTO patreon_links (user_id, patreon_user_id, tier, pledge_start, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, patreonUserId, tier, pledgeStart, checkedAt, now);
});

const PatreonLink = {
  PatreonUserTaken,

  /**
   * An account's link, or null.
   *
   * @param {string} userId - The account
   * @returns {Object|null} The row
   */
  findByUser: (userId) => db.prepare('SELECT * FROM patreon_links WHERE user_id = ?').get(userId) || null,

  /**
   * Whether an account other than this one holds the Patreon user ID.
   *
   * @param {string} patreonUserId - The Patreon user
   * @param {string} userId - The account asking
   * @returns {boolean} Whether the link would be refused
   */
  isHeldElsewhere,

  /**
   * Link an account to a Patreon user, replacing any link the account already has.
   *
   * @param {Object} link - `{ userId, patreonUserId, tier, pledgeStart, checkedAt }`; `checkedAt` null when
   *   the tier read failed
   * @throws {PatreonUserTaken} When another account holds the Patreon user ID
   */
  link: ({ userId, patreonUserId, tier, pledgeStart, checkedAt }) => {
    replaceLink({ userId, patreonUserId, tier, pledgeStart, checkedAt, now: new Date().toISOString() });
  },

  /**
   * Remove an account's link. Removing no link is not an error.
   *
   * @param {string} userId - The account
   */
  unlink: (userId) => {
    db.prepare('DELETE FROM patreon_links WHERE user_id = ?').run(userId);
  }
};

module.exports = PatreonLink;
