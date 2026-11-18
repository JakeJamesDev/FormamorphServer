const db = require('../config/db');
const { SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP } = require('../config/patreon');
const { isStaff } = require('../config/roles');
const { tierAdmission } = require('./supporterSchedule');

const QUALIFYING_TIERS = new Set([SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP]);

/**
 * An account's live Supporter tier, or null when it holds none or its Supporter content access is
 * revoked. Read from the database on every call, so a lapse or a revoke takes effect at the next request.
 *
 * @param {string} userId - The account
 * @returns {string|null} The tier key
 */
const supporterTierOf = (userId) => {
  const row = db.prepare(`
    SELECT l.tier, u.supporter_content_revoked_at AS revoked_at
    FROM users u LEFT JOIN patreon_links l ON l.user_id = u.id
    WHERE u.id = ?
  `).get(userId);

  return row && QUALIFYING_TIERS.has(row.tier) && !row.revoked_at ? row.tier : null;
};

const qualifiesForSupporterContent = (userId) => supporterTierOf(userId) !== null;

/**
 * What a download of a Supporter-only listing gets for this account now. Staff and the listing's author
 * pass at every stage, whatever their tier. Anyone else needs a qualifying tier that ranks at or above the
 * tier open now.
 *
 * @param {Object} user - The signed-in account
 * @param {Object} listing - The worlds row
 * @param {Array<{ tier: string, opens_at: string }>} rows - The listing's schedule rows
 * @param {number} [now] - Epoch milliseconds; tests inject it
 * @returns {{ ok: boolean, requiredTier?: string, opensAt?: string|null }} A refusal names the tier open now
 *   and the date this account's own tier opens, or null when it never does
 */
const supporterAdmission = (user, listing, rows, now = Date.now()) => {
  if (isStaff(user) || listing.author_id === user.id) return { ok: true };

  const tier = supporterTierOf(user.id);
  if (!tier) return { ok: false };

  const { ok, requiredTier, opensAt } = tierAdmission(tier, listing, rows, now);

  return ok ? { ok } : { ok, requiredTier, opensAt };
};

/** What a route answers with when it refuses Supporter-only content. */
const SUPPORTER_ONLY_ERROR = 'This listing is for Supporters';

/** The refusal for a qualifying account whose tier has not opened yet. */
const tierNotOpenError = ({ requiredTier, opensAt }) =>
  `This listing is open to ${requiredTier} Supporters now${opensAt ? ` and opens to your tier on ${opensAt}` : ''}`;

module.exports = {
  SUPPORTER_ONLY_ERROR,
  supporterTierOf,
  qualifiesForSupporterContent,
  supporterAdmission,
  tierNotOpenError
};
