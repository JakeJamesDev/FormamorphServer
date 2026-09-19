/**
 * Read a prompt's model names off a request body.
 *
 * Trimmed, blanks dropped, and de-duplicated case-insensitively keeping the first spelling, as the
 * client's Overview stores them. No count or length cap beyond the body's own size limit.
 *
 * @param {*} value - The body field
 * @returns {{models?: string[], error?: string}} The cleaned names, or why they were refused
 */
const modelList = (value) => {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    return { error: 'models must be an array of model names' };
  }

  const seen = new Set();
  const models = [];
  for (const name of value.map((raw) => raw.trim())) {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    models.push(name);
  }

  return { models };
};

/**
 * The stored `models` column as a list. A row written by hand could hold text that is not JSON; that
 * reads as no models rather than failing the listing read.
 *
 * @param {string|null} stored - The `models` column
 * @returns {string[]} The model names
 */
const parseModels = (stored) => {
  try {
    const parsed = JSON.parse(stored || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

module.exports = { modelList, parseModels };
