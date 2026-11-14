const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a listing is Supporter-only at this instant: the flag is on and the end date is absent or still
 * ahead. Every route that reads the flag asks this, so expiry is exact without waiting for the sweep.
 *
 * @param {Object} row - A worlds row (`supporter_only` may be 0/1 or a boolean)
 * @param {number} [now] - Epoch milliseconds; tests inject it
 * @returns {boolean}
 */
const isSupporterOnlyNow = (row, now = Date.now()) => {
  if (!row || !row.supporter_only) return false;
  if (!row.supporter_until) return true;

  return Date.parse(row.supporter_until) > now;
};

/** The end date to show, only while the listing is Supporter-only; otherwise null. */
const supporterUntilOf = (row, now = Date.now()) =>
  isSupporterOnlyNow(row, now) ? row.supporter_until || null : null;

/** The end date a duration in days gives, counted from `now`. */
const untilFromDays = (days, now = Date.now()) => new Date(now + days * DAY_MS).toISOString();

const MAX_DAYS = 3650;

// The kinds that can carry an end date.
const TIMED_KINDS = ['mascot', 'world'];

/**
 * Read an end date from a request body: `supporterDays` (a duration) or `supporterUntil` (an instant),
 * either one `null` to clear. Neither present means the body says nothing about the end date.
 *
 * @param {Object} body - The request body
 * @param {number} [now] - Epoch milliseconds
 * @returns {{ provided: boolean, until?: string|null, error?: string }}
 */
const readEndDate = (body, now = Date.now()) => {
  const { supporterDays: days, supporterUntil: until } = body || {};
  if (days === undefined && until === undefined) return { provided: false };
  if (days !== undefined && until !== undefined) {
    return { provided: true, error: 'Send supporterDays or supporterUntil, not both' };
  }
  if (days === null || until === null) return { provided: true, until: null };

  if (days !== undefined) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return { provided: true, error: `supporterDays must be a whole number from 1 to ${MAX_DAYS}` };
    }
    return { provided: true, until: untilFromDays(days, now) };
  }

  const time = typeof until === 'string' ? Date.parse(until) : NaN;
  if (Number.isNaN(time)) return { provided: true, error: 'supporterUntil must be a date' };
  if (time <= now) return { provided: true, error: 'supporterUntil must be in the future' };

  return { provided: true, until: new Date(time).toISOString() };
};

module.exports = { isSupporterOnlyNow, supporterUntilOf, readEndDate, TIMED_KINDS };
