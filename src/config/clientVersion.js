/**
 * Which build is asking, and what a route can require of one.
 *
 * Every Formamorph client sends its version and platform in one header, so the server can log what the
 * room is running and refuse a route to a build too old for it. Nothing else in the request says either:
 * a user agent names the browser, not the app.
 *
 * Parsing is deliberately forgiving in one direction only. What cannot be read as a version reads as zero,
 * which is below every minimum, so a build too old to send the header at all is refused exactly like a
 * build too old for the feature. What cannot be read as a platform reads as unknown and changes nothing.
 */

/** The header, lowercase, as Node hands it over in `req.headers`. */
const CLIENT_HEADER = 'x-formamorph-client';

/** The header as it is written when it is set, for the CORS allow-list and for a client to copy. */
const CLIENT_HEADER_NAME = 'X-Formamorph-Client';

/** The platforms a build can be. Anything else is recorded as unknown rather than echoed. */
const PLATFORMS = ['web', 'windows', 'linux', 'mac', 'android'];

/** What a request with no readable build counts as. */
const UNKNOWN_PLATFORM = 'unknown';
const ZERO_VERSION = '0.0.0';

/**
 * A dotted version, optionally with a prerelease suffix. Bounded on both length and part count, because
 * this runs on a string a client chose and the result reaches the log.
 */
const VERSION = /^\d{1,6}(\.\d{1,6}){0,2}(-[0-9A-Za-z][0-9A-Za-z.-]{0,32})?$/;

/**
 * Whether a string is a version this server can compare.
 *
 * @param {*} value - Anything
 * @returns {boolean} Whether it parses
 */
const isVersion = (value) => typeof value === 'string' && VERSION.test(value);

/** The numeric part of a version, padded to three, so `2.17` and `2.17.0` compare as one version. */
const releaseNumbers = (version) => {
  const digits = String(version).split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (digits.length < 3) digits.push(0);

  return digits.slice(0, 3);
};

/** Everything after the first hyphen, or the empty string for a plain release. */
const prerelease = (version) => String(version).split('-').slice(1).join('-');

/**
 * Order two prerelease tags by semver's rule for them.
 *
 * Dot-separated identifiers compared one at a time: two numbers compare as numbers, so `beta.9` sits below
 * `beta.10` where comparing the strings would put it above; a number ranks below a word; and where one tag
 * runs out first, the shorter one is lower. A plain release outranks any prerelease of itself.
 *
 * @param {string} a - A tag, or the empty string for a release
 * @param {string} b - The tag to compare it against
 * @returns {number} -1, 0 or 1
 */
const comparePrerelease = (a, b) => {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;

    const leftIsNumber = /^\d+$/.test(left[i]);
    const rightIsNumber = /^\d+$/.test(right[i]);

    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
    if (leftIsNumber) {
      const difference = Number(left[i]) - Number(right[i]);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }

  return 0;
};

/**
 * Order two versions.
 *
 * Numbers first, then the prerelease rule — otherwise a minimum of `2.17.0` would admit `2.17.0-beta.1`,
 * which is the build the release exists to replace.
 *
 * @param {string} a - A version
 * @param {string} b - The version to compare it against
 * @returns {number} -1, 0 or 1
 */
const compareVersions = (a, b) => {
  const left = releaseNumbers(a);
  const right = releaseNumbers(b);

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }

  return comparePrerelease(prerelease(a), prerelease(b));
};

/**
 * Read the header into the build it names.
 *
 * The two fields are read apart. A header that is not a version and a platform separated by one space
 * yields both defaults; a header whose platform is one this server has not heard of keeps its version,
 * so a platform added later is not gated out of everything until this list learns the word.
 *
 * @param {*} value - The raw header, or undefined when the client sent none
 * @returns {{ version: string, platform: string }} The build, never null
 */
const parseClientHeader = (value) => {
  const match = typeof value === 'string' ? /^(\S{1,64})[ \t]+(\S{1,32})$/.exec(value.trim()) : null;
  if (!match) return { version: ZERO_VERSION, platform: UNKNOWN_PLATFORM };

  const [, version, platform] = match;

  return {
    version: isVersion(version) ? version : ZERO_VERSION,
    platform: PLATFORMS.includes(platform.toLowerCase()) ? platform.toLowerCase() : UNKNOWN_PLATFORM
  };
};

/** A route key: a method, one space, and a path. The path gates itself and everything under it. */
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9\-._~/]*$/;

/** Enough for every feature area this server has, and small enough to walk on every request. */
const MAX_ROUTES = 50;

/** Long enough to name a feature, short enough that a dialog can show it whole. */
const FEATURE_MAX = 80;

/**
 * Why a map of route to minimum cannot be stored, or null when it can.
 *
 * The map is read on every request and its feature name is shown to a player, so the shape is checked
 * once here rather than defended at both of those places.
 *
 * @param {*} value - What staff sent
 * @returns {string|null} The refusal to show them, or null
 */
const validateClientMinimums = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Minimums must be an object keyed by route';
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ROUTES) return `At most ${MAX_ROUTES} routes may carry a minimum`;

  for (const [key, entry] of entries) {
    if (!ROUTE_KEY.test(key)) {
      return `"${key}" is not a route: write a method, a space and a path, as in "POST /api/reports"`;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `"${key}" needs a minVersion and a feature`;
    }
    if (!isVersion(entry.minVersion)) return `"${key}" needs a version, as in "2.17.0"`;
    if (typeof entry.feature !== 'string' || !entry.feature.trim()) {
      return `"${key}" needs the name of the feature to show the player`;
    }
    if (entry.feature.length > FEATURE_MAX) {
      return `"${key}" names a feature longer than ${FEATURE_MAX} characters`;
    }
  }

  return null;
};

module.exports = {
  CLIENT_HEADER,
  CLIENT_HEADER_NAME,
  PLATFORMS,
  isVersion,
  compareVersions,
  parseClientHeader,
  validateClientMinimums
};
