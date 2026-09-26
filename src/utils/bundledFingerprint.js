const crypto = require('crypto');
const fs = require('fs');
const { BUNDLED_FINGERPRINTS_PATH } = require('../config/paths');

/**
 * The bundled fingerprint: a hash of a world's authored text that survives migration.
 *
 * The client repo computes the same value in `src/lib/bundledFingerprint.ts`. Both copies must return the
 * hash in `tests/fixtures/bundled-fingerprint-vector.json`. Change the rule in both repos at the same time.
 */

/** Shorter strings are names, ids, and enum values. They do not make a world someone's own. */
const MIN_TEXT_LENGTH = 40;

/** Stat code sits under this key, and migration rewrites it. */
const SKIPPED_KEY = 'code';

function collectTexts(value, out) {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length >= MIN_TEXT_LENGTH) out.add(text);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key !== SKIPPED_KEY) collectTexts(item, out);
    }
  }
}

/**
 * Hash bytes as lowercase hex SHA-256. The fingerprint list stores Avatar files in this form.
 *
 * @param {Buffer|string} bytes - The bytes to hash; a string is hashed as UTF-8
 * @returns {string}
 */
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Fingerprint a world's content. Every string value is whitespace-collapsed and trimmed. Values under a `code`
 * key are skipped. The strings of 40 or more UTF-16 code units are deduplicated, sorted by code unit, joined
 * with newlines, and hashed with {@link sha256Hex}.
 *
 * @param {*} content - A world, raw from its file or as its publish payload carries it
 * @returns {string}
 */
function worldFingerprint(content) {
  const texts = new Set();
  collectTexts(content, texts);
  return sha256Hex([...texts].sort().join('\n'));
}

/**
 * Read a fingerprint list, `{"worlds": [hex], "avatars": [hex]}`, into two sets.
 *
 * @param {string} file - Path to the list
 * @returns {{worlds: Set<string>, avatars: Set<string>}}
 */
function loadBundledFingerprints(file) {
  const { worlds, avatars } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { worlds: new Set(worlds), avatars: new Set(avatars) };
}

// Read once at start. A release copies a new list in from the client repo and redeploys.
const BUNDLED = loadBundledFingerprints(BUNDLED_FINGERPRINTS_PATH);

/**
 * Whether a world's content is a bundled world, unedited.
 *
 * @param {*} content - The world's content
 * @returns {boolean}
 */
const isBundledWorld = (content) => BUNDLED.worlds.has(worldFingerprint(content));

/** The refusal body for a publish or update that carries a bundled world. */
const BUNDLED_WORLD_ERROR = 'This is a bundled world. Edit it to make it your own, then publish.';

/**
 * Whether a VRM file is a default Avatar some build shipped.
 *
 * @param {Buffer} bytes - The decoded VRM file
 * @returns {boolean}
 */
const isDefaultAvatar = (bytes) => BUNDLED.avatars.has(sha256Hex(bytes));

/** The refusal body for a publish or update that carries a default Avatar. */
const DEFAULT_AVATAR_ERROR = 'This is the default avatar. Upload your own VRM.';

module.exports = {
  sha256Hex,
  worldFingerprint,
  loadBundledFingerprints,
  isBundledWorld,
  BUNDLED_WORLD_ERROR,
  isDefaultAvatar,
  DEFAULT_AVATAR_ERROR,
};
