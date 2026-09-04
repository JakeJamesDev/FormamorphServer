const { validateClientMinimums } = require('./clientVersion');

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

/** Every setting there is, by key. */
const SETTINGS = {
  [CLIENT_MINIMUMS]: { default: {}, validate: validateClientMinimums }
};

/**
 * Whether this server has a setting by that name.
 *
 * @param {*} key - A key from a route parameter
 * @returns {boolean} Whether it is one of ours
 */
const isSetting = (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, key);

/**
 * The value a setting has before anyone writes one. A fresh copy, so a caller cannot edit the default.
 *
 * @param {string} key - A declared setting
 * @returns {*} Its default
 */
const defaultFor = (key) => JSON.parse(JSON.stringify(SETTINGS[key].default));

module.exports = {
  CLIENT_MINIMUMS,
  SETTINGS_PATH,
  SETTINGS,
  isSetting,
  defaultFor
};
