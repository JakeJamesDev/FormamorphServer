/**
 * What an Anonymous Like is addressed by, and the switch that decides whether one may be given.
 *
 * An account Like is one account's mark. An Anonymous Like is one **Install's**: a random id the app
 * makes once and keeps in local storage, sent in a header. It names a copy of the app and nothing else —
 * not a person, not a device — which is the whole of why a guest can press the heart without an account.
 *
 * The feature ships switched off. The privacy text has to state the collection before the first row is
 * stored, so the operator turns it on after the text is live, and can turn it off again without a deploy.
 */

/** The setting that gates the route. */
const ANONYMOUS_LIKES = 'anonymous_likes';

/** The header, lowercase, as Node hands it over in `req.headers`. */
const INSTALL_HEADER = 'x-formamorph-install';

/** The header as it is written when it is set, for the CORS allow-list and for a client to copy. */
const INSTALL_HEADER_NAME = 'X-Formamorph-Install';

/**
 * A UUID as `crypto.randomUUID()` writes one, in any case.
 *
 * Checked rather than taken as given, because this string is stored and is the key a Claim later moves a
 * row by. Accepting whatever arrived would let a client use the column as storage of its own, and would
 * leave two spellings of one Install reading as two.
 */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Install this request came from.
 *
 * @param {Object} req - The Express request
 * @returns {string|null} The id in lower case, or null when the header is absent or malformed
 */
const installIdFrom = (req) => {
  const sent = req.headers[INSTALL_HEADER];

  return typeof sent === 'string' && INSTALL_ID.test(sent) ? sent.toLowerCase() : null;
};

/**
 * How many Anonymous Likes one address may give one listing.
 *
 * An Install is free to make: clearing local storage makes a new one, and a script could make a
 * thousand. The address behind them is the one thing that is harder to change, so it is what the count
 * is held against. Three rather than one, because a household, a dorm and an office all look like one
 * address, and a family who each liked a world are not a ring. Nothing beyond this number happens to a
 * shared address — no flag, no hold, no score.
 *
 * Per listing, not per address: liking three worlds is not what this is for.
 */
const ADDRESS_CAP = 3;

/**
 * Why a press was refused, so the client can choose its message.
 *
 * The client shows different things for each: a switched-off server sends the guest to sign-in as it
 * always did, a listing that has gone quiet needs no message at all, and a malformed header is the
 * client's own bug. A code rather than the wording, so changing the wording never changes behavior.
 */
const CODES = Object.freeze({
  OFF: 'anonymous_likes_off',
  NOT_VISIBLE: 'listing_not_visible',
  BAD_INSTALL: 'install_header_invalid',
  BAD_LIKED: 'liked_invalid',
  ADDRESS_CAP: 'anonymous_likes_address_cap'
});

/**
 * Whether a stored value is one this switch can act on.
 *
 * @param {*} value - Anything the settings route was handed
 * @returns {string|null} What is wrong with it, or null
 */
const validateAnonymousLikes = (value) =>
  typeof value === 'boolean' ? null : 'Anonymous Likes must be true or false';

module.exports = {
  ANONYMOUS_LIKES,
  INSTALL_HEADER_NAME,
  ADDRESS_CAP,
  CODES,
  installIdFrom,
  validateAnonymousLikes
};
