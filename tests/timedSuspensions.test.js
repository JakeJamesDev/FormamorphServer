import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createRequire } from 'module';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { liftExpiredSuspension } = require('../src/utils/liftSuspension');

const { DAY_MS } = require('../src/config/time');

/**
 * A suspension with an end: staff pick 1–90 days or none, and the server lifts it once the end passes.
 */
const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });

const setStatus = (actor, target, body) =>
  request(app).put(`/api/users/${target.id}/status`).set(authHeader(actor)).send(body);

/** Assert an end lies `days` from now, to the minute. */
const expectEndInDays = (iso, days) =>
  expect(Math.abs(new Date(iso).getTime() - Date.now() - days * DAY_MS)).toBeLessThan(60_000);

describe('PUT /api/users/:id/status with days', () => {
  it('sets an end that many days out', async () => {
    const res = await setStatus(admin(), createUser(), { status: 'suspended', days: 7 });

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');
    expectEndInDays(res.body.user.suspendedUntil, 7);
  });

  it.each([
    ['omitted', { status: 'suspended' }],
    ['null', { status: 'suspended', days: null }]
  ])('sets no end when days is %s', async (_label, body) => {
    const res = await setStatus(admin(), createUser(), body);

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');
    expect(res.body.user.suspendedUntil).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['above the range', 91],
    ['negative', -3],
    ['fractional', 1.5],
    ['a string', '7'],
    ['a boolean', true]
  ])('refuses a length that is %s, naming the range', async (_label, days) => {
    const user = createUser();
    const res = await setStatus(admin(), user, { status: 'suspended', days });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A suspension must be between 1 and 90 whole days, or have no end');
  });

  it('accepts both ends of the range', async () => {
    const root = admin();
    const short = await setStatus(root, createUser(), { status: 'suspended', days: 1 });
    const long = await setStatus(root, createUser(), { status: 'suspended', days: 90 });

    expectEndInDays(short.body.user.suspendedUntil, 1);
    expectEndInDays(long.body.user.suspendedUntil, 90);
  });

  it.each(['normal', 'flagged'])('refuses days with status %s', async (status) => {
    const res = await setStatus(admin(), createUser(), { status, days: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A length in days can only go with a suspension');
  });

  it('refuses days with no status at all', async () => {
    const res = await setStatus(admin(), createUser(), { accountType: 'mod', days: 7 });

    expect(res.status).toBe(400);
  });

  it('leaves a refused length unapplied', async () => {
    const root = admin();
    const user = createUser();

    await setStatus(root, user, { status: 'suspended', days: 500 });
    const listed = await request(app).get(`/api/users?search=${user.username}`).set(authHeader(root));

    expect(listed.body.data[0]).toMatchObject({ status: 'normal', suspendedUntil: null });
  });

  it('replaces the end when an account is suspended again', async () => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended', days: 30 });

    const res = await setStatus(root, user, { status: 'suspended', days: 2 });

    expectEndInDays(res.body.user.suspendedUntil, 2);
  });

  it('turns a timed suspension into one with no end, and back', async () => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended', days: 30 });

    const open = await setStatus(root, user, { status: 'suspended', days: null });
    const timed = await setStatus(root, user, { status: 'suspended', days: 3 });

    expect(open.body.user.suspendedUntil).toBeNull();
    expectEndInDays(timed.body.user.suspendedUntil, 3);
  });

  it.each(['normal', 'flagged'])('clears the end when the status becomes %s', async (status) => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended', days: 30 });

    const res = await setStatus(root, user, { status });

    expect(res.body.user).toMatchObject({ status, suspendedUntil: null });
  });

  it('keeps the end when only the account type changes', async () => {
    const root = admin();
    const user = createUser();
    const suspended = await setStatus(root, user, { status: 'suspended', days: 30 });

    const res = await setStatus(root, user, { accountType: 'dev' });

    expect(res.body.user.suspendedUntil).toBe(suspended.body.user.suspendedUntil);
  });

  it('still refuses a peer on the staff ladder', async () => {
    const mod = createUser({ accountType: 'mod' });
    const peer = createUser({ accountType: 'mod' });

    const res = await setStatus(mod, peer, { status: 'suspended', days: 7 });

    expect(res.status).toBe(403);
  });

  it('lets a mod choose no end', async () => {
    const res = await setStatus(createUser({ accountType: 'mod' }), createUser(), { status: 'suspended', days: null });

    expect(res.status).toBe(200);
    expect(res.body.user.suspendedUntil).toBeNull();
  });
});

describe('re-suspending and sessions', () => {
  it('does not sign the account out again', async () => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended', days: 30 });
    // Signed in again after the first suspension, as the account would be.
    const session = authHeader(user);

    await setStatus(root, user, { status: 'suspended', days: 2 });
    const me = await request(app).get('/api/auth/me').set(session);

    expect(me.status).toBe(200);
  });
});

