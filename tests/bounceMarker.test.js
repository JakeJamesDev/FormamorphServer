import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { authHeader, fromItsOwnAddress } from './helpers.js';
import { SECRET, event, post } from './sesEvents.js';

const require = createRequire(import.meta.url);
const { setMailTransport, resetMailTransport, captureTransport } = require('../src/utils/mail');
const { alertAdmins } = require('../src/utils/hostedAlerts');

/**
 * The bounce marker: a hard bounce or a complaint marks the account's current address, removes its
 * verification and stops account mail to it until the address changes.
 *
 * Accounts come from the register route, so the address carries the time it was set the way a real one does.
 */

let mail;

beforeEach(() => {
  mail = captureTransport();
  setMailTransport(mail);
  vi.stubEnv('SES_EVENTS_SECRET', SECRET);
});

afterEach(() => {
  resetMailTransport();
  vi.unstubAllEnvs();
  db.exec('DELETE FROM mail_log');
  db.exec('DELETE FROM account_tokens');
});

let named = 0;

/** A new account with an address, made through the register route; returns it with its first mail's id. */
const registered = async () => {
  const username = `bounce-${(named += 1)}`;
  const email = `${username}@example.test`;
  const response = await fromItsOwnAddress(request(app).post('/api/auth/register')
    .send({ username, password: 'password123', email }));
  expect(response.status).toBe(201);

  return { id: response.body.user.id, username, email, password: 'password123', mailId: lastMailId() };
};

const lastMailId = () => mail.messages.at(-1).tags.mail_id;
const lastToken = () => /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail.messages.at(-1).text)[1];

const verify = (token) => fromItsOwnAddress(request(app).post('/api/auth/verify-email').send({ token }));
const me = (user) => request(app).get('/api/auth/me').set(authHeader(user));
const setEmail = (user, email) => fromItsOwnAddress(request(app).post('/api/auth/email').set(authHeader(user)).send({ email }));
const resend = (user) => fromItsOwnAddress(request(app).post('/api/auth/resend-verification').set(authHeader(user)));
const requestReset = (account) => fromItsOwnAddress(request(app).post('/api/auth/request-password-reset').send({ account }));
const login = (user) => fromItsOwnAddress(request(app).post('/api/auth/login').send({ username: user.username, password: user.password }));

/** The account's marker and verification, as its owner reads them. */
const state = async (user) => {
  const { body } = await me(user);
  return { emailMarker: body.user.emailMarker, emailVerified: body.user.emailVerified };
};

/** A registered account that opened its verification link. */
const verifiedAccount = async () => {
  const user = await registered();
  expect((await verify(lastToken())).status).toBe(200);
  return user;
};

const hardBounce = (mailId) => post(event('Bounce', mailId, { extra: ['Permanent', 'General'] }));

/**
 * Wait past the current millisecond. A mail sent in the same millisecond as an address change counts as
 * sent to the new address, so a test about the old one needs the change strictly later.
 */
const nextMillisecond = () => new Promise((resolve) => { setTimeout(resolve, 5); });

