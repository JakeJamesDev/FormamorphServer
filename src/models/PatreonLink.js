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

// Prepared on first use: the table exists only after the schema migration runs.
let flairStatement;

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
   * The link fields an author object reads, or null with no link.
   *
   * Called once per author on every list, so the statement is prepared once.
   *
   * @param {string} userId - The account
   * @returns {{ tier: string|null, pledge_start: string|null, show_flair: number }|null}
   */
  flairOf: (userId) => {
    flairStatement ||= db.prepare('SELECT tier, pledge_start, show_flair FROM patreon_links WHERE user_id = ?');
    return flairStatement.get(userId) || null;
  },

  /**
   * Set an account's flair toggle.
   *
   * @param {string} userId - The account
   * @param {boolean} showFlair - Whether the flair shows
   * @returns {boolean} Whether the account has a link to set
   */
  setShowFlair: (userId, showFlair) =>
    db.prepare('UPDATE patreon_links SET show_flair = ? WHERE user_id = ?').run(showFlair ? 1 : 0, userId).changes > 0,

  /**
   * Remove an account's link. Removing no link is not an error.
   *
   * @param {string} userId - The account
   */
  unlink: (userId) => {
    db.prepare('DELETE FROM patreon_links WHERE user_id = ?').run(userId);
  },

  /**
   * Set the tier of the account that links a Patreon user. A Patreon user with no link changes nothing.
   *
   * @param {Object} update - `{ patreonUserId, tier, pledgeStart, checkedAt }`
   */
  setTier: ({ patreonUserId, tier, pledgeStart, checkedAt }) => {
    db.prepare('UPDATE patreon_links SET tier = ?, pledge_start = ?, checked_at = ? WHERE patreon_user_id = ?')
      .run(tier, pledgeStart, checkedAt, patreonUserId);
  },

  /**
   * Set the tier of every link in one transaction.
   *
   * @param {Function} stateOf - Patreon user ID to `{ tier, pledgeStart }`
   * @param {string} checkedAt - When the tiers were read
   * @returns {number} How many links were set
   */
  setAllTiers: db.transaction((stateOf, checkedAt) => {
    const ids = db.prepare('SELECT patreon_user_id FROM patreon_links').pluck().all();
    for (const patreonUserId of ids) PatreonLink.setTier({ patreonUserId, ...stateOf(patreonUserId), checkedAt });
    return ids.length;
  })
};

module.exports = PatreonLink;
