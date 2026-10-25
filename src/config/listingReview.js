const { isStaff } = require('./roles');

/**
 * Listing review: new listings wait for a mod before players can see them.
 *
 * The feature ships switched off. The operator turns it on once the client that shows a pending listing
 * is released, so an old client never publishes into a state it cannot show.
 */

/** The setting that turns review on. Admin-only: one mod must not be able to switch it off. */
const LISTING_REVIEW = 'listing_review';

/** Where a listing stands in review. Only `approved` is in circulation. */
const MODERATION_STATES = Object.freeze({
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected'
});

/**
 * Whether a value is one the setting can hold.
 *
 * @param {*} value - The body's `value`
 * @returns {string|null} Why it was refused, or null when it is fine
 */
const validateListingReview = (value) => (typeof value === 'boolean' ? null : 'Must be true or false');

/**
 * Whether this account's uploads go live without review. Staff skip it.
 *
 * @param {Object} user - The publishing account
 * @returns {boolean} True when review is skipped
 */
const skipsReview = (user) => isStaff(user);

/**
 * Whether a listing row is in circulation as far as review goes.
 *
 * Strict on purpose: a row read without the column reads as hidden, so a query that forgets to select it
 * fails closed.
 *
 * @param {Object} world - A world row
 * @returns {boolean} True when it is approved
 */
const isApproved = (world) => Boolean(world) && world.moderation_state === MODERATION_STATES.APPROVED;

/**
 * The SQL test for the same rule, for queries that filter in the database.
 *
 * @param {string} alias - The worlds table alias
 * @returns {string} A WHERE fragment with no parameters
 */
const approvedClause = (alias) => `${alias}.moderation_state = '${MODERATION_STATES.APPROVED}'`;

module.exports = {
  LISTING_REVIEW,
  MODERATION_STATES,
  validateListingReview,
  skipsReview,
  isApproved,
  approvedClause
};
