const { ipKeyGenerator } = require('express-rate-limit');
const { clientAddress } = require('./clientAddress');

// Key the rate limiters on the real client rather than on the tunnel that delivered the request — see
// `clientAddress` for why `req.ip` alone would throttle every user as one bucket. `ipKeyGenerator`
// normalizes IPv6 to a /56 block so one client can't cycle addresses within its prefix to dodge a limit;
// that normalization is a bucketing rule and belongs here rather than in the shared resolver.
const clientIpKeyGenerator = (req) => ipKeyGenerator(clientAddress(req));

module.exports = { clientIpKeyGenerator };
