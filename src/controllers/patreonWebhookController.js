const crypto = require('crypto');
const PatreonLink = require('../models/PatreonLink');
const {
  tierStateOf, patreonWebhookSecret, WEBHOOK_TIER_TRIGGERS, WEBHOOK_ENDING_TRIGGERS
} = require('../config/patreon');
const { memberFrom, tierTitlesFrom, tierPricesFrom } = require('../utils/patreon');
const { storeTierTitles } = require('../utils/tierNames');
const { requestMemberRead } = require('../utils/reconcilePatreon');

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
 * @desc    Take a membership signal from Patreon: an ending clears the tier, and every tier trigger asks for a read
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

    // A delivery that carries tier resources renames those tiers; the other tiers keep their names.
    const titles = tierTitlesFrom(payload);
    try {
      if (Object.keys(titles).length) storeTierTitles(titles, false, tierPricesFrom(payload));
    } catch (error) {
      console.error('Patreon webhook tier name write failed:', error);
    }

    // Patreon sends no delivery id, so a delivery may be stale: only an ending acts on its payload.
    const ended = ending && payload?.data ? memberFrom(payload.data) : null;
    if (ended) {
      PatreonLink.setTier({
        patreonUserId: ended.patreonUserId,
        ...tierStateOf(null),
        checkedAt: new Date().toISOString()
      });
    }

    requestMemberRead();

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
