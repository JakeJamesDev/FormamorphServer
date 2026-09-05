/**
 * The one-shot tokens behind a verification or a reset link, named apart from the model that mints them.
 *
 * The model and the controllers spell a purpose from here rather than as a literal, so a token minted for
 * one door cannot be spelled a way another door happens to accept. The schema keeps its own copy of the
 * two names in a CHECK constraint, because a migration must not open a config module to know them.
 */

const { HOUR_MS, DAY_MS } = require('./time');

/** Proving an address is yours. */
const VERIFY = 'verify';

/** Setting a new password without the old one. */
const RESET = 'reset';

/**
 * How long each kind of link lives.
 *
 * A reset hands out an account, so it gets the shortest window a person can still act in. Verification
 * only confirms an address already on the account, and the mail may sit unread overnight.
 */
const TOKEN_TTL_MS = Object.assign(Object.create(null), {
  [VERIFY]: DAY_MS,
  [RESET]: HOUR_MS
});

/**
 * When a token minted now runs out.
 *
 * @param {string} purpose - `VERIFY` or `RESET`
 * @param {number} [now] - The instant to measure from, in milliseconds
 * @returns {string} ISO timestamp
 * @throws {Error} A purpose with no lifetime, which would otherwise mint a token that never expires
 */
const tokenExpiry = (purpose, now = Date.now()) => {
  const lifetime = TOKEN_TTL_MS[purpose];
  if (!lifetime) throw new Error(`Unknown account token purpose: ${purpose}`);

  return new Date(now + lifetime).toISOString();
};

module.exports = { VERIFY, RESET, tokenExpiry };
