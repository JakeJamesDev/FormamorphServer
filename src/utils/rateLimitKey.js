const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const { clientAddress } = require('./clientAddress');
const { foldedAddress } = require('./emailAddress');

// Key the rate limiters on the real client rather than on the tunnel that delivered the request — see
// `clientAddress` for why `req.ip` alone would throttle every user as one bucket. `ipKeyGenerator`
// normalizes IPv6 to a /56 block so one client can't cycle addresses within its prefix to dodge a limit;
// that normalization is a bucketing rule and belongs here rather than in the shared resolver.
const clientIpKeyGenerator = (req) => ipKeyGenerator(clientAddress(req));

// Bucket a reset request by the name it typed, whichever kind of name that is. Folding the case is what
// puts two spellings of one address in one bucket; it also puts two usernames differing only in case
// there, which costs the rarer of the two nothing it can notice at a few requests an hour. The key is a
// hash, so the limiter's memory holds no readable addresses.
const resetAccountKeyGenerator = (req) =>
  `reset:${crypto.createHash('sha256').update(foldedAddress(req.body && req.body.account) || '').digest('hex')}`;

module.exports = { clientIpKeyGenerator, resetAccountKeyGenerator };
