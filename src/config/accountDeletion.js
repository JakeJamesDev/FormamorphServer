/**
 * How an account ends, named apart from the modules that carry it out.
 *
 * The schema step that seeds the reserved user needs the id and the name, and a migration must not have to
 * open a model — and through it a second database connection — to learn them. The request endpoint, the
 * sweeper and the erasure module all read the same constants from here, so the window one promises and the
 * window another enforces cannot drift apart.
 */

/** How long a request waits before it is carried out. Logging in during it cancels the whole thing. */
const GRACE_PERIOD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The whole of the window, in milliseconds, so the two helpers below cannot measure it differently. */
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * DAY_MS;

/**
 * The reserved account that owns the work of everyone who left but kept it.
 *
 * A fixed id rather than a lookup by name: the erasure module reassigns rows to it inside a transaction,
 * and a rename from the admin side must never leave that pointing at nothing.
 */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/** What the room sees in place of the name. Fixed: it is a tombstone, not a profile. */
const PLACEHOLDER_USERNAME = '[deleted user]';

/**
 * The status no credential can get past.
 *
 * The reserved row has a password column like every other, so it needs a value; login refuses this status
 * before it ever compares one. Belt and braces, because the row is the one account whose name every
 * departing user's work points at.
 */
const SYSTEM_STATUS = 'system';

/** What the reserved row stores where a hash goes. Sixty characters short of anything bcrypt can match. */
const NO_PASSWORD = '*';

/**
 * When a request stamped at `requestedAt` comes due.
 *
 * @param {string} requestedAt - ISO timestamp of the request
 * @returns {string} ISO timestamp of the erasure
 */
const erasureDue = (requestedAt) =>
  new Date(new Date(requestedAt).getTime() + GRACE_PERIOD_MS).toISOString();

/**
 * The instant a request must predate to be due at `now`.
 *
 * @param {string} [now] - The instant to measure back from
 * @returns {string} ISO timestamp
 */
const graceCutoff = (now = undefined) =>
  new Date((now ? new Date(now).getTime() : Date.now()) - GRACE_PERIOD_MS).toISOString();

module.exports = {
  GRACE_PERIOD_DAYS,
  PLACEHOLDER_ID,
  PLACEHOLDER_USERNAME,
  SYSTEM_STATUS,
  NO_PASSWORD,
  erasureDue,
  graceCutoff
};