describe('the audit log', () => {
  const entries = async (root) =>
    (await request(app).get('/api/audit').set(authHeader(root))).body.data;

  it('states the end of a timed suspension', async () => {
    const root = admin();
    const res = await setStatus(root, createUser(), { status: 'suspended', days: 7 });

    const [entry] = await entries(root);
    expect(entry).toMatchObject({ action: 'user_suspended', snippet: `Ends on ${res.body.user.suspendedUntil}` });
  });

  it('says a suspension has no end', async () => {
    const root = admin();
    await setStatus(root, createUser(), { status: 'suspended' });

    const [entry] = await entries(root);
    expect(entry).toMatchObject({ action: 'user_suspended', snippet: 'No end' });
  });

  it('records a new end on a suspended account', async () => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended', days: 30 });

    const res = await setStatus(root, user, { status: 'suspended', days: null });

    const log = await entries(root);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ action: 'user_suspended', snippet: 'No end' });
    expect(res.body.user.suspendedUntil).toBeNull();
  });

  it('records nothing when the end did not change', async () => {
    const root = admin();
    const user = createUser();
    await setStatus(root, user, { status: 'suspended' });

    await setStatus(root, user, { status: 'suspended', days: null });

    expect(await entries(root)).toHaveLength(1);
  });
});

/** A suspended account whose end is `offsetMs` from now. */
const suspendedFor = (offsetMs) => {
  const user = createUser({ status: 'suspended' });
  db.prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
    .run(new Date(Date.now() + offsetMs).toISOString(), user.id);
  return user;
};

/** A write any signed-in account may make. */
const write = (user) => request(app).delete('/api/users/me/avatar').set(authHeader(user));

describe('the suspended gate', () => {
  it('refuses a write before the end, naming it in UTC', async () => {
    const user = createUser({ status: 'suspended' });
    db.prepare("UPDATE users SET suspended_until = '2099-03-04T18:30:12.345Z' WHERE id = ?").run(user.id);

    const res = await write(user);

    expect(res.status).toBe(403);
    expect(res.body.suspendedUntil).toBe('2099-03-04T18:30:12.345Z');
    expect(res.body.error).toBe('Your account has been suspended until 2099-03-04 18:30 UTC');
  });

  it('says only that the account is suspended when there is no end', async () => {
    const res = await write(createUser({ status: 'suspended' }));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Your account has been suspended', suspendedUntil: null });
  });

  it('lets the write through once the end has passed, and the account reads Normal', async () => {
    const user = suspendedFor(-60_000);

    const res = await write(user);
    const me = await request(app).get('/api/auth/me').set(authHeader(user));

    expect(res.status).toBe(200);
    expect(me.body.user).toMatchObject({ status: 'normal', suspendedUntil: null });
  });

  it('logs the lift once, with no actor', async () => {
    const root = admin();
    const user = suspendedFor(-60_000);

    await write(user);
    await write(user);
    const log = (await request(app).get('/api/audit').set(authHeader(root))).body.data;

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'suspension_expired',
      actor: { id: null, username: null },
      targetUser: { username: user.username }
    });
  });

  it('lifts nothing on a read before the end', async () => {
    const user = suspendedFor(DAY_MS);

    const me = await request(app).get('/api/auth/me').set(authHeader(user));

    expect(me.body.user.status).toBe('suspended');
  });
});

describe('the shared lift, given a row read before another change', () => {
  const rowOf = (user) => db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  it('does not lift a suspension staff renewed since the row was read', async () => {
    const user = suspendedFor(-60_000);
    const stale = rowOf(user);
    await setStatus(admin(), user, { status: 'suspended', days: 5 });

    const now = liftExpiredSuspension(stale);
    const me = await request(app).get('/api/auth/me').set(authHeader(user));

    expect(now.status).toBe('suspended');
    expect(me.body.user.status).toBe('suspended');
  });

  it('logs one lift when two paths lift the same row', async () => {
    const root = admin();
    const user = suspendedFor(-60_000);
    const stale = rowOf(user);

    liftExpiredSuspension(stale);
    const second = liftExpiredSuspension(stale);
    const log = (await request(app).get('/api/audit?action=suspension_expired').set(authHeader(root))).body.data;

    expect(second.status).toBe('normal');
    expect(log).toHaveLength(1);
  });
});

describe('signing in past the end', () => {
  const login = (user, password = user.password) =>
    request(app).post('/api/auth/login').send({ username: user.username, password });

  it('signs in as Normal', async () => {
    const user = suspendedFor(-60_000);

    const res = await login(user);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ status: 'normal', suspendedUntil: null });
  });

  it('lifts nothing for a wrong password', async () => {
    const root = admin();
    const user = suspendedFor(-60_000);

    await login(user, 'wrong-password');
    const log = (await request(app).get('/api/audit?action=suspension_expired').set(authHeader(root))).body.data;

    expect(log).toHaveLength(0);
  });
});

