import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const { setMailTransport, resetMailTransport, captureTransport } = require('../src/utils/mail');
const { SITE_URL, MAIL_FROM } = require('../src/config/mail');
const { RESET } = require('../src/config/accountTokens');
const AccountToken = require('../src/models/AccountToken');

/**
 * Registering with an email, and proving the address is yours.
 *
 * The address is optional and never blocks play: the account works the moment it is made, verified or
 * not. What has to hold is that one address belongs to one account, that the link in the mail is the
 * only thing that can mark it verified, and that the link works exactly once and not forever.
 */

let mail;

/** A name nobody else in this file has taken, for the cases that do not care which name it is. */
let named = 0;

const register = (body) => fromItsOwnAddress(request(app).post('/api/auth/register').send({
  username: `player-${(named += 1)}`,
  password: 'password123',
  ...body
}));

const verify = (token) => fromItsOwnAddress(request(app).post('/api/auth/verify-email').send({ token }));

const me = (user) => request(app).get('/api/auth/me').set(authHeader(user));

/** The raw token as a player gets it: out of the link in the mail, never out of the database. */
const tokenFromMail = (message) => {
  const match = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  return match && match[1];
};

const userRow = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username);

beforeEach(() => {
  mail = captureTransport();
  setMailTransport(mail);
});

afterEach(() => {
  resetMailTransport();
  db.exec('DELETE FROM account_tokens');
});

