import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { PLACEHOLDER_ID } = require('../src/config/accountDeletion');

/**
 * Trusted authors: an admin marks an account, and while review is on its new listings go live at once
 * and are logged as auto-approvals for mods to spot-check.
 */

const tag = () => Math.random().toString(16).slice(2, 8);
const admin = () => createUser({ username: `admin-${tag()}`, accountType: 'admin' });
const mod = () => createUser({ username: `mod-${tag()}`, accountType: 'mod' });
const person = (name) => createUser({ username: `${name}-${tag()}` });

const trust = (actor, userId) => request(app).put(`/api/users/${userId}/trust`).set(authHeader(actor));
const untrust = (actor, userId) => request(app).delete(`/api/users/${userId}/trust`).set(authHeader(actor));

const reviewOn = async () => {
  const res = await request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value: true });
  expect(res.status).toBe(200);
};

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const readOne = (id, user) => request(app).get(`/api/worlds/${id}`).set(authHeader(user));

const auditOf = async (action) =>
  (await request(app).get(`/api/audit?action=${action}`).set(authHeader(admin()))).body.data;

const staffRow = async (user) => {
  const res = await request(app).get(`/api/users?search=${user.username}`).set(authHeader(mod()));
  return res.body.data.find((row) => row.id === user.id);
};

const autoList = (user, query = '') => {
  const req = request(app).get(`/api/reviews/auto${query}`);
  return user ? req.set(authHeader(user)) : req;
};

describe('granting and revoking trust', () => {
  it('is an admin\'s, shows on the staff user list, and is logged with the account id', async () => {
    const author = person('author');

    const res = await trust(admin(), author.id);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: author.id, username: author.username });
    expect(res.body.user.trustedAt).toBeTruthy();
    expect((await staffRow(author)).trustedAt).toBe(res.body.user.trustedAt);

    const log = await auditOf('author_trusted');
    expect(log).toHaveLength(1);
    expect(log[0].target).toMatchObject({ kind: 'account', name: author.username, id: author.id });
    expect(log[0].targetUser).toMatchObject({ id: author.id });
  });

  it('is revoked by an admin, which clears the mark and is logged', async () => {
    const author = person('author');
    await trust(admin(), author.id);

    const res = await untrust(admin(), author.id);

    expect(res.status).toBe(200);
    expect(res.body.user.trustedAt).toBeNull();
    expect((await staffRow(author)).trustedAt).toBeNull();
    const log = await auditOf('author_untrusted');
    expect(log).toHaveLength(1);
    expect(log[0].target.id).toBe(author.id);
  });

  it('refuses a mod either way, and changes nothing', async () => {
    const author = person('author');
    const granted = person('granted');
    await trust(admin(), granted.id);

    expect((await trust(mod(), author.id)).status).toBe(403);
    expect((await untrust(mod(), granted.id)).status).toBe(403);

    expect((await staffRow(author)).trustedAt).toBeNull();
    expect((await staffRow(granted)).trustedAt).toBeTruthy();
  });

  it('refuses a normal account', async () => {
    expect((await trust(person('player'), person('author').id)).status).toBe(403);
  });

  it('keeps the first grant time and logs a repeat grant or revoke as nothing', async () => {
    const author = person('author');
    const first = (await trust(admin(), author.id)).body.user.trustedAt;

    const again = await trust(admin(), author.id);
    expect(again.status).toBe(200);
    expect(again.body.user.trustedAt).toBe(first);
    expect(await auditOf('author_trusted')).toHaveLength(1);

    await untrust(admin(), author.id);
    expect((await untrust(admin(), author.id)).status).toBe(200);
    expect(await auditOf('author_untrusted')).toHaveLength(1);
  });

  it('answers 404 for an unknown account and 403 for the reserved one', async () => {
    expect((await trust(admin(), 'no-such-user')).status).toBe(404);
    expect((await trust(admin(), PLACEHOLDER_ID)).status).toBe(403);
  });

  it('never shows on the public profile', async () => {
    const author = person('author');
    await trust(admin(), author.id);

    const byId = await request(app).get(`/api/users/${author.id}/profile`).set(authHeader(person('player')));
    const byName = await request(app).get(`/api/users/by-username/${author.username}/profile`);

    expect(byId.status).toBe(200);
    expect(byName.status).toBe(200);
    expect(JSON.stringify(byId.body)).not.toMatch(/trust/i);
    expect(JSON.stringify(byName.body)).not.toMatch(/trust/i);
  });
});

describe('a trusted author\'s new listing', () => {
  it('goes live at once while review is on, and is logged as an auto-approval with its id', async () => {
    await reviewOn();
    const author = person('author');
    await trust(admin(), author.id);

    const id = (await publish(author, { name: 'Trusted Landing' })).body.data.id;

    expect((await readOne(id, author)).body.data.moderation_state).toBe('approved');
    expect((await readOne(id, person('player'))).status).toBe(200);
    const log = await auditOf('listing_auto_approved');
    expect(log).toHaveLength(1);
    expect(log[0].target).toMatchObject({ id, name: 'Trusted Landing' });
    expect(log[0].actor.id).toBe(author.id);
  });

  it('waits for review again once trust is revoked, with the same session', async () => {
    await reviewOn();
    const author = person('author');
    await trust(admin(), author.id);
    await untrust(admin(), author.id);

    const id = (await publish(author)).body.data.id;

    expect((await readOne(id, author)).body.data.moderation_state).toBe('pending');
    expect((await readOne(id, person('player'))).status).toBe(404);
    expect(await auditOf('listing_auto_approved')).toHaveLength(0);
  });

  it('logs no auto-approval while review is off', async () => {
    const author = person('author');
    await trust(admin(), author.id);

    await publish(author);

    expect(await auditOf('listing_auto_approved')).toHaveLength(0);
  });
});

describe('the auto-approval list', () => {
  it('lists trusted and staff uploads newest first, each with its listing id', async () => {
    await reviewOn();
    const author = person('author');
    await trust(admin(), author.id);
    const staff = mod();

    const older = (await publish(author, { name: 'Older Landing' })).body.data.id;
    const newer = (await publish(staff, { name: 'Newer Landing' })).body.data.id;
    await publish(person('normal'), { name: 'Waiting Landing' });

    const res = await autoList(mod());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.entries.map((row) => row.targetId)).toEqual([newer, older]);
    expect(res.body.entries[0]).toMatchObject({
      targetName: 'Newer Landing',
      actor: { id: staff.id, username: staff.username, role: 'mod' }
    });
    expect(res.body.entries[1].actor).toMatchObject({ id: author.id, role: null });
  });

  it('pages', async () => {
    await reviewOn();
    const staff = mod();
    await publish(staff, { name: 'First Landing' });
    await publish(staff, { name: 'Second Landing' });

    const res = await autoList(mod(), '?limit=1&page=2');

    expect(res.body.total).toBe(2);
    expect(res.body.entries.map((row) => row.targetName)).toEqual(['First Landing']);
  });

  it('is staff-only', async () => {
    expect((await autoList(person('player'))).status).toBe(403);
    expect((await autoList(null)).status).toBe(401);
  });
});
