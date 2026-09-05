import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const { setMailTransport, resetMailTransport, captureTransport } = require('../src/utils/mail');
const { SITE_URL, MAIL_FROM } = require('../src/config/mail');
const { VERIFY } = require('../src/config/accountTokens');
const AccountToken = require('../src/models/AccountToken');

/**
 * Recovering an account whose password is gone.
 *
 * Two promises carry this feature. Asking for a reset must tell an outsider nothing about who has an
 * account here, so every request answers the same way whatever it named. And a completed reset must end
 * every session on the account, because the reason somebody resets a password is usually that another
 * person had it.
 *
 * Every account and every made-up address in this file gets a name of its own. The per-name budget is
 * three requests an hour and the limiter's memory outlives a test, so a name shared between two tests
 * would have them spending one budget between them.
 */

let mail;

/** A name nobody else in this file has taken. */
let named = 0;
const freshName = (prefix) => `${prefix}-${(named += 1)}`;

/** An account whose address is proven, which is the only kind that gets reset mail. */
const verifiedUser = () => {
  const username = freshName('player');
  const email = `${username}@example.test`;
  const user = createUser({ username, email });
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);

  return { ...user, email };
};

/** An account that gave an address and never proved it. */
const unprovenUser = () => {
  const username = freshName('unproven');

  return createUser({ username, email: `${username}@example.test` });
};

const requestReset = (account) => fromItsOwnAddress(
  request(app).post('/api/auth/request-password-reset').send({ account })
);

const completeReset = (body) => fromItsOwnAddress(
  request(app).post('/api/auth/reset-password').send(body)
);

const login = (username, password) => fromItsOwnAddress(
  request(app).post('/api/auth/login').send({ username, password })
);

const me = (headers) => request(app).get('/api/auth/me').set(headers);

/** The raw token as a player gets it: out of the link in the mail, never out of the database. */
const tokenFromMail = (message) => {
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  return match && match[1];
};

/** Ask for a reset and read the token back out of the mail it caused. */
const mailedToken = async (account) => {
  await requestReset(account);
  return tokenFromMail(mail.messages[mail.messages.length - 1]);
};

beforeEach(() => {
  mail = captureTransport();
  setMailTransport(mail);
});

afterEach(() => {
  resetMailTransport();
  db.exec('DELETE FROM account_tokens');
});

describe('asking for a reset', () => {
  it('mails a link that names the site reset page', async () => {
    const user = verifiedUser();

    const response = await requestReset(user.email);

    expect(response.status).toBe(200);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe(user.email);
    expect(mail.messages[0].from).toBe(MAIL_FROM);
    expect(mail.messages[0].text).toContain(`${SITE_URL}/reset-password?token=`);
    expect(tokenFromMail(mail.messages[0])).toBeTruthy();
  });

  it('finds the account by username too', async () => {
    const user = verifiedUser();

    const response = await requestReset(user.username);

    expect(response.status).toBe(200);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe(user.email);
  });

  it('finds the address however either side spelled the capitals', async () => {
    const username = freshName('Capitalized');
    const user = createUser({ username, email: `${username}@Example.test` });
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);

    await requestReset(`  ${username.toUpperCase()}@EXAMPLE.TEST  `);

    expect(mail.messages).toHaveLength(1);
  });

  it('answers a verified, an unverified and an unknown account identically', async () => {
    const known = verifiedUser();
    const unproven = unprovenUser();

    const answers = await Promise.all([
      requestReset(known.email),
      requestReset(unproven.email),
      requestReset(`${freshName('nobody')}@example.test`),
      requestReset(freshName('no-such-name'))
    ]);

    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual(answers[0].body);
    }
  });

  it('mails only the verified account of the four', async () => {
    const known = verifiedUser();
    const unproven = unprovenUser();

    await requestReset(known.email);
    await requestReset(unproven.email);
    await requestReset(`${freshName('nobody')}@example.test`);
    await requestReset(freshName('no-such-name'));

    expect(mail.messages.map((message) => message.to)).toEqual([known.email]);
  });

  it('answers while the mail is still going out', async () => {
    // The bodies are identical, so delivery is the only thing left that could tell a real account from a
    // made-up one — handing a message to Resend takes far longer than finding nothing does. A transport
    // that never finishes stands in for the slowest possible one: the answer has to arrive anyway.
    const user = verifiedUser();
    let deliver;
    setMailTransport({ send: () => new Promise((resolve) => { deliver = resolve; }) });

    const response = await requestReset(user.email);

    expect(response.status).toBe(200);
    deliver();
  });

  it('mints no token for an account it cannot mail', async () => {
    // Otherwise a row nobody was sent would sit in the table until it expired, and the only way to reach
    // it would be reading the database — which is the thing the hash is there to make useless.
    const user = unprovenUser();

    await requestReset(user.email);

    const tokens = db.prepare('SELECT COUNT(*) AS n FROM account_tokens WHERE user_id = ?').get(user.id);
    expect(tokens.n).toBe(0);
  });

  it('refuses a request that names nobody at all', async () => {
    for (const nothing of ['', '   ', undefined]) {
      const response = await requestReset(nothing);

      expect(response.status).toBe(400);
    }

    expect(mail.messages).toHaveLength(0);
  });
});