describe('registering with an email', () => {
  it('takes the address, stores it unverified, and lets the account in at once', async () => {
    const response = await register({ username: 'ilse', email: 'ilse@example.test' });

    expect(response.status).toBe(201);
    expect(response.body.token).toBeTruthy(); // signed in without verifying anything
    expect(response.body.user.email).toBe('ilse@example.test');
    expect(userRow('ilse').email_verified_at).toBeNull();
  });

  it('registers without an email and sends nothing', async () => {
    const response = await register({ username: 'quiet' });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBeNull();
    expect(mail.messages).toHaveLength(0);
  });

  it('reads an empty box as no address rather than a bad one', async () => {
    // A registration form posts every field it has. An empty email box must not fail validation, or
    // signing up without an address is impossible from the one client that sends the field.
    const response = await register({ username: 'blank', email: '' });

    expect(response.status).toBe(201);
    expect(userRow('blank').email).toBeNull();
    expect(mail.messages).toHaveLength(0);
  });

  it('refuses an address another account already holds, whatever its case', async () => {
    createUser({ username: 'holder', email: 'Taken@Example.test' });

    const response = await register({ username: 'latecomer', email: 'taken@example.TEST' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_TAKEN');
    expect(userRow('latecomer')).toBeUndefined();
    expect(mail.messages).toHaveLength(0);
  });

  it('tells a taken email apart from a taken username', async () => {
    // Two different fixes for the player: pick another name, or recover the account that has the address.
    // One shared error would send half of them down the wrong path.
    createUser({ username: 'twin', email: 'twin@example.test' });

    const name = await register({ username: 'twin', email: 'other@example.test' });
    const address = await register({ username: 'other', email: 'twin@example.test' });

    expect(name.status).toBe(400);
    expect(name.body.error).toMatch(/username/i);
    expect(name.body.code).toBeUndefined();
    expect(address.status).toBe(409);
    expect(address.body.code).toBe('EMAIL_TAKEN');
    expect(address.body.error).toMatch(/email/i);
  });

  it('refuses a taken name even when the account has no address to collide on', async () => {
    // Both refusals come off the same constraint now, so the name branch has to be the one that answers
    // when the name is what collided.
    createUser({ username: 'solo' });

    const response = await register({ username: 'solo', email: 'solo@example.test' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/username/i);
    expect(mail.messages).toHaveLength(0);
  });
});

describe('the verification mail', () => {
  it('goes to the address given, from the configured sender, carrying a link to the site', async () => {
    await register({ username: 'ilse', email: 'ilse@example.test' });

    expect(mail.messages).toHaveLength(1);
    const [message] = mail.messages;
    expect(message.to).toBe('ilse@example.test');
    expect(message.from).toBe(MAIL_FROM);
    expect(message.subject).toMatch(/verif/i);
    expect(message.text).toContain(`${SITE_URL}/verify-email?token=`);
    expect(message.html).toContain(`${SITE_URL}/verify-email?token=`);
    expect(tokenFromMail(message)).toBeTruthy();
  });

  it('never stores the token it mailed', async () => {
    // A database leak must not hand out working links. The row keeps a hash; only the mail has the token.
    await register({ username: 'ilse', email: 'ilse@example.test' });
    const token = tokenFromMail(mail.messages[0]);

    const stored = db.prepare('SELECT * FROM account_tokens').all();

    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('registers the account even when the mail cannot be sent', async () => {
    // Delivery is somebody else's service. An outage there must not cost a player their registration.
    setMailTransport({ send: () => Promise.reject(new Error('Resend is down')) });

    const response = await register({ username: 'unlucky', email: 'unlucky@example.test' });

    expect(response.status).toBe(201);
    expect(userRow('unlucky')).toBeTruthy();
  });
});

describe('opening the verification link', () => {
  const registerAndRead = async (username = 'ilse', email = 'ilse@example.test') => {
    await register({ username, email });
    return { user: { id: userRow(username).id }, token: tokenFromMail(mail.messages[0]) };
  };

  it('marks the address verified, and the me endpoint says so', async () => {
    const { user, token } = await registerAndRead();
    expect((await me(user)).body.user.emailVerified).toBe(false);

    const response = await verify(token);

    expect(response.status).toBe(200);
    expect(userRow('ilse').email_verified_at).toBeTruthy();
    const profile = await me(user);
    expect(profile.body.user.email).toBe('ilse@example.test');
    expect(profile.body.user.emailVerified).toBe(true);
  });

  it('works once and refuses the same link afterwards', async () => {
    const { user, token } = await registerAndRead();
    await verify(token);

    const replay = await verify(token);

    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('TOKEN_INVALID');
    // The first use stands: a replay is refused, not undone.
    expect((await me(user)).body.user.emailVerified).toBe(true);
  });

  it('refuses a link older than its expiry', async () => {
    const { user, token } = await registerAndRead();
    db.prepare('UPDATE account_tokens SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());

    const response = await verify(token);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TOKEN_INVALID');
    expect(userRow('ilse').email_verified_at).toBeNull();
    expect((await me(user)).body.user.emailVerified).toBe(false);
  });

  it('refuses a token nobody was ever sent', async () => {
    await registerAndRead();

    const response = await verify('not-a-token-anyone-holds');

    expect(response.status).toBe(400);
    expect(userRow('ilse').email_verified_at).toBeNull();
  });

  it('refuses a reset token at the verification endpoint', async () => {
    // The purpose is part of what is checked, so a token minted for one door does not open the other.
    const user = createUser({ username: 'ilse', email: 'ilse@example.test' });
    const reset = AccountToken.issue({ userId: user.id, purpose: RESET });

    const response = await verify(reset);

    expect(response.status).toBe(400);
    expect(userRow('ilse').email_verified_at).toBeNull();
  });

  it('refuses an empty token without touching anything', async () => {
    const response = await verify('');

    expect(response.status).toBe(400);
  });

  it('refuses a token that is not even a string, without leaking why', async () => {
    // A JSON body can carry any shape in this field. Hashing an object throws, and the error handler
    // echoes the message — so the wrong shape would answer 500 with a Node internals string in it.
    for (const shape of [{ a: 1 }, 12345, ['t'], true, null]) {
      const response = await fromItsOwnAddress(
        request(app).post('/api/auth/verify-email').send({ token: shape })
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('TOKEN_INVALID');
    }
  });
});
