import { app, request } from './context.js';

/**
 * SES events as EventBridge posts them to the mail webhook, shaped after the AWS docs examples.
 */

export const SECRET = 'test-ses-events-secret';
export const HEADER = 'X-SES-Events-Secret';
export const RECIPIENT = 'person.private@example.test';

const DETAIL_TYPES = {
  Delivery: 'Email Delivered',
  DeliveryDelay: 'Email Delivery Delayed',
  Bounce: 'Email Bounced',
  Complaint: 'Email Complaint Received',
  Open: 'Email Opened'
};

/** The per-type object of an SES event, as in the docs examples. */
const bodies = {
  Delivery: (at) => ({ delivery: { timestamp: at, processingTimeMillis: 900, recipients: [RECIPIENT], smtpResponse: '250 2.6.0 Message received' } }),
  DeliveryDelay: (at) => ({
    deliveryDelay: {
      timestamp: at, delayType: 'MailboxFull', expirationTime: at,
      delayedRecipients: [{ emailAddress: RECIPIENT, status: '4.2.2', diagnosticCode: `smtp; 452 4.2.2 ${RECIPIENT} mailbox full` }]
    }
  }),
  Bounce: (at, bounceType = 'Permanent', bounceSubType = 'General') => ({
    bounce: {
      bounceType, bounceSubType, timestamp: at, feedbackId: 'fb-1',
      bouncedRecipients: [{ emailAddress: RECIPIENT, action: 'failed', status: '5.1.1', diagnosticCode: `smtp; 550 5.1.1 <${RECIPIENT}> user unknown` }]
    }
  }),
  Complaint: (at) => ({ complaint: { timestamp: at, feedbackId: 'fb-2', complainedRecipients: [{ emailAddress: RECIPIENT }] } }),
  Open: (at) => ({ open: { timestamp: at, userAgent: 'x', ipAddress: '192.0.2.1' } })
};

/** One SES event in the EventBridge envelope; `extra` goes to the type's body, such as a bounce's type. */
export const event = (eventType, mailId, { at = new Date().toISOString(), extra = [] } = {}) => ({
  version: '0',
  id: 'eb-event-1',
  'detail-type': DETAIL_TYPES[eventType],
  source: 'aws.ses',
  account: '123456789012',
  time: at,
  region: 'us-east-2',
  resources: [],
  detail: {
    eventType,
    mail: {
      timestamp: at,
      source: 'Formamorph <account@mail.formamorph.ai>',
      messageId: 'ses-message-1',
      destination: [RECIPIENT],
      headers: [{ name: 'To', value: RECIPIENT }],
      commonHeaders: { to: [RECIPIENT], subject: 'Verify your Formamorph email address' },
      tags: { 'ses:configuration-set': ['formamorph-mail'], ...(mailId ? { mail_id: [mailId] } : {}), mail_kind: ['verify'] }
    },
    ...bodies[eventType](at, ...extra)
  }
});

/** Post an event to the webhook with the secret header; a null secret sends no header. */
export const post = (payload, secret = SECRET) => {
  const req = request(app).post('/api/mail/events').set('Content-Type', 'application/json; charset=utf-8');
  if (secret !== null) req.set(HEADER, secret);
  return req.send(JSON.stringify(payload));
};
