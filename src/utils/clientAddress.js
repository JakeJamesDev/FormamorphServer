/**
 * Who a request came from, as far as this origin can tell.
 *
 * Behind the Cloudflare tunnel, cloudflared connects to this origin from loopback, so `req.ip` is the same
 * for every external client. Cloudflare sets `CF-Connecting-IP` to the true client address; that is the
 * answer, falling back to `req.ip` for direct and local requests.
 *
 * This is only trustworthy because the origin is reachable solely through the tunnel — the firewall
 * restricts the HTTPS port to Cloudflare's published ranges, so the header cannot be forged by reaching the
 * origin directly. Do not expose the origin publicly.
 *
 * One resolver for both consumers that need it, so the proxy and Cloudflare are handled once: the rate
 * limiters key on it, and a Signal hashes it.
 *
 * @param {Object} req - The Express request
 * @returns {string} The client address, or an empty string when there is none
 */
const clientAddress = (req) => {
  const forwarded = req.headers['cf-connecting-ip'];
  return (typeof forwarded === 'string' && forwarded) || req.ip || '';
};

module.exports = { clientAddress };
