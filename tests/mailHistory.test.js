import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { authHeader, createUser, fromItsOwnAddress } from './helpers.js';
import { SECRET, event, post } from './sesEvents.js';

const require = createRequire(import.meta.url);
const {
  setMailTransport, resetMailTransport, captureTransport, setSesClient, resetSesClient
} = require('../src/utils/mail');

/**
 * Staff read of one account's mail history, and Clear Bounce, which takes the address off the SES
 * suppression list before it removes the marker.
 */

let mail;
let removals;
let sesFailure;

/** The SES client's suppression removal, as a test sets it to answer. */
const fakeSes = {
  deleteSuppressedDestination: async (input) => {
    removals.push(input);
    if (sesFailure) throw sesFailure;
    return {};
  }
};

const awsError = (name) => Object.assign(new Error(`${name}: person.private@example.test`), { name });

beforeEach(() => {
  mail = captureTransport();
  setMailTransport(mail);
  removals = [];
  sesFailure = null;
  setSesClient(fakeSes);
  vi.stubEnv('SES_EVENTS_SECRET', SECRET);
});

afterEach(() => {
  resetMailTransport();
  resetSesClient();
  vi.unstubAllEnvs();
  db.exec('DELETE FROM mail_log');
  db.exec('DELETE FROM account_tokens');
});

let named = 0;

/** A new account with an address, made through the register route; returns it with its first mail's id. */
const registered = async () => {
  const username = `history-${(named += 1)}`;
  const email = `${username}@example.test`;
  const response = await fromItsOwnAddress(request(app).post('/api/auth/register')
    .send({ username, password: 'password123', email }));
  expect(response.status).toBe(201);

  return { id: response.body.user.id, username, email, mailId: mail.messages.at(-1).tags.mail_id };
};

const hardBounce = (mailId) => post(event('Bounce', mailId, { extra: ['Permanent', 'General'] }));
const softBounce = (mailId) => post(event('Bounce', mailId, { extra: ['Transient', 'MailboxFull'] }));

/** A registered account whose address a hard bounce marked. */
const bouncedAccount = async () => {
  const user = await registered();
  expect((await hardBounce(user.mailId)).status).toBe(200);
  return user;
};

const history = (caller, user) => request(app).get(`/api/users/${user.id}/mail-history`).set(authHeader(caller));
const clear = (caller, user) => request(app).delete(`/api/users/${user.id}/email-marker`).set(authHeader(caller));
const me = (user) => request(app).get('/api/auth/me').set(authHeader(user));
const resend = (user) => fromItsOwnAddress(request(app).post('/api/auth/resend-verification').set(authHeader(user)));

const clearEntries = async (user) => {
  const { body } = await request(app).get('/api/audit?action=email_marker_cleared&limit=100').set(authHeader(admin()));
  return body.data.filter((entry) => entry.targetUser?.id === user.id);
};

let adminUser;
let modUser;
const admin = () => adminUser;
const mod = () => modUser;

beforeEach(() => {
  adminUser = createUser({ accountType: 'admin' });
  modUser = createUser({ accountType: 'mod' });
});

describe('mail history', () => {
  it('shows staff the rows newest first and the marker with its time', async () => {
    const user = await registered();
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await resend(user);
    const second = mail.messages.at(-1).tags.mail_id;
    await softBounce(user.mailId);
    await hardBounce(second);

    const response = await history(mod(), user);

    expect(response.status).toBe(200);
    const { emailMarker, emailMarkedAt, mails } = response.body.data;
    expect(emailMarker).toBe('bounce');
    expect(Number.isNaN(Date.parse(emailMarkedAt))).toBe(false);
    expect(mails.map(({ kind, status, bounceType }) => ({ kind, status, bounceType }))).toEqual([
      { kind: 'verify', status: 'bounced', bounceType: 'hard' },
      { kind: 'verify', status: 'bounced', bounceType: 'soft' }
    ]);
    expect(Date.parse(mails[0].sentAt)).toBeGreaterThan(Date.parse(mails[1].sentAt));
    expect(Object.keys(mails[0]).sort()).toEqual(['bounceType', 'kind', 'sentAt', 'status', 'statusAt']);
  });

  it('leaves bounceType off a row that did not bounce, and the marker empty when unmarked', async () => {
    const user = await registered();

    const { body } = await history(admin(), user);

    expect(body.data.emailMarker).toBeNull();
    expect(body.data.emailMarkedAt).toBeNull();
    expect(body.data.mails).toHaveLength(1);
    expect(body.data.mails[0]).not.toHaveProperty('bounceType');
    expect(body.data.mails[0].status).toBe('sent');
  });

  it('holds no address and no SES message id', async () => {
    const user = await bouncedAccount();
    const messageIds = db.prepare('SELECT message_id FROM mail_log WHERE user_id = ?').all(user.id).map((row) => row.message_id);
    expect(messageIds.length).toBeGreaterThan(0);

    const text = JSON.stringify((await history(mod(), user)).body);

    expect(text).not.toContain(user.email);
    expect(text).not.toContain('@');
    for (const id of messageIds) expect(text).not.toContain(`"${id}"`);
  });

  it('lets a mod read an admin account, as linked accounts do', async () => {
    expect((await history(mod(), admin())).status).toBe(200);
  });

  it('refuses a signed-in non-staff user and a guest', async () => {
    const user = await registered();
    const other = createUser();

    expect((await history(other, user)).status).toBe(403);
    expect((await history(user, user)).status).toBe(403);
    expect((await request(app).get(`/api/users/${user.id}/mail-history`)).status).toBe(401);
  });

  it('answers 404 for an unknown account', async () => {
    expect((await history(mod(), { id: 'no-such-user' })).status).toBe(404);
  });
});

