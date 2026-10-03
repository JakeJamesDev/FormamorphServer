const crypto = require('crypto');
const PatreonLink = require('../models/PatreonLink');
const {
  tierStateOf, patreonWebhookSecret, WEBHOOK_TIER_TRIGGERS, WEBHOOK_ENDING_TRIGGERS
} = require('../config/patreon');
const { memberFrom } = require('../utils/patreon');

/**
 * Whether `signature` is the hex HMAC-MD5 of `body` under `secret`, compared in constant time.
 *
 * @param {Buffer} body - The bytes Patreon sent
 * @param {*} signature - The `X-Patreon-Signature` value
 * @param {string} secret - The webhook secret
 * @returns {boolean} Whether Patreon signed this body
 */
const signatureMatches = (body, signature, secret) => {
  if (typeof signature !== 'string') return false;

  const expected = Buffer.from(crypto.createHmac('md5', secret).update(body).digest('hex'));
  const given = Buffer.from(signature);

  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/**
 * @desc    Apply a membership change Patreon sends to the account that links the member
 * @route   POST /api/patreon/webhook
 * @access  Public; the body's signature is the authentication
 */
exports.patreonWebhook = (req, res, next) => {
  try {
    // An empty key would let anyone sign, so no secret refuses every delivery.
    const secret = patreonWebhookSecret();
    if (!secret) {
      return res.status(503).json({ success: false, error: 'Patreon webhooks are not set up on this server' });
    }

    // A body an earlier parser consumed is no longer the bytes Patreon signed.
    if (!Buffer.isBuffer(req.body) || !signatureMatches(req.body, req.get('X-Patreon-Signature'), secret)) {
      return res.status(401).json({ success: false, error: 'Bad webhook signature' });
    }

    const event = req.get('X-Patreon-Event');
    const ending = WEBHOOK_ENDING_TRIGGERS.has(event);
    if (!ending && !WEBHOOK_TIER_TRIGGERS.has(event)) return res.status(200).json({ success: true });

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, error: 'Webhook body is not JSON' });
    }

    const member = payload?.data ? memberFrom(payload.data) : null;
    if (member) {
      PatreonLink.setTier({
        patreonUserId: member.patreonUserId,
        ...tierStateOf(ending ? null : member),
        checkedAt: new Date().toISOString()
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
