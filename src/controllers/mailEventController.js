const crypto = require('crypto');
const db = require('../config/db');
const MailLog = require('../models/MailLog');
const User = require('../models/User');
const { MAIL_ID_TAG, SES_EVENTS_SECRET_HEADER, sesEventsSecret } = require('../config/mail');

/** The SES event types the server records, with the status each sets and the object holding its time. */
const EVENTS = {
  Delivery: { status: MailLog.STATUSES.DELIVERED, field: 'delivery' },
  DeliveryDelay: { status: MailLog.STATUSES.DELAYED, field: 'deliveryDelay' },
  Bounce: { status: MailLog.STATUSES.BOUNCED, field: 'bounce' },
  Complaint: { status: MailLog.STATUSES.COMPLAINED, field: 'complaint' }
};

/**
 * Whether the given secret equals the configured one, compared in constant time.
 *
 * Both sides are hashed first, so the comparison never depends on the length of what was sent.
 *
 * @param {*} given - The header value
 * @param {string} secret - The configured secret
 * @returns {boolean} Whether they match
 */
const secretMatches = (given, secret) => {
  if (typeof given !== 'string') return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();

  return crypto.timingSafeEqual(digest(given), digest(secret));
};

/** The first value of a tag in an SES event's `mail.tags`, which maps each name to a list. */
const tagValue = (mail, name) => {
  const values = mail?.tags?.[name];
  const value = Array.isArray(values) ? values[0] : undefined;
  return typeof value === 'string' ? value : null;
};

/** An event's own time as an ISO instant, or now when it carries none that parses. */
const instantOf = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isNaN(time) ? Date.now() : time).toISOString();
};

/** SES's bounce type as the log's: only a permanent bounce is hard. */
const bounceTypeOf = (bounce) => (bounce?.bounceType === 'Permanent' ? 'hard' : 'soft');

/** The marker a row's new status sets on its account's address, or null. A soft bounce sets none. */
const markerOf = (row) => {
  if (row.status === MailLog.STATUSES.COMPLAINED) return User.EMAIL_MARKERS.COMPLAINT;
  if (row.status === MailLog.STATUSES.BOUNCED && row.bounce_type === 'hard') return User.EMAIL_MARKERS.BOUNCE;
  return null;
};

/** Move the row, and mark its account's address when the move is a hard bounce or a complaint. */
const recordEvent = db.transaction((event) => {
  const { row, moved } = MailLog.applyEvent(event);
  const marker = moved && row.user_id ? markerOf(row) : null;
  if (marker) User.markEmail(row.user_id, marker, row.sent_at);
});

/**
 * @desc    Take one SES event from EventBridge and move its mail's status
 * @route   POST /api/mail/events
 * @access  Public; the shared secret header is the authentication
 */
exports.mailEvent = (req, res, next) => {
  try {
    // An empty secret would let anyone forge a bounce, so no secret refuses every event.
    const secret = sesEventsSecret();
    if (!secret) return res.status(503).json({ success: false, error: 'Mail events are not set up on this server' });

    if (!secretMatches(req.get(SES_EVENTS_SECRET_HEADER), secret)) {
      return res.status(401).json({ success: false, error: 'Bad mail event secret' });
    }

    // Parsed here, and never logged: the event holds the recipient address.
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    } catch {
      return res.status(400).json({ success: false, error: 'Mail event body is not JSON' });
    }

    // EventBridge wraps the SES event in `detail`; an input transformer may send it bare.
    const event = payload?.detail ?? payload;
    const type = EVENTS[event?.eventType];
    const id = type ? tagValue(event.mail, MAIL_ID_TAG) : null;

    if (id) {
      const details = event[type.field];
      recordEvent({
        id,
        status: type.status,
        bounceType: type.status === MailLog.STATUSES.BOUNCED ? bounceTypeOf(details) : null,
        at: instantOf(details?.timestamp)
      });
    }

    // Any other type, or a mail we have no row for, is accepted so EventBridge does not retry it.
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
