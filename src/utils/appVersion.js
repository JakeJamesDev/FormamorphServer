/** A release number with an optional pre-release or build suffix: `2.0.3`, `2.1.0-beta.2`. */
const VERSION_SHAPE = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;
const MAX_LENGTH = 32;

/**
 * The app version stamped on a shared prompt preset, or null when the stamp is absent or not version-shaped.
 *
 * @param {*} contentData - The listing content
 * @returns {string|null} The version
 */
const appVersionOf = (contentData) => {
  if (!contentData || typeof contentData !== 'object') return null;
  const stamp = contentData.appVersion;
  return typeof stamp === 'string' && stamp.length <= MAX_LENGTH && VERSION_SHAPE.test(stamp) ? stamp : null;
};

module.exports = { appVersionOf };
