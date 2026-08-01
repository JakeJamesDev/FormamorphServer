import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db, createTables } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

/**
 * Ending a session that is already signed in somewhere else.
 *
 * A JWT is good until it expires no matter what happens afterwards, so before this a stolen token
 * survived the owner changing their password and survived an admin suspending the account — the two
 * things anybody actually does about a breach. The account's session generation is the handle: a token
 * carries the one it was minted under, and bumping the row retires every token already out there.
 */

/** A header for whatever generation the account is on *now* — the session a fresh sign-in would give. */
const currentHeader = (user) => authHeader(user);

/** A header pinned to a generation, so a test can hold one across the bump that retires it. */
const headerAt = (user, tv) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, tv }, process.env.JWT_SECRET)}`
});

const generationOf = (user) =>
  db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id).token_version;

const admin = () => createUser({ accountType: 'admin' });

beforeEach(() => {
  createTables();
});

describe('a token from a retired generation', () => {
  it('is refused on a private route', async () => {
    const user = createUser();
    const stale = headerAt(user, generationOf(user));

    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);

    const res = await request(app).get('/api/auth/me').set(stale);
    expect(res.status).toBe(401);
  });

  it('is refused with the same wording as a forged one, so a probe learns nothing', async () => {
    const user = createUser();
    const stale = headerAt(user, generationOf(user));
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);

    const retired = await request(app).get('/api/auth/me').set(stale);
    const forged = await request(app).get('/api/auth/me').set({ Authorization: 'Bearer nonsense' });

    expect(retired.body.error).toBe(forged.body.error);
  });

  it('reads as signed-out on a route open to everyone', async () => {
    const user = createUser();
    const stale = headerAt(user, generationOf(user));
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);

    // optionalAuth never refuses; the caller simply stops being recognized.
    const res = await request(app).get(`/api/users/${user.id}/profile`).set(stale);
    expect(res.status).toBe(200);
  });

  it('is replaced by signing in again', async () => {
    const user = createUser({ password: 'a-known-password' });
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: 'a-known-password' });

    expect(login.status).toBe(200);
    const res = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${login.body.token}` });
    expect(res.status).toBe(200);
  });
});

describe('changing a password', () => {
  it('retires the sessions the old password protected', async () => {
    const user = createUser({ password: 'the-old-password' });
    const elsewhere = currentHeader(user);

    await request(app)
      .post('/api/auth/change-password')
      .set(currentHeader(user))
      .send({ currentPassword: 'the-old-password', newPassword: 'the-new-password' });

    const res = await request(app).get('/api/auth/me').set(elsewhere);
    expect(res.status).toBe(401);
  });

  it('hands back a token so the caller stays signed in where they did it', async () => {
    const user = createUser({ password: 'the-old-password' });

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set(currentHeader(user))
      .send({ currentPassword: 'the-old-password', newPassword: 'the-new-password' });

    expect(changed.body.token).toBeTruthy();
    const res = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${changed.body.token}` });
    expect(res.status).toBe(200);
  });

  it('leaves the sessions alone when the current password is wrong', async () => {
    const user = createUser({ password: 'the-old-password' });
    const before = generationOf(user);

    await request(app)
      .post('/api/auth/change-password')
      .set(currentHeader(user))
      .send({ currentPassword: 'not-it', newPassword: 'the-new-password' });

    expect(generationOf(user)).toBe(before);
  });
});

describe('a moderation action', () => {
  const setStatus = (actor, targetId, body) =>
    request(app).put(`/api/users/${targetId}/status`).set(currentHeader(actor)).send(body);

  it('reaches a suspended account that is already signed in', async () => {
    const offender = createUser();
    const openTab = currentHeader(offender);

    await setStatus(admin(), offender.id, { status: 'suspended' });

    const res = await request(app).get('/api/auth/me').set(openTab);
    expect(res.status).toBe(401);
  });

  it('reaches a demoted moderator that is already signed in', async () => {
    const moderator = createUser({ accountType: 'mod' });
    const openTab = currentHeader(moderator);

    await setStatus(admin(), moderator.id, { accountType: 'normal' });

    const res = await request(app).get('/api/users').set(openTab);
    expect(res.status).toBe(401);
  });

  it('does not disturb sessions when the status is re-saved unchanged', async () => {
    const user = createUser();
    const before = generationOf(user);

    await setStatus(admin(), user.id, { status: 'normal' });

    expect(generationOf(user)).toBe(before);
  });

  it('does not disturb sessions when reinstating', async () => {
    const user = createUser();
    await setStatus(admin(), user.id, { status: 'suspended' });
    const suspendedAt = generationOf(user);

    // Lifting a suspension is not a containment action; there is nothing to cut loose.
    await setStatus(admin(), user.id, { status: 'normal' });

    expect(generationOf(user)).toBe(suspendedAt);
  });
});

describe('the generation claim', () => {
  it('treats a token predating it as generation zero, so the migration logged nobody out', async () => {
    const user = createUser();
    const legacy = { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` };

    const res = await request(app).get('/api/auth/me').set(legacy);
    expect(res.status).toBe(200);
  });

  it('is carried by the tokens login and register mint', async () => {
    const user = createUser({ password: 'a-known-password' });
    db.prepare('UPDATE users SET token_version = 4 WHERE id = ?').run(user.id);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: 'a-known-password' });

    expect(jwt.decode(login.body.token).tv).toBe(4);

    const registered = await request(app)
      .post('/api/auth/register')
      .send({ username: 'brand-new-account', password: 'a-known-password' });

    expect(jwt.decode(registered.body.token).tv).toBe(0);
  });

  it('never reaches a client in a user payload', async () => {
    const user = createUser();

    const res = await request(app).get('/api/auth/me').set(currentHeader(user));
    expect(res.body.user).not.toHaveProperty('token_version');
    expect(res.body.user).not.toHaveProperty('tokenVersion');
  });
});
