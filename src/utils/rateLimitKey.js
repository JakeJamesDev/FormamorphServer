const { ipKeyGenerator } = require('express-rate-limit');

// Behind the Cloudflare tunnel, cloudflared connects to this origin from loopback, so `req.ip` is the
// same for every external client — keying the rate limiters on it would throttle all users as one
// bucket (and never throttle a single attacker). Cloudflare sets `CF-Connecting-IP` to the true client
// address; key on that, falling back to `req.ip` for direct/local requests. This is only trustworthy
// because the origin is reachable solely through the tunnel — do not expose it publicly. `ipKeyGenerator`
// normalizes IPv6 to a /56 block so one client can't cycle addresses within its prefix to dodge a limit.
const clientIpKeyGenerator = (req) => {
  const cfIp = req.headers['cf-connecting-ip'];
  const ip = (typeof cfIp === 'string' && cfIp) || req.ip;
  return ipKeyGenerator(ip);
};

module.exports = { clientIpKeyGenerator };
