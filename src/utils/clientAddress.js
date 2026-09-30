/**
 * Who a request came from, as far as this origin can tell.
 *
 * Caddy reaches this origin from loopback and sets `X-Forwarded-For` to the address it saw, and
 * `trust proxy` trusts only loopback, so `req.ip` is the real client. A client-sent header such as
 * `CF-Connecting-IP` is never read: the origin is public, so any client could forge it.
 *
 * One resolver for both consumers that need it: the rate limiters key on it, and a Signal hashes it.
 *
 * @param {Object} req - The Express request
 * @returns {string} The client address, or an empty string when there is none
 */
const clientAddress = (req) => req.ip || '';

module.exports = { clientAddress };
