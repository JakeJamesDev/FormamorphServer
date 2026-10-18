const { DAY_MS } = require('./time');

/** The lengths staff may give a timed suspension, in whole days. */
const MIN_SUSPENSION_DAYS = 1;
const MAX_SUSPENSION_DAYS = 90;

/** Whether a length is whole days within the range. A string is not a length. */
const validSuspensionDays = (days) =>
  Number.isInteger(days) && days >= MIN_SUSPENSION_DAYS && days <= MAX_SUSPENSION_DAYS;

/**
 * When a suspension of this many days ends, or null for no end.
 *
 * @param {number|null} days - A validated length, or null
 * @param {number} [now] - Epoch milliseconds to count from, for tests
 * @returns {string|null} ISO instant
 */
const suspensionEnd = (days, now = Date.now()) => (days === null ? null : new Date(now + days * DAY_MS).toISOString());

/**
 * An ISO instant as the refusal names it, to the minute: `2026-10-24 18:30 UTC`.
 *
 * @param {string} iso - The end
 * @returns {string} The end in UTC
 */
const utcMinute = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Whether a suspension's end has passed. Both sides are ISO instants this server wrote, so they compare
 * as strings.
 *
 * @param {Object} user - A users row with `status` and `suspended_until`
 * @param {string} now - ISO instant
 * @returns {boolean} Whether the suspension is due to lift
 */
const suspensionExpired = (user, now) =>
  user.status === 'suspended' && Boolean(user.suspended_until) && user.suspended_until <= now;

module.exports = { MIN_SUSPENSION_DAYS, MAX_SUSPENSION_DAYS, validSuspensionDays, suspensionEnd, utcMinute, suspensionExpired };
