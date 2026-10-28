const db = require('../config/db');
const { SUPPORTER, SUPPORTER_PLUS } = require('../config/patreon');
const { isStaff } = require('../config/roles');

const QUALIFYING_TIERS = new Set([SUPPORTER, SUPPORTER_PLUS]);

/**
 * Whether an account's live tier is Supporter or Supporter+ and its Supporter content access is not
 * revoked. Read from the database on every call, so a lapse or a revoke takes effect at the next request.
 *
 * @param {string} userId - The account
 * @returns {boolean}
 */
const qualifiesForSupporterContent = (userId) => {
  const row = db.prepare(`
    SELECT l.tier, u.supporter_content_revoked_at AS revoked_at
    FROM users u LEFT JOIN patreon_links l ON l.user_id = u.id
    WHERE u.id = ?
  `).get(userId);

  return Boolean(row) && QUALIFYING_TIERS.has(row.tier) && !row.revoked_at;
};

/**
 * Whether this account may receive a Supporter-only listing: a qualifying Supporter, or the listing's
 * author or staff, who check and revise it whatever their tier.
 *
 * @param {Object} user - The signed-in account
 * @param {Object} listing - The worlds row
 * @returns {boolean}
 */
const mayReceiveSupporterContent = (user, listing) =>
  isStaff(user) || listing.author_id === user.id || qualifiesForSupporterContent(user.id);

/** What a route answers with when it refuses Supporter-only content. */
const SUPPORTER_ONLY_ERROR = 'This listing is for Supporters';

module.exports = { SUPPORTER_ONLY_ERROR, qualifiesForSupporterContent, mayReceiveSupporterContent };
