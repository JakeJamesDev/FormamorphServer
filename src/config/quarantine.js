/** How long a quarantine runs by default, and the bounds an admin may set instead. */
const DEFAULT_QUARANTINE_DAYS = 7;
const MIN_QUARANTINE_DAYS = 1;
const MAX_QUARANTINE_DAYS = 90;

/**
 * Read a quarantine length off a request body. Absent means the default.
 *
 * @param {*} days - The body's `days`
 * @returns {Object} `{ days }` when it is in bounds, otherwise `{ error }`
 */
const quarantineDays = (days) => {
  const requested = days === undefined ? DEFAULT_QUARANTINE_DAYS : Number(days);
  if (!Number.isInteger(requested) || requested < MIN_QUARANTINE_DAYS || requested > MAX_QUARANTINE_DAYS) {
    return { error: `Quarantine must be between ${MIN_QUARANTINE_DAYS} and ${MAX_QUARANTINE_DAYS} whole days` };
  }

  return { days: requested };
};

module.exports = { DEFAULT_QUARANTINE_DAYS, MIN_QUARANTINE_DAYS, MAX_QUARANTINE_DAYS, quarantineDays };
