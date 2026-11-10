import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const { setMailTransport, resetMailTransport, captureTransport, sesTransport } = require('../src/utils/mail');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../src/utils/accountMail');
const { alertAdmins } = require('../src/utils/hostedAlerts');
const { sweepRetention } = require('../src/utils/sweepRetention');
const { eraseUser } = require('../src/utils/eraseUser');
const { DAY_MS } = require('../src/config/time');

/**
 * The mail log and the SES event webhook.
 *
 * Mail goes out through the real `sendMail` onto the capture transport; its tags are read back the way
 * SES would echo them. Events are posted as EventBridge delivers them, shaped after the AWS docs examples.
 */

const SECRET = 'test-ses-events-secret';
const HEADER = 'X-SES-Events-Secret';
const RECIPIENT = 'person.private@example.test';

let mail;

beforeEach(() => {
  mail = captureTransport();
  setMailTransport(mail);
  vi.stubEnv('SES_EVENTS_SECRET', SECRET);
});

afterEach(() => {
  resetMailTransport();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.exec('DELETE FROM mail_log');
});

const row = (id) => db.prepare('SELECT * FROM mail_log WHERE id = ?').get(id);
const rowCount = () => db.prepare('SELECT COUNT(*) AS count FROM mail_log').get().count;

let accounts = 0;
/** A new account's address; each must be unique. */
const nextAddress = () => `account-${(accounts += 1)}@example.test`;

/** Send one verification mail to a new account; returns the mail-log id from its tag. */
const sendOne = async (email = nextAddress()) => {
  const user = createUser({ email });
  await sendVerificationEmail({ userId: user.id, email });
  return { user, id: mail.messages.at(-1).tags.mail_id };
};

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

