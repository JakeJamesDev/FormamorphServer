/**
 * The Daily Send: each copy of the app says once per UTC day that it was opened.
 *
 * The server keeps a keyed hash of the Install id, never the id itself. The key belongs to one calendar
 * month, so a hash matches its Install only while that month's key exists.
 *
 * Collection ships switched off. The privacy text has to state it before the first row is stored, so the
 * operator turns it on after the text is live.
 */

const { DAY_MS } = require('./time');

/** The setting that gates collection. */
const ACTIVE_INSTALLS = 'active_installs';

/** One address's budget per window. Carrier NAT puts many real installs behind one IPv4 address. */
const ACTIVE_INSTALLS_WINDOW_MS = DAY_MS;
const ACTIVE_INSTALLS_LIMIT = 100;

/** The admin route's `?days`, as the usage report reads it. */
const REPORT_DAYS_DEFAULT = 14;
const REPORT_DAYS_MAX = 366;

/** A send whose client header names no real version. The Install refusal is `NO_INSTALL`. */
const NO_CLIENT = Object.freeze({
  success: false,
  code: 'client_header_invalid',
  error: 'This request carried no readable client header'
});

/**
 * Whether a stored value is one this switch can act on.
 *
 * @param {*} value - Anything the settings route was handed
 * @returns {string|null} What is wrong with it, or null
 */
const validateActiveInstalls = (value) =>
  typeof value === 'boolean' ? null : 'Active Installs collection must be true or false';

module.exports = {
  ACTIVE_INSTALLS,
  ACTIVE_INSTALLS_WINDOW_MS,
  ACTIVE_INSTALLS_LIMIT,
  REPORT_DAYS_DEFAULT,
  REPORT_DAYS_MAX,
  NO_CLIENT,
  validateActiveInstalls
};
