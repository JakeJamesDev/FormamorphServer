const Setting = require('../models/Setting');
const { PATREON_TIER_NAMES } = require('../config/settings');
const { TIER_KEYS, tierKeyOf } = require('../config/patreon');
const { listTierTitles } = require('./patreon');

/**
 * The Patreon title of each tier, kept by tier key.
 *
 * Patreon is the only source. Requests read the stored names and never call Patreon. An unknown or empty
 * title is null, and the client shows its own fallback for it.
 */

/** The longest title kept. */
const MAX_TITLE_LENGTH = 100;

/**
 * A title as stored.
 *
 * @param {*} raw - A title from Patreon
 * @returns {string|null} The trimmed title, or null when it is not text or is empty
 */
const cleanTitle = (raw) => {
  if (typeof raw !== 'string') return null;
  const title = raw.trim().slice(0, MAX_TITLE_LENGTH);

  return title || null;
};

/** @returns {Object<string, string|null>} The stored name of every tier key */
const tierNames = () => {
  const stored = Setting.get(PATREON_TIER_NAMES) || {};

  return Object.fromEntries(TIER_KEYS.map((key) => [key, cleanTitle(stored[key])]));
};

/**
 * Store the titles a Patreon reply gave. Only mapped tier IDs count.
 *
 * @param {Object<string, string>} titlesById - Patreon tier ID to title
 * @param {boolean} complete - Whether the reply lists every tier; a tier it omits then loses its name
 */
const storeTierTitles = (titlesById, complete) => {
  const next = complete ? Object.fromEntries(TIER_KEYS.map((key) => [key, null])) : tierNames();

  for (const [id, title] of Object.entries(titlesById)) {
    const key = tierKeyOf(id);
    if (key) next[key] = cleanTitle(title);
  }

  Setting.set(PATREON_TIER_NAMES, next);
};

/**
 * Read the titles from Patreon and store them. A failed call keeps the stored names.
 *
 * Never throws.
 *
 * @returns {Promise<boolean>} Whether the names were refreshed
 */
const refreshTierNames = async () => {
  try {
    const { via, titles } = await listTierTitles();
    // Only the campaign call lists tiers with no members, so only its answer is complete.
    storeTierTitles(titles, via === 'campaign');
    console.log(`Patreon tier names refreshed via ${via}`);

    return true;
  } catch (error) {
    console.error('Patreon tier name refresh failed:', error);
    return false;
  }
};

module.exports = { tierNames, storeTierTitles, refreshTierNames };
