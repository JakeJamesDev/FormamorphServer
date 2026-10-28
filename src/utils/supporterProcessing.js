/**
 * The per-account step the gated content route runs on a listing's content before it leaves the server.
 * Passes the content through unchanged until the watermark and scramble steps fill it.
 *
 * @param {Object} request - `{ userId, listing, content }`
 * @returns {Promise<Object>} The content this account receives
 */
const processForAccount = async ({ content }) => content;

module.exports = { processForAccount };