describe('completing a reset', () => {
  it('sets the new password and lets it sign in', async () => {
    const user = verifiedUser();
    const token = await mailedToken(user.username);

    const response = await completeReset({ token, newPassword: 'brand-new-pass' });

    expect(response.status).toBe(200);
    expect(response.body.username).toBe(user.username);
    expect((await login(user.username, 'brand-new-pass')).status).toBe(200);
    expect((await login(user.username, user.password)).status).toBe(401);
  });

  it('ends the sessions the old password protected', async () => {
    const user = verifiedUser();
    const oldSession = authHeader(user);
    expect((await me(oldSession)).status).toBe(200);

    const token = await mailedToken(user.username);
    await completeReset({ token, newPassword: 'brand-new-pass' });

    expect((await me(oldSession)).status).toBe(401);
  });

  it('hands back no session of its own', async () => {
    // A reset is usually somebody taking an account back off another person. Answering with a session
    // would make this route the one exception to the rule the version bump exists to enforce.
    const user = verifiedUser();
    const token = await mailedToken(user.username);

    const response = await completeReset({ token, newPassword: 'brand-new-pass' });

    expect(response.body.token).toBeUndefined();
  });

  it('refuses a password shorter than the change-password rule allows', async () => {
    const user = verifiedUser();
    const token = await mailedToken(user.username);

    const response = await completeReset({ token, newPassword: 'short' });

    expect(response.status).toBe(400);
    // The link has to survive a password the form should have caught, or one typo costs a whole mail.
    expect((await completeReset({ token, newPassword: 'brand-new-pass' })).status).toBe(200);
  });

  it('refuses a token that has already been spent', async () => {
    const user = verifiedUser();
    const token = await mailedToken(user.username);
    await completeReset({ token, newPassword: 'brand-new-pass' });

    const response = await completeReset({ token, newPassword: 'second-attempt-pass' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TOKEN_INVALID');
    expect((await login(user.username, 'second-attempt-pass')).status).toBe(401);
  });

  it('refuses a token the hour has run out on', async () => {
    const user = verifiedUser();
    const token = await mailedToken(user.username);

    // The hour passing, written on the row rather than shortened in config: the window under test is the
    // one production mints.
    db.prepare('UPDATE account_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());

    const response = await completeReset({ token, newPassword: 'brand-new-pass' });

    expect(response.status).toBe(400);
    expect((await login(user.username, user.password)).status).toBe(200);
  });

  it('mints tokens that last an hour and no longer', async () => {
    const user = verifiedUser();
    await mailedToken(user.username);

    const row = db.prepare('SELECT created_at, expires_at FROM account_tokens').get();
    const lifetime = Date.parse(row.expires_at) - Date.parse(row.created_at);

    expect(lifetime).toBe(60 * 60 * 1000);
  });

  it('refuses a verification token at the reset endpoint', async () => {
    // The purpose is part of what is checked, so a token minted for one door does not open the other.
    const user = verifiedUser();
    const verification = AccountToken.issue({ userId: user.id, purpose: VERIFY });

    const response = await completeReset({ token: verification, newPassword: 'brand-new-pass' });

    expect(response.status).toBe(400);
    expect((await login(user.username, user.password)).status).toBe(200);
  });

  it('refuses a token that is not even a string, without leaking why', async () => {
    // A JSON body can carry any shape in this field. Hashing an object throws, and the error handler
    // echoes the message — so the wrong shape would answer 500 with a Node internals string in it.
    for (const shape of [{ a: 1 }, 12345, ['t'], true, null, undefined]) {
      const response = await completeReset({ token: shape, newPassword: 'brand-new-pass' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('TOKEN_INVALID');
    }
  });
});

describe('the limit on how much reset mail one name can cause', () => {
  // Written out rather than read from `config/mail`, so a test asserting three is a test of the promise
  // the README makes and not a mirror of whatever the constant happens to say.
  const BUDGET = 3;

  it('stops the flood however many addresses the requests come from', async () => {
    // The per-name budget is the one being proven, so every request arrives from a different IP and the
    // credential limiter never gets to be the reason.
    const user = verifiedUser();

    const codes = [];
    for (let attempt = 0; attempt < BUDGET + 1; attempt += 1) {
      codes.push((await requestReset(user.email)).status);
    }

    expect(codes).toEqual([...Array(BUDGET).fill(200), 429]);
    expect(mail.messages).toHaveLength(BUDGET);
  });

  it('counts one address however the request spells it', async () => {
    const user = verifiedUser();

    for (const spelling of [user.email, user.email.toUpperCase(), `  ${user.email}  `]) {
      expect((await requestReset(spelling)).status).toBe(200);
    }

    expect((await requestReset(user.email)).status).toBe(429);
  });

  it('leaves the next name a full budget', async () => {
    const flooded = verifiedUser();
    const bystander = verifiedUser();

    for (let attempt = 0; attempt < BUDGET; attempt += 1) await requestReset(flooded.email);

    expect((await requestReset(bystander.email)).status).toBe(200);
  });

  it('spends the budget of a name nobody has, the same as one somebody does', async () => {
    // A stranger's fourth try must not answer differently from a member's, or the limiter becomes the
    // account oracle the identical responses exist to deny.
    const nobody = `${freshName('nobody')}@example.test`;

    const codes = [];
    for (let attempt = 0; attempt < BUDGET + 1; attempt += 1) {
      codes.push((await requestReset(nobody)).status);
    }

    expect(codes).toEqual([...Array(BUDGET).fill(200), 429]);
  });

  it('refunds a request that named nobody at all', async () => {
    const user = verifiedUser();

    await requestReset('');
    await requestReset('');

    // The empty name has its own bucket, so this only proves the refund if the budget survives — which
    // is the point: a form submitted blank must not cost the person the mail they came for.
    const codes = [];
    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      codes.push((await requestReset(user.email)).status);
    }

    expect(codes).toEqual(Array(BUDGET).fill(200));
  });
});
