const { CLIENT_HEADER, parseClientHeader, compareVersions } = require('../config/clientVersion');
const { CLIENT_MINIMUMS, SETTINGS_PATH } = require('../config/settings');
const Setting = require('../models/Setting');

/**
 * Read the build every request carries, and refuse a route to one too old for it.
 *
 * Two middlewares because they serve two purposes at two points: the build is read before the logger, so
 * every line records it including the ones that go on to be refused; the gate runs after, so a refusal is
 * logged like any other answer.
 */

/** A path with no trailing slash, so `/api/reports` and `/api/reports/` are the one route. */
const trimPath = (path) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

/**
 * Whether one path is another or sits under it.
 *
 * The separator is what makes this a path test rather than a string one: without it `/api/reports` would
 * also cover `/api/reportsomething`, which is a different route entirely.
 *
 * @param {string} prefix - A trimmed path
 * @param {string} path - The trimmed request path
 * @returns {boolean} Whether the prefix covers it
 */
const covers = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The method a key must name to cover this request.
 *
 * Express answers HEAD from the GET handler, so a HEAD is a GET as far as which route runs. Left apart,
 * a minimum on `GET /api/worlds` would be walked straight past by asking for it with HEAD.
 *
 * @param {string} method - The request method
 * @returns {string} The method to match keys against
 */
const keyMethod = (method) => (method === 'HEAD' ? 'GET' : method);

/**
 * Attach the calling build to the request.
 *
 * @param {Object} req - Express request object
 * @param {Object} _res - Express response object
 * @param {Function} next - Express next function
 */
exports.readClient = (req, _res, next) => {
  req.client = parseClientHeader(req.headers[CLIENT_HEADER]);

  next();
};

/**
 * The minimum that applies to one request, or null when none does.
 *
 * A key covers its own path and everything under it, so one entry gates a feature rather than each of its
 * endpoints. Where two keys both cover a path the longer one wins, which is how a minimum on one endpoint
 * can sit under a lower minimum on the area around it.
 *
 * @param {Object} minimums - The stored map
 * @param {string} method - The request method
 * @param {string} path - The request path, without its query
 * @returns {Object|null} `{ minVersion, feature }`, or null
 */
const minimumFor = (minimums, method, path) => {
  let best = null;

  for (const [key, entry] of Object.entries(minimums)) {
    const space = key.indexOf(' ');
    if (space < 0) continue;
    if (key.slice(0, space) !== method) continue;

    const keyPath = trimPath(key.slice(space + 1));
    if (!covers(keyPath, path)) continue;

    if (!best || keyPath.length > best.length) best = { length: keyPath.length, entry };
  }

  return best ? best.entry : null;
};

/**
 * Refuse a build below the minimum its route carries.
 *
 * `code` is what every client keys off to open the one update dialog; `error` is what an older client
 * shows verbatim, so it reads as an instruction rather than a bare refusal. A route with no entry is
 * untouched, which is every route until staff write one.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.requireClientVersion = (req, res, next) => {
  const path = trimPath(req.path);

  // The lever is never behind the gate: a minimum over the settings routes would refuse the one request
  // that can lower it, and no client could undo the mistake.
  if (covers(SETTINGS_PATH, path)) return next();

  const minimums = Setting.get(CLIENT_MINIMUMS);
  if (!minimums || typeof minimums !== 'object') return next();

  const minimum = minimumFor(minimums, keyMethod(req.method), path);
  if (!minimum) return next();

  if (compareVersions(req.client.version, minimum.minVersion) >= 0) return next();

  return res.status(426).json({
    success: false,
    code: 'CLIENT_UPDATE_REQUIRED',
    minVersion: minimum.minVersion,
    feature: minimum.feature,
    error: `${minimum.feature} needs Formamorph ${minimum.minVersion} or newer.`
  });
};
