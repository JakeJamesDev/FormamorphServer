const { validateClientMinimums } = require('./clientVersion');
const { ANONYMOUS_LIKES, validateAnonymousLikes } = require('./anonymousLikes');

/**
 * The settings staff can change without a deploy.
 *
 * One row per setting in the `settings` table, holding JSON. Every key is declared here with the value it
 * has before anyone writes one and the check its writes must pass, so an unknown key is refused at the
 * route rather than stored, and a stored value is always one the reader can act on. What a particular
 * setting means belongs to the module that reads it, not here.
 */

/** What a client must be running to reach a route: `{ "POST /api/reports": { minVersion, feature } }`. */
const CLIENT_MINIMUMS = 'client_minimums';

/**
 * Where these routes are mounted, shared with `app.js` so the mount and the exemption cannot drift.
 *
 * The minimum gate never applies here, whatever the map says. A minimum over this path would refuse the
 * one request that can lower it, leaving a mistake that no client could undo and only a hand-edited
 * database could clear.
 */
const SETTINGS_PATH = '/api/settings';

/** The Patreon creator token pair: `{ accessToken, refreshToken, expiresAt }`. Null until the first refresh. */
const PATREON_CREATOR_TOKENS = 'patreon_creator_tokens';

/** Every setting there is, by key. */
const SETTINGS = {
  [CLIENT_MINIMUMS]: { default: {}, validate: validateClientMinimums },
  // Off until the privacy text that states the collection is live, then the operator's to turn on — and
  // the emergency stop if a flood ever needs one. `config/anonymousLikes` says what it gates.
  [ANONYMOUS_LIKES]: { default: false, validate: validateAnonymousLikes },
  // Written only by `utils/patreon`. Internal, so the staff routes never show or take a token.
  [PATREON_CREATOR_TOKENS]: { default: null, internal: true }
};

/**
 * Whether this server has a setting by that name.
 *
 * @param {*} key - A key from a route parameter
 * @returns {boolean} Whether it is one of ours
 */
const isSetting = (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, key);

/**
 * Whether staff can read and write a setting through the settings routes.
 *
 * @param {*} key - A key from a route parameter
 * @returns {boolean} Whether it is one of ours and not internal
 */
const isStaffSetting = (key) => isSetting(key) && !SETTINGS[key].internal;

/**
 * The value a setting has before anyone writes one. A fresh copy, so a caller cannot edit the default.
 *
 * @param {string} key - A declared setting
 * @returns {*} Its default
 */
const defaultFor = (key) => JSON.parse(JSON.stringify(SETTINGS[key].default));

module.exports = {
  CLIENT_MINIMUMS,
  PATREON_CREATOR_TOKENS,
  SETTINGS_PATH,
  SETTINGS,
  isSetting,
  isStaffSetting,
  defaultFor
};
