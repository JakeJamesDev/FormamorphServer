const { decodedImageBytes } = require('./decodedImageBytes');

/**
 * The kind's content ceiling as an error string, or null when it fits.
 *
 * Shared by create and update so the cap is a property of the row rather than of whichever path wrote it:
 * enforcing it on create alone means a 1KB dictionary can be PUT up to the global 100MB a moment later.
 *
 * @param {*} contentData - Parsed listing content
 * @param {Object} rules - The kind's rules
 * @returns {string|null} The refusal, or null
 */
function contentSizeError(contentData, rules) {
  if (!contentData) return null;
  const limitMb = Math.round(rules.maxContentBytes / 1024 / 1024);
  if (rules.measuresDecodedImages) {
    const decoded = decodedImageBytes(contentData);
    if (decoded <= rules.maxContentBytes) return null;
    return `${rules.label} content is ${(decoded / 1024 / 1024).toFixed(1)}MB, over the ${limitMb}MB limit`;
  }
  const bytes = Buffer.byteLength(JSON.stringify(contentData));
  if (bytes <= rules.maxContentBytes) return null;
  return `${rules.label} content exceeds the ${limitMb}MB limit`;
}

module.exports = { contentSizeError };
