const DATA_URL_BASE64 = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Decoded bytes of every base64 image data URL in a JSON value, at any depth.
 *
 * Text outside data URLs is not counted. Padding is subtracted so the total matches what the decoder
 * produces.
 *
 * @param {*} value - Parsed JSON content
 * @returns {number} The decoded image bytes
 */
function decodedImageBytes(value) {
  if (typeof value === 'string') {
    const head = DATA_URL_BASE64.exec(value);
    if (!head) return 0;
    const payload = value.slice(head[0].length);
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + decodedImageBytes(item), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + decodedImageBytes(item), 0);
  }
  return 0;
}

module.exports = { decodedImageBytes };
