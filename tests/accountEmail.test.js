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
const { addressGiven, foldedAddress } = require('../src/utils/emailAddress');

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

const setEmail = (user, email) => fromItsOwnAddress(
  request(app).post('/api/auth/email').set(authHeader(user)).send({ email })
);

const resend = (user) => fromItsOwnAddress(
  request(app).post('/api/auth/resend-verification').set(authHeader(user))
);

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

describe('reading an address off a field', () => {
  // Tested here rather than through a route: the validators refuse most of these shapes before a handler
  // sees them, so the contract the rest of the feature leans on has no other place to be proven.
  it('reads a field carrying no address as none', () => {
    for (const nothing of ['', '   ', '\t\n', undefined, null, 42, {}, ['a@b.test']]) {
      expect(addressGiven(nothing)).toBeNull();
      expect(foldedAddress(nothing)).toBeNull();
    }
  });

  it('keeps the capitals for storing and drops them for comparing', () => {
    expect(addressGiven('  Ilse@Example.TEST  ')).toBe('Ilse@Example.TEST');
    expect(foldedAddress('  Ilse@Example.TEST  ')).toBe('ilse@example.test');
  });
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

describe('setting the address on an account already signed in', () => {
  it('writes the address, leaves it unverified, and mails a link that works', async () => {
    const user = createUser({ username: 'newcomer' });

    const response = await setEmail(user, 'newcomer@example.test');

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('newcomer@example.test');
    expect(response.body.user.emailVerified).toBe(false);
    expect(response.body.mailSent).toBe(true);
    expect(userRow('newcomer').email_verified_at).toBeNull();

    expect((await verify(tokenFromMail(mail.messages[0]))).status).toBe(200);
  });

  it('clears the verified stamp when the address is replaced', async () => {
    // The stamp says one address was proven. It cannot carry over to a different one.
    const user = createUser({ username: 'mover', email: 'old@example.test' });
    await resend(user);
    await verify(tokenFromMail(mail.messages[0]));
    expect(userRow('mover').email_verified_at).toBeTruthy();

    const response = await setEmail(user, 'new@example.test');

    expect(response.body.user.email).toBe('new@example.test');
    expect(response.body.user.emailVerified).toBe(false);
    expect(userRow('mover').email_verified_at).toBeNull();
  });

  it('keeps the stamp when the address given is the one already proven', async () => {
    // Saving the account page without touching the address must not undo the verification.
    const user = createUser({ username: 'resaver', email: 'resaver@example.test' });
    await resend(user);
    await verify(tokenFromMail(mail.messages[0]));
    const stamped = userRow('resaver').email_verified_at;
    mail.messages.length = 0;

    const response = await setEmail(user, 'ReSaver@Example.TEST');

    expect(response.status).toBe(200);
    expect(response.body.user.emailVerified).toBe(true);
    expect(userRow('resaver').email_verified_at).toBe(stamped);
    expect(mail.messages).toHaveLength(0);
  });

  it('refuses an address another account holds, whatever its case', async () => {
    createUser({ username: 'holder2', email: 'Held@example.test' });
    const user = createUser({ username: 'grabber', email: 'grabber@example.test' });

    const response = await setEmail(user, 'held@example.TEST');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_TAKEN');
    expect(userRow('grabber').email).toBe('grabber@example.test');
    expect(mail.messages).toHaveLength(0);
  });

  it('retires the link mailed for the old address', async () => {
    // Two live links to one door is the replay the single-use rule exists to stop.
    const user = createUser({ username: 'swapper', email: 'first@example.test' });
    await resend(user);
    const oldToken = tokenFromMail(mail.messages[0]);

    await setEmail(user, 'second@example.test');

    expect((await verify(oldToken)).status).toBe(400);
    expect(userRow('swapper').email_verified_at).toBeNull();
  });

  it('refuses an address that is not one', async () => {
    const user = createUser({ username: 'typo' });

    const response = await setEmail(user, 'not-an-address');

    expect(response.status).toBe(400);
    expect(userRow('typo').email).toBeNull();
    expect(mail.messages).toHaveLength(0);
  });

  it('refuses an empty field rather than clearing the address', async () => {
    // Removing an address is not what this route is for, and an empty box must not be read as asking to.
    const user = createUser({ username: 'blanker', email: 'blanker@example.test' });

    const response = await setEmail(user, '');

    expect(response.status).toBe(400);
    expect(userRow('blanker').email).toBe('blanker@example.test');
  });

  it('saves the address even when the mail cannot be sent, and says the mail did not go', async () => {
    // The address is on file either way, so the client needs to know whether to offer another try.
    const user = createUser({ username: 'offline' });
    setMailTransport({ send: () => Promise.reject(new Error('Resend is down')) });

    const response = await setEmail(user, 'offline@example.test');

    expect(response.status).toBe(200);
    expect(response.body.mailSent).toBe(false);
    expect(userRow('offline').email).toBe('offline@example.test');
  });

  it('needs a session', async () => {
    const response = await fromItsOwnAddress(
      request(app).post('/api/auth/email').send({ email: 'nobody@example.test' })
    );

    expect(response.status).toBe(401);
    expect(mail.messages).toHaveLength(0);
  });
});

describe('asking for the verification mail again', () => {
  it('sends it again while the address is unverified', async () => {
    const user = createUser({ username: 'lostit', email: 'lostit@example.test' });

    const response = await resend(user);

    expect(response.status).toBe(200);
    expect(response.body.mailSent).toBe(true);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe('lostit@example.test');
    expect((await verify(tokenFromMail(mail.messages[0]))).status).toBe(200);
  });

  it('only the newest link works', async () => {
    const user = createUser({ username: 'twice', email: 'twice@example.test' });

    await resend(user);
    const first = tokenFromMail(mail.messages[0]);
    await resend(user);
    const second = tokenFromMail(mail.messages[1]);

    expect((await verify(first)).status).toBe(400);
    expect((await verify(second)).status).toBe(200);
  });

  it('sends nothing once the address is verified', async () => {
    const user = createUser({ username: 'settled', email: 'settled@example.test' });
    await resend(user);
    await verify(tokenFromMail(mail.messages[0]));
    mail.messages.length = 0;

    const response = await resend(user);

    expect(response.status).toBe(200);
    expect(response.body.emailVerified).toBe(true);
    expect(response.body.mailSent).toBe(false);
    expect(mail.messages).toHaveLength(0);
  });

  it('refuses when the account has no address to send to', async () => {
    const user = createUser({ username: 'addressless' });

    const response = await resend(user);

    expect(response.status).toBe(400);
    expect(mail.messages).toHaveLength(0);
  });

  it('says the mail did not go when the transport refuses it', async () => {
    const user = createUser({ username: 'undelivered', email: 'undelivered@example.test' });
    setMailTransport({ send: () => Promise.reject(new Error('Resend is down')) });

    const response = await resend(user);

    expect(response.status).toBe(200);
    expect(response.body.mailSent).toBe(false);
  });

  it('needs a session', async () => {
    const response = await fromItsOwnAddress(request(app).post('/api/auth/resend-verification'));

    expect(response.status).toBe(401);
  });
});

describe('the limit on how much mail one account can cause', () => {
  // Written out rather than read from `config/mail`, so a test asserting five is a test of the promise
  // the README makes and not a mirror of whatever the constant happens to say.
  const BUDGET = 5;

  it('stops the flood however many addresses the requests come from', async () => {
    // The per-account budget is the one being proven, so every request arrives from a different IP and
    // the credential limiter never gets to be the reason.
    const user = createUser({ username: 'flooder', email: 'flooder@example.test' });

    const codes = [];
    for (let attempt = 0; attempt < BUDGET + 1; attempt += 1) {
      codes.push((await resend(user)).status);
    }

    expect(codes).toEqual([...Array(BUDGET).fill(200), 429]);
    expect(mail.messages).toHaveLength(BUDGET);
  });

  it('is one budget across both routes', async () => {
    const user = createUser({ username: 'mixer', email: 'mixer@example.test' });

    expect((await resend(user)).status).toBe(200);
    expect((await resend(user)).status).toBe(200);
    expect((await setEmail(user, 'mixer-two@example.test')).status).toBe(200);
    expect((await setEmail(user, 'mixer-three@example.test')).status).toBe(200);
    expect((await resend(user)).status).toBe(200);

    expect((await resend(user)).status).toBe(429);
  });

  it('leaves another account its own budget', async () => {
    // One account running out must not lock everybody else out of their verification mail.
    const spender = createUser({ username: 'spender', email: 'spender@example.test' });
    const bystander = createUser({ username: 'bystander', email: 'bystander@example.test' });
    for (let attempt = 0; attempt < BUDGET; attempt += 1) await resend(spender);

    expect((await resend(spender)).status).toBe(429);
    expect((await resend(bystander)).status).toBe(200);
  });

  it('cannot be spent against somebody else by asking for their address', async () => {
    // The budget follows the account, not the address, so claiming an address you do not hold spends
    // your own. Keyed on the address instead, this loop would leave the holder unable to get their mail.
    const holder = createUser({ username: 'target', email: 'target@example.test' });
    const nuisance = createUser({ username: 'nuisance' });

    for (let attempt = 0; attempt < BUDGET * 2; attempt += 1) {
      expect((await setEmail(nuisance, 'target@example.test')).status).toBe(409);
    }

    expect((await resend(holder)).status).toBe(200);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe('target@example.test');
  });

  it('refunds a refusal, so a mistyped address does not cost the mail', async () => {
    const user = createUser({ username: 'fumbler', email: 'fumbler@example.test' });
    for (let attempt = 0; attempt < BUDGET * 2; attempt += 1) {
      expect((await setEmail(user, 'not-an-address')).status).toBe(400);
    }

    expect((await resend(user)).status).toBe(200);
  });

  it('spends the budget again on every new address set', async () => {
    // Rotating addresses is how one account could mail many strangers, so each write costs a slot.
    const user = createUser({ username: 'empty' });

    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      expect((await setEmail(user, `empty-${attempt}@example.test`)).status).toBe(200);
    }

    expect((await resend(user)).status).toBe(429);
  });
});