describe('what sets the marker', () => {
  it('marks the address on a hard bounce and removes its verification', async () => {
    const user = await verifiedAccount();

    expect((await hardBounce(user.mailId)).status).toBe(200);

    expect(await state(user)).toEqual({ emailMarker: 'bounce', emailVerified: false });
  });

  it('marks the address on a bounce because SES suppresses it', async () => {
    const user = await registered();

    await post(event('Bounce', user.mailId, { extra: ['Permanent', 'OnAccountSuppressionList'] }));

    expect((await state(user)).emailMarker).toBe('bounce');
  });

  it('marks the address on a complaint and removes its verification', async () => {
    const user = await verifiedAccount();

    await post(event('Delivery', user.mailId));
    await post(event('Complaint', user.mailId));

    expect(await state(user)).toEqual({ emailMarker: 'complaint', emailVerified: false });
  });

  it.each([
    ['a delay', (mailId) => event('DeliveryDelay', mailId)],
    ['a soft bounce', (mailId) => event('Bounce', mailId, { extra: ['Transient', 'MailboxFull'] })]
  ])('leaves the address alone on %s', async (_, build) => {
    const user = await verifiedAccount();

    await post(build(user.mailId));

    expect(await state(user)).toEqual({ emailMarker: null, emailVerified: true });
  });

  it('ignores a bounce for a mail sent before the address changed', async () => {
    const user = await registered();
    const oldMailId = user.mailId;
    await nextMillisecond();
    await setEmail(user, `moved-${user.email}`);
    expect((await verify(lastToken())).status).toBe(200);

    await hardBounce(oldMailId);

    expect(await state(user)).toEqual({ emailMarker: null, emailVerified: true });
  });

  it('marks the new address on a bounce for a mail sent to it', async () => {
    const user = await registered();
    await nextMillisecond();
    await setEmail(user, `moved-${user.email}`);

    await hardBounce(lastMailId());

    expect((await state(user)).emailMarker).toBe('bounce');
  });

  it('marks nothing on a bounce for a staff alert', async () => {
    vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');
    const user = await registered();
    await alertAdmins({ subject: 'Paused', body: 'Paused.' });
    const alertId = lastMailId();
    const marked = () => db.prepare('SELECT COUNT(*) AS count FROM users WHERE email_marker IS NOT NULL').get().count;
    const before = marked();

    expect((await hardBounce(alertId)).status).toBe(200);

    expect(marked()).toBe(before);
    expect((await state(user)).emailMarker).toBeNull();
  });

  it('keeps the first reason when a complaint follows a bounce on another mail', async () => {
    const user = await registered();
    await resend(user);
    const secondMailId = lastMailId();
    await hardBounce(user.mailId);

    await post(event('Complaint', secondMailId));

    expect((await state(user)).emailMarker).toBe('bounce');
  });
});

describe('mail to a marked address', () => {
  /** A registered account whose address a hard bounce marked. */
  const markedAccount = async () => {
    const user = await verifiedAccount();
    await hardBounce(user.mailId);
    expect((await state(user)).emailMarker).toBe('bounce');
    mail.messages.length = 0;
    return user;
  };

  it('refuses to resend verification with its own code and sends nothing', async () => {
    const user = await markedAccount();

    const response = await resend(user);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_UNDELIVERABLE');
    expect(mail.messages).toEqual([]);
  });

  it('refuses the same address again with the same code, the summary, and no mail', async () => {
    const user = await markedAccount();

    const response = await setEmail(user, user.email.toUpperCase());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_UNDELIVERABLE');
    expect(response.body.user).toMatchObject({ email: user.email, emailMarker: 'bounce' });
    expect(mail.messages).toEqual([]);
  });

  it('clears the marker when the address changes, and mails the new one', async () => {
    const user = await markedAccount();
    const address = `fixed-${user.email}`;

    const response = await setEmail(user, address);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mailSent: true, user: { email: address, emailMarker: null, emailVerified: false } });
    expect(mail.messages.map((message) => message.to)).toEqual([address]);
  });

  it('answers the reset request as for an unknown name, before and without any mail', async () => {
    const user = await markedAccount();

    const marked = await requestReset(user.username);
    const unknown = await requestReset(`nobody-${user.username}`);

    expect(marked.status).toBe(unknown.status);
    expect(marked.body).toEqual(unknown.body);
    expect(mail.messages).toEqual([]);
  });

  it('spends an older verification link and verifies nothing', async () => {
    const user = await registered();
    const token = lastToken();
    await hardBounce(user.mailId);

    const response = await verify(token);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_UNDELIVERABLE');
    expect(await state(user)).toEqual({ emailMarker: 'bounce', emailVerified: false });
    expect((await verify(token)).body.code).toBe('TOKEN_INVALID');
  });
});

describe('the account summary', () => {
  it('carries the marker reason on login, me, and the email route, and null while unmarked', async () => {
    const user = await registered();
    expect((await login(user)).body.user.emailMarker).toBeNull();

    await post(event('Complaint', user.mailId));

    expect((await login(user)).body.user.emailMarker).toBe('complaint');
    expect((await me(user)).body.user.emailMarker).toBe('complaint');
    expect((await setEmail(user, user.email)).body.user.emailMarker).toBe('complaint');
  });

  it('carries null from register', async () => {
    const response = await fromItsOwnAddress(request(app).post('/api/auth/register')
      .send({ username: `bounce-fresh-${(named += 1)}`, password: 'password123' }));

    expect(response.body.user).toHaveProperty('emailMarker', null);
  });
});