describe('clear bounce', () => {
  it('takes the address read from the account off the SES list, then removes the marker', async () => {
    const user = await bouncedAccount();

    const response = await clear(mod(), user);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ cleared: true });
    expect(removals).toEqual([{ EmailAddress: user.email }]);
    expect((await me(user)).body.user.emailMarker).toBeNull();
  });

  it('leaves the address unverified, and resend-verification sends again', async () => {
    const user = await bouncedAccount();
    await clear(admin(), user);
    const sent = mail.messages.length;

    expect((await me(user)).body.user.emailVerified).toBe(false);
    const response = await resend(user);

    expect(response.status).toBe(200);
    expect(mail.messages).toHaveLength(sent + 1);
    expect(mail.messages.at(-1).to).toBe(user.email);
  });

  it('keeps the marker, says the clear failed and writes no audit entry when SES fails', async () => {
    const user = await bouncedAccount();
    sesFailure = awsError('TooManyRequestsException');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await clear(mod(), user);
    const logged = errors.mock.calls.flat().join(' ');
    errors.mockRestore();

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('MAIL_PROVIDER_FAILED');
    expect((await me(user)).body.user.emailMarker).toBe('bounce');
    expect(await clearEntries(user)).toHaveLength(0);
    expect(logged).not.toContain('@');
  });

  it('counts an address SES did not hold as cleared', async () => {
    const user = await bouncedAccount();
    sesFailure = awsError('NotFoundException');

    const response = await clear(mod(), user);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ cleared: true });
    expect((await me(user)).body.user.emailMarker).toBeNull();
  });

  it('writes one audit entry naming the staff member, the account and the reason', async () => {
    const user = await bouncedAccount();

    await clear(mod(), user);
    await clear(mod(), user);

    const entries = await clearEntries(user);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { id: mod().id }, targetUser: { id: user.id, username: user.username }, snippet: 'bounce'
    });
  });

  it('names the account in the entry when staff clear their own marker', async () => {
    const user = await bouncedAccount();
    db.prepare("UPDATE users SET account_type = 'mod' WHERE id = ?").run(user.id);

    expect((await clear(user, user)).status).toBe(200);

    const [entry] = await clearEntries(user);
    expect(entry).toMatchObject({ actor: { id: user.id }, targetUser: { id: user.id } });
  });

  it('clears the marker with mail off, where there is no SES list', async () => {
    const user = await bouncedAccount();
    setSesClient(null);

    const response = await clear(mod(), user);

    expect(response.body.data).toEqual({ cleared: true });
    expect((await me(user)).body.user.emailMarker).toBeNull();
  });

  it('lists the action with the others', async () => {
    const { body } = await request(app).get('/api/audit/meta').set(authHeader(mod()));

    expect(body.actions).toContain('email_marker_cleared');
  });

  it('changes nothing on an unmarked account and says so', async () => {
    const user = await registered();

    const response = await clear(mod(), user);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ cleared: false });
    expect(removals).toHaveLength(0);
    expect(await clearEntries(user)).toHaveLength(0);
  });

  it('refuses a mod on an admin account', async () => {
    db.prepare("UPDATE users SET email = 'boss@example.test', email_marker = 'bounce', email_marked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), admin().id);

    const response = await clear(mod(), admin());

    expect(response.status).toBe(403);
    expect(removals).toHaveLength(0);
  });

  it('refuses a signed-in non-staff user and a guest', async () => {
    const user = await bouncedAccount();

    expect((await clear(user, user)).status).toBe(403);
    expect((await request(app).delete(`/api/users/${user.id}/email-marker`)).status).toBe(401);
    expect((await me(user)).body.user.emailMarker).toBe('bounce');
  });
});