describe('staff acting on an account past its end', () => {
  it('logs the lift as the server before the staff change', async () => {
    const root = admin();
    const user = suspendedFor(-60_000);

    await setStatus(root, user, { status: 'normal' });
    const log = (await request(app).get('/api/audit').set(authHeader(root))).body.data;

    expect(log.map((entry) => entry.action)).toEqual(['suspension_expired']);
  });
});

describe('public profiles past the end', () => {
  it('shows the profile by id', async () => {
    const user = suspendedFor(-60_000);

    const res = await request(app).get(`/api/users/${user.id}/profile`);

    expect(res.status).toBe(200);
  });

  it('shows the profile by username', async () => {
    const user = suspendedFor(-60_000);

    const res = await request(app).get(`/api/users/by-username/${user.username}/profile`);

    expect(res.status).toBe(200);
  });

  it('still hides a profile before the end', async () => {
    const user = suspendedFor(DAY_MS);

    const res = await request(app).get(`/api/users/${user.id}/profile`);

    expect(res.status).toBe(404);
  });

  it('never carries the end', async () => {
    const user = createUser();

    const res = await request(app).get(`/api/users/${user.id}/profile`);

    expect(res.body.data).not.toHaveProperty('suspendedUntil');
    expect(res.body.data).not.toHaveProperty('suspended_until');
  });
});

describe('the suspension sweep', () => {
  const { sweepSuspensions } = require('../src/utils/sweepSuspensions');
  const User = require('../src/models/User');

  const auditOf = async (root) =>
    (await request(app).get('/api/audit?action=suspension_expired').set(authHeader(root))).body.data;
  const rowOf = (user) => db.prepare('SELECT status, suspended_until FROM users WHERE id = ?').get(user.id);
  const sweepAt = (offsetMs = 0) => sweepSuspensions(new Date(Date.now() + offsetMs).toISOString());

  it('lifts every expired suspension and logs each as the server', async () => {
    const root = admin();
    const first = suspendedFor(-DAY_MS);
    const second = suspendedFor(-60_000);

    const lifted = sweepAt();
    const log = await auditOf(root);

    expect(lifted).toBe(2);
    expect(rowOf(first)).toEqual({ status: 'normal', suspended_until: null });
    expect(rowOf(second)).toEqual({ status: 'normal', suspended_until: null });
    expect(log.map((entry) => entry.targetUser.username).sort()).toEqual([first.username, second.username].sort());
    expect(log.every((entry) => entry.actor.id === null)).toBe(true);
  });

  it('lifts by the injected clock, not the real one', async () => {
    const root = admin();
    const user = suspendedFor(5 * DAY_MS);

    expect(sweepAt(4 * DAY_MS)).toBe(0);
    expect(rowOf(user).status).toBe('suspended');

    expect(sweepAt(6 * DAY_MS)).toBe(1);
    expect(rowOf(user).status).toBe('normal');
    expect(await auditOf(root)).toHaveLength(1);
  });

  it('leaves future-end and no-end suspensions alone', async () => {
    const root = admin();
    const future = suspendedFor(DAY_MS);
    const open = createUser({ status: 'suspended' });

    expect(sweepAt()).toBe(0);

    expect(rowOf(future).status).toBe('suspended');
    expect(rowOf(open).status).toBe('suspended');
    expect(await auditOf(root)).toHaveLength(0);
  });

  it('logs a lift once across repeated sweeps', async () => {
    const root = admin();
    suspendedFor(-60_000);

    sweepAt();
    expect(sweepAt()).toBe(0);

    expect(await auditOf(root)).toHaveLength(1);
  });

  it('carries on past a row whose lift throws', async () => {
    const root = admin();
    const bad = suspendedFor(-DAY_MS);
    const good = suspendedFor(-60_000);
    const real = User.liftSuspensionIfExpired;
    const lift = vi.spyOn(User, 'liftSuspensionIfExpired').mockImplementation((id, now) => {
      if (id === bad.id) throw new Error('disk full');
      return real(id, now);
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(sweepAt()).toBe(1);
    } finally {
      lift.mockRestore();
      quiet.mockRestore();
    }

    expect(rowOf(bad).status).toBe('suspended');
    expect(rowOf(good).status).toBe('normal');
    expect((await auditOf(root)).map((entry) => entry.targetUser.username)).toEqual([good.username]);
  });

  it('never throws when the read itself fails', () => {
    const read = vi.spyOn(User, 'expiredSuspensions').mockImplementation(() => { throw new Error('locked'); });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(sweepAt()).toBe(0);
    } finally {
      read.mockRestore();
      quiet.mockRestore();
    }
  });
});
