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
  ADDRESS_CAP: 'anonymous_likes_address_cap',
  // The three an Install inherits from the account that claimed it. Signing out is not a way around an
  // account's own rules, so the guest route asks the same three questions the account route asks. It
  // does not answer them the same way: this route keeps 400 for a malformed request and 403 for a press
  // the Install may not make, where the account route answers its own-listing refusal with a 400.
  //
  // "Account" rather than "linked", which this server already uses for accounts that share an address.
  // The last is not a failure at all: the listing really is liked, by the account, so it answers 200.
  ACCOUNT_SUSPENDED: 'anonymous_likes_account_suspended',
  ACCOUNT_OWN_LISTING: 'anonymous_likes_account_own_listing',
  ACCOUNT_ALREADY_LIKED: 'anonymous_likes_account_already_liked'
});

/**
 * The refusal for a request that named no usable Install.
 *
 * One body rather than one per route: both the guest route and the Claim need an Install before they can
 * do anything, and two spellings of the same refusal would be two the client has to recognize.
 */
const NO_INSTALL = Object.freeze({
  success: false,
  code: CODES.BAD_INSTALL,
  error: 'This request carried no usable install id'
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
  NO_INSTALL,
  installIdFrom,
  validateAnonymousLikes
};
