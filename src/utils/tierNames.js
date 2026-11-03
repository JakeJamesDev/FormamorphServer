const Setting = require('../models/Setting');
const { PATREON_TIER_NAMES, PATREON_TIER_PRICES } =require('../config/settings');
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
 * A price as stored.
 *
 * @param {*} raw - An amount from Patreon
 * @returns {number|null} The price in cents, or null when it is not a whole non-negative number
 */
const cleanPrice = (raw) => (Number.isInteger(raw) && raw >= 0 ? raw : null);

/** @returns {Object<string, number|null>} The stored price in cents of every tier key */
const tierPrices = () => {
  const stored = Setting.get(PATREON_TIER_PRICES) || {};

  return Object.fromEntries(TIER_KEYS.map((key) => [key, cleanPrice(stored[key])]));
};

/**
 * Store the titles and prices a Patreon reply gave. Only mapped tier IDs count.
 *
 * @param {Object<string, string>} titlesById - Patreon tier ID to title
 * @param {boolean} complete - Whether the reply lists every tier; a tier it omits then loses its name and price
 * @param {Object<string, number>} [pricesById] - Patreon tier ID to price in cents
 */
const storeTierTitles = (titlesById, complete, pricesById = {}) => {
  const blank = () => Object.fromEntries(TIER_KEYS.map((key) => [key, null]));
  const names = complete ? blank() : tierNames();
  const prices = complete ? blank() : tierPrices();

  for (const [id, title] of Object.entries(titlesById)) {
    const key = tierKeyOf(id);
    if (key) names[key] = cleanTitle(title);
  }
  for (const [id, amount] of Object.entries(pricesById)) {
    const key = tierKeyOf(id);
    if (key) prices[key] = cleanPrice(amount);
  }

  Setting.set(PATREON_TIER_NAMES, names);
  Setting.set(PATREON_TIER_PRICES, prices);
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
    const { via, titles, prices } = await listTierTitles();
    // Only the campaign call lists tiers with no members, so only its answer is complete.
    storeTierTitles(titles, via === 'campaign', prices);
    console.log(`Patreon tier names refreshed via ${via}`);

    return true;
  } catch (error) {
    console.error('Patreon tier name refresh failed:', error);
    return false;
  }
};

module.exports = { tierNames, tierPrices, storeTierTitles, refreshTierNames };