/** One SES event in the EventBridge envelope. */
const event = (eventType, mailId, { at = new Date().toISOString(), extra = [] } = {}) => ({
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

const post = (payload, secret = SECRET) => {
  const req = request(app).post('/api/mail/events').set('Content-Type', 'application/json; charset=utf-8');
  if (secret !== null) req.set(HEADER, secret);
  return req.send(JSON.stringify(payload));
};

describe('the mail log', () => {
  it('writes one row per accepted mail with the account, kind and message id', async () => {
    const { user, id } = await sendOne();

    expect(row(id)).toMatchObject({ user_id: user.id, kind: 'verify', message_id: 'captured-1', status: 'sent', bounce_type: null });
  });

  it('logs the mail the register route sends against the new account', async () => {
    const response = await fromItsOwnAddress(request(app).post('/api/auth/register').send({
      username: 'log-register', password: 'password123', email: 'log-register@example.test'
    }));

    expect(response.status).toBe(201);
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get('log-register');
    expect(row(mail.messages[0].tags.mail_id)).toMatchObject({ user_id: user.id, kind: 'verify' });
  });

  it('logs a reset mail as reset', async () => {
    const email = nextAddress();
    const user = createUser({ email });
    await sendPasswordResetEmail({ userId: user.id, email });

    expect(row(mail.messages[0].tags.mail_id)).toMatchObject({ user_id: user.id, kind: 'reset' });
  });

  it('logs a staff alert with no account', async () => {
    vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');

    await alertAdmins({ subject: 'Paused', body: 'Paused.' });

    expect(row(mail.messages[0].tags.mail_id)).toMatchObject({ user_id: null, kind: 'alert' });
  });

  it('tags each mail with its row id and kind, in characters SES allows', async () => {
    const { id } = await sendOne();

    const { tags } = mail.messages[0];
    expect(tags).toEqual({ mail_id: id, mail_kind: 'verify' });
    for (const [name, value] of Object.entries(tags)) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('hands the tags to SES and keeps the message id SES returns', async () => {
    const inputs = [];
    setMailTransport(sesTransport({ sendEmail: async (input) => { inputs.push(input); return { MessageId: 'ses-42' }; } }, 'set'));
    const email = nextAddress();
    const user = createUser({ email });

    await sendVerificationEmail({ userId: user.id, email });

    const id = inputs[0].EmailTags.find((tag) => tag.Name === 'mail_id').Value;
    expect(inputs[0].EmailTags).toContainEqual({ Name: 'mail_kind', Value: 'verify' });
    expect(row(id).message_id).toBe('ses-42');
  });

  it('writes no row when the send is refused', async () => {
    setMailTransport({ send: () => Promise.reject(new Error('SES is down')) });
    const email = nextAddress();
    const user = createUser({ email });

    await expect(sendVerificationEmail({ userId: user.id, email })).rejects.toThrow('SES is down');

    expect(rowCount()).toBe(0);
  });

  it('refuses a mail with no known kind and sends nothing', async () => {
    const { sendMail } = require('../src/utils/mail');

    await expect(sendMail({ to: RECIPIENT, subject: 's', text: 't', userId: null, kind: 'news' })).rejects.toThrow(/kind/);

    expect(mail.messages).toHaveLength(0);
  });
});

describe('the SES event webhook secret', () => {
  it('refuses an event with no secret', async () => {
    const { id } = await sendOne();

    const response = await post(event('Bounce', id), null);

    expect(response.status).toBe(401);
    expect(row(id).status).toBe('sent');
  });

  it('refuses an event with a wrong secret', async () => {
    const { id } = await sendOne();

    const response = await post(event('Bounce', id), `${SECRET}x`);

    expect(response.status).toBe(401);
    expect(row(id).status).toBe('sent');
  });

  it('answers unavailable when the server has no secret', async () => {
    const { id } = await sendOne();
    vi.stubEnv('SES_EVENTS_SECRET', '');

    const response = await post(event('Bounce', id), '');

    expect(response.status).toBe(503);
    expect(row(id).status).toBe('sent');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await request(app).post('/api/mail/events').set(HEADER, SECRET).set('Content-Type', 'application/json').send('{not json');

    expect(response.status).toBe(400);
  });
});

describe('SES events move the status', () => {
  it.each([
    ['Delivery', 'delivered'],
    ['DeliveryDelay', 'delayed'],
    ['Complaint', 'complained']
  ])('%s sets %s', async (type, status) => {
    const { id } = await sendOne();
    const at = '2026-11-09T12:00:05.000Z';

    const response = await post(event(type, id, { at }));

    expect(response.status).toBe(200);
    expect(row(id)).toMatchObject({ status, bounce_type: null, status_at: at });
  });

  it.each([
    ['Permanent', 'General', 'hard'],
    ['Permanent', 'OnAccountSuppressionList', 'hard'],
    ['Transient', 'MailboxFull', 'soft'],
    ['Undetermined', 'Undetermined', 'soft']
  ])('a %s/%s bounce sets bounced, %s', async (bounceType, subType, expected) => {
    const { id } = await sendOne();

    await post(event('Bounce', id, { extra: [bounceType, subType] }));

    expect(row(id)).toMatchObject({ status: 'bounced', bounce_type: expected });
  });

  it('moves a delayed mail on to delivered', async () => {
    const { id } = await sendOne();

    await post(event('DeliveryDelay', id));
    await post(event('Delivery', id));

    expect(row(id).status).toBe('delivered');
  });

  it('keeps a delivery when a delay arrives after it', async () => {
    const { id } = await sendOne();
    await post(event('Delivery', id, { at: '2026-11-09T12:00:05.000Z' }));
    const before = row(id);

    await post(event('DeliveryDelay', id, { at: '2026-11-09T12:00:01.000Z' }));

    expect(row(id)).toEqual(before);
  });

  it('keeps a bounce when a delivery arrives after it', async () => {
    const { id } = await sendOne();
    await post(event('Bounce', id));
    const before = row(id);

    await post(event('Delivery', id));

    expect(row(id)).toEqual(before);
  });

  it('keeps a complaint when a bounce arrives after it', async () => {
    const { id } = await sendOne();
    await post(event('Complaint', id));
    const before = row(id);

    await post(event('Bounce', id));

    expect(row(id)).toEqual(before);
  });

  it('records a hard bounce that follows a delivery', async () => {
    const { id } = await sendOne();
    await post(event('Delivery', id));

    await post(event('Bounce', id));

    expect(row(id)).toMatchObject({ status: 'bounced', bounce_type: 'hard' });
  });

  it('records a complaint that follows a delivery', async () => {
    const { id } = await sendOne();
    await post(event('Delivery', id));

    await post(event('Complaint', id));

    expect(row(id).status).toBe('complained');
  });

  it('leaves one unchanged row when the same event arrives twice', async () => {
    const { id } = await sendOne();
    const repeated = event('DeliveryDelay', id, { at: '2026-11-09T12:00:01.000Z' });
    await post(repeated);
    const before = row(id);

    const response = await post(repeated);

    expect(response.status).toBe(200);
    expect(rowCount()).toBe(1);
    expect(row(id)).toEqual(before);
  });

  it('accepts and ignores an event for a mail it has no row for', async () => {
    const { id } = await sendOne();
    const before = row(id);

    const unknown = await post(event('Bounce', '00000000-0000-4000-8000-000000000000'));
    const untagged = await post(event('Bounce', null));

    expect(unknown.status).toBe(200);
    expect(untagged.status).toBe(200);
    expect(row(id)).toEqual(before);
    expect(rowCount()).toBe(1);
  });

  it('accepts and ignores an event type it does not record', async () => {
    const { id } = await sendOne();
    const before = row(id);

    const response = await post(event('Open', id));

    expect(response.status).toBe(200);
    expect(row(id)).toEqual(before);
  });
});

describe('the recipient address', () => {
  /** Every text value in every table. */
  const everyStoredText = () => db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .flatMap(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all().flatMap(Object.values))
    .filter((value) => typeof value === 'string');

  it('is stored nowhere and logged nowhere after every kind of event', async () => {
    const { id } = await sendOne(RECIPIENT);
    // The account row holds its address already; no event may write another copy.
    const holdersBefore = everyStoredText().filter((value) => value.includes(RECIPIENT));
    expect(holdersBefore).toEqual([RECIPIENT]);
    const written = [];
    const capture = (...args) => { written.push(args.map(String).join(' ')); };
    for (const method of ['log', 'info', 'warn', 'error']) vi.spyOn(console, method).mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { capture(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { capture(chunk); return true; });

    for (const type of ['DeliveryDelay', 'Delivery', 'Complaint', 'Bounce', 'Open']) await post(event(type, id));
    await post(event('Bounce', 'unknown-id'));
    await post(event('Bounce', id), 'wrong');
    await request(app).post('/api/mail/events').set(HEADER, SECRET).send(`{"broken": "${RECIPIENT}`);

    vi.restoreAllMocks();
    expect(everyStoredText().filter((value) => value.includes(RECIPIENT))).toEqual(holdersBefore);
    expect(written.filter((line) => line.includes(RECIPIENT))).toEqual([]);
  });
});

describe('retention and deletion', () => {
  it('sweeps rows sent more than 90 days ago and keeps newer ones', async () => {
    const { id: old } = await sendOne();
    const { id: recent } = await sendOne();
    const now = Date.now();
    db.prepare('UPDATE mail_log SET sent_at = ? WHERE id = ?').run(new Date(now - 91 * DAY_MS).toISOString(), old);
    db.prepare('UPDATE mail_log SET sent_at = ? WHERE id = ?').run(new Date(now - 89 * DAY_MS).toISOString(), recent);

    const swept = sweepRetention(new Date(now).toISOString());

    expect(swept.mails).toBe(1);
    expect(row(old)).toBeUndefined();
    expect(row(recent)).toBeDefined();
  });

  it('removes an account\'s rows when the account is erased, and keeps staff alerts', async () => {
    const { user, id } = await sendOne();
    vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');
    await alertAdmins({ subject: 'Paused', body: 'Paused.' });
    const alertId = mail.messages.at(-1).tags.mail_id;

    await eraseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));

    expect(row(id)).toBeUndefined();
    expect(row(alertId)).toBeDefined();
  });
});
