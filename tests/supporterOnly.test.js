import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, db, paths } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');

/**
 * Supporter-only listings: the staff flag, the public route's refusal, the gated route for each kind of
 * caller, revocation, and the entitlement route. Route-test style follows `mascotKind.test.js`.
 */

const SINCE = '2026-03-01T00:00:00.000+00:00';

const linkAs = (user, tier) => PatreonLink.link({
  userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart: tier ? SINCE : null, checkedAt: new Date().toISOString()
});

const supporter = (tier = 'supporter') => {
  const user = createUser();
  linkAs(user, tier);
  return user;
};

const staffUser = () => createUser({ accountType: 'admin' });

/** A published world, flagged Supporter-only by staff unless `flag` is false. */
const listing = async ({ author = createUser(), flag = true, overrides = {} } = {}) => {
  const created = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(overrides));
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  if (flag) expect((await setFlag(staffUser(), id, true)).status).toBe(200);
  return { id, author };
};

const setFlag = (user, id, supporterOnly) =>
  request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(user)).send({ supporterOnly });

const gated = (id, user) => {
  const req = request(app).get(`/api/worlds/${id}/supporter-content`);
  return user ? req.set(authHeader(user)) : req;
};

const entitlement = (user) => {
  const req = request(app).get('/api/supporter-content/entitlement');
  return user ? req.set(authHeader(user)) : req;
};

const revoke = (actor, target) =>
  request(app).put(`/api/users/${target.id}/supporter-content-access`).set(authHeader(actor));
const restore = (actor, target) =>
  request(app).delete(`/api/users/${target.id}/supporter-content-access`).set(authHeader(actor));

const detail = async (id) => (await request(app).get(`/api/worlds/${id}`)).body.data;

describe('marking a listing Supporter-only', () => {
  it.each(['mod', 'dev', 'admin'])('lets a %s set and clear the flag', async (accountType) => {
    const { id } = await listing({ flag: false });
    const staff = createUser({ accountType });

    expect((await setFlag(staff, id, true)).body.data).toEqual({ id, supporterOnly: true });
    expect((await detail(id)).supporter_only).toBe(true);

    expect((await setFlag(staff, id, false)).status).toBe(200);
    expect((await detail(id)).supporter_only).toBe(false);
  });

  it("refuses the listing's own author and any other account", async () => {
    const { id, author } = await listing({ flag: false });

    expect((await setFlag(author, id, true)).status).toBe(403);
    expect((await setFlag(createUser(), id, true)).status).toBe(403);
    expect((await detail(id)).supporter_only).toBe(false);
  });

  it('refuses a signed-out caller', async () => {
    const { id } = await listing({ flag: false });

    const res = await request(app).put(`/api/worlds/${id}/supporter-only`).send({ supporterOnly: true });
    expect(res.status).toBe(401);
  });

  it('refuses a body without a boolean, and a listing that is not there', async () => {
    const { id } = await listing({ flag: false });

    expect((await setFlag(staffUser(), id, 'yes')).status).toBe(400);
    expect((await setFlag(staffUser(), 'no-such-listing', true)).status).toBe(404);
  });

  it('carries the flag in the catalog and the detail payload', async () => {
    const flagged = await listing();
    const plain = await listing({ flag: false });

    const catalog = (await request(app).get('/api/worlds')).body.data;
    expect(catalog.find((w) => w.id === flagged.id).supporter_only).toBe(true);
    expect(catalog.find((w) => w.id === plain.id).supporter_only).toBe(false);
    expect((await detail(flagged.id)).supporter_only).toBe(true);
  });

  it('keeps the revision, and keeps details public', async () => {
    const { id } = await listing({ flag: false });
    const before = db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision;

    await setFlag(staffUser(), id, true);

    expect(db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision).toBe(before);
    expect((await request(app).get(`/api/worlds/${id}`)).status).toBe(200);
  });

  it('moves the content into the private area and back', async () => {
    const { id } = await listing({ flag: false });
    const publicFile = path.join(paths.WORLDS_DIR, `${id}.json`);
    const privateFile = path.join(paths.SUPPORTER_PRIVATE_DIR, `${id}.json`);
    expect(fs.existsSync(publicFile)).toBe(true);

    await setFlag(staffUser(), id, true);
    expect(fs.existsSync(publicFile)).toBe(false);
    expect(fs.existsSync(privateFile)).toBe(true);

    await setFlag(staffUser(), id, false);
    expect(fs.existsSync(publicFile)).toBe(true);
    expect(fs.existsSync(privateFile)).toBe(false);
  });

  it("writes an author's new content to the private area and bumps the revision", async () => {
    const { id, author } = await listing();
    const before = db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision;
    const contentData = { ...worldPayload().contentData, stats: ['revised'] };

    const res = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData });

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(paths.WORLDS_DIR, `${id}.json`))).toBe(false);
    expect(db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision).toBe(before + 1);
    expect((await gated(id, author)).body.data.contentData.stats).toEqual(['revised']);
  });
});

describe('the update reply', () => {
  const MARK = 'update-reply-marker';
  const withMark = () => ({ ...worldPayload().contentData, stats: [MARK] });

  it('carries no content for the author or a moderator on a Supporter-only listing', async () => {
    const { id, author } = await listing();
    const mod = createUser({ accountType: 'mod' });

    const asAuthor = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: withMark() });
    const emptyAsMod = await request(app).put(`/api/worlds/${id}`).set(authHeader(mod)).send({});

    for (const res of [asAuthor, emptyAsMod]) {
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data).not.toHaveProperty('contentData');
      expect(res.text).not.toContain(MARK);
    }
  });

  it('carries no content when the update is held for review', async () => {
    const { id, author } = await listing();
    const admin = staffUser();
    const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
    expect((await setReview(true)).status).toBe(200);

    try {
      const res = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: withMark() });
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('contentData');
      expect(res.text).not.toContain(MARK);
    } finally {
      await setReview(false);
    }
  });

  it('still carries the content on a listing that is not Supporter-only (control)', async () => {
    const { id, author } = await listing({ flag: false });

    const res = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: withMark() });

    expect(res.status).toBe(200);
    expect(res.body.data.contentData.stats).toEqual([MARK]);
  });
});

describe('an update held for review on a Supporter-only listing', () => {
  it('is readable by staff, and an approved update lands in the private area', async () => {
    const { id, author } = await listing();
    const admin = staffUser();
    const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
    expect((await setReview(true)).status).toBe(200);

    try {
      const contentData = { ...worldPayload().contentData, stats: ['held'] };
      expect((await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData })).status).toBe(200);

      const held = await request(app).get(`/api/reviews/${id}/content`).set(authHeader(admin));
      expect(held.status).toBe(200);
      expect(held.body.data.contentData.stats).toEqual(['held']);

      expect((await request(app).post(`/api/reviews/${id}/approve`).set(authHeader(admin)).send({})).status).toBe(200);
      expect(fs.existsSync(path.join(paths.WORLDS_DIR, `${id}.json`))).toBe(false);
      expect((await gated(id, author)).body.data.contentData.stats).toEqual(['held']);
    } finally {
      await setReview(false);
    }
  });
});

describe('the public content route', () => {
  it('serves an unflagged listing (control)', async () => {
    const { id } = await listing({ flag: false });

    const res = await request(app).get(`/api/worlds/${id}/content`);
    expect(res.status).toBe(200);
  });

  it('refuses a Supporter-only listing with a 403 to every caller, without counting a download', async () => {
    const { id, author } = await listing();
    const callers = [null, createUser(), supporter(), author, staffUser()];

    for (const caller of callers) {
      const req = request(app).get(`/api/worlds/${id}/content`);
      const res = await (caller ? req.set(authHeader(caller)) : req);
      expect(res.status).toBe(403);
    }
    expect(db.prepare('SELECT downloads FROM worlds WHERE id = ?').get(id).downloads).toBe(0);
  });

  it('refuses it as a required dependency too', async () => {
    const source = await listing({ overrides: { kind: 'entity' } });
    const owner = createUser();
    const world = await listing({ author: owner, flag: false });
    const link = await request(app).put(`/api/worlds/${world.id}/dependencies`).set(authHeader(owner))
      .send({ sourceIds: [source.id] });
    expect(link.status).toBe(200);

    const res = await request(app).get(`/api/worlds/${world.id}/dependencies/${source.id}/content`);
    expect(res.status).toBe(403);
  });
});

describe('the gated content route', () => {
  it.each([['Supporter', 'supporter'], ['Supporter+', 'supporter_plus']])('serves a %s account', async (_name, tier) => {
    const { id } = await listing();

    const res = await gated(id, supporter(tier));

    expect(res.status).toBe(200);
    expect(res.body.data.contentData).toEqual(worldPayload().contentData);
    expect(db.prepare('SELECT downloads FROM worlds WHERE id = ?').get(id).downloads).toBe(1);
  });

  it('refuses a signed-out caller', async () => {
    const { id } = await listing();

    expect((await gated(id)).status).toBe(401);
  });

  it('refuses a signed-in account with no Patreon link', async () => {
    const { id } = await listing();

    expect((await gated(id, createUser())).status).toBe(403);
  });

  it('refuses a lapsed account, and serves it again once it pledges', async () => {
    const { id } = await listing();
    const member = supporter();
    expect((await gated(id, member)).status).toBe(200);

    linkAs(member, null);
    expect((await gated(id, member)).status).toBe(403);

    linkAs(member, 'supporter');
    expect((await gated(id, member)).status).toBe(200);
  });

  it('refuses a revoked account, and serves it again when restored', async () => {
    const { id } = await listing();
    const member = supporter('supporter_plus');
    const staff = staffUser();

    await revoke(staff, member);
    expect((await gated(id, member)).status).toBe(403);

    await restore(staff, member);
    expect((await gated(id, member)).status).toBe(200);
  });

  it('serves the listing\'s author and staff whatever their tier', async () => {
    const { id, author } = await listing();

    expect((await gated(id, author)).status).toBe(200);
    expect((await gated(id, staffUser())).status).toBe(200);
  });

  it('serves an unflagged listing to nobody', async () => {
    const { id } = await listing({ flag: false });

    expect((await gated(id, supporter())).status).toBe(404);
  });

  it('answers a quarantined or missing listing as not found', async () => {
    const { id } = await listing();
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(staffUser())).send({});

    expect((await gated(id, supporter())).status).toBe(404);
    expect((await gated('no-such-listing', supporter())).status).toBe(404);
  });

  it('reads the gate live, so content installed before a clear is public again after it', async () => {
    const { id } = await listing();
    await setFlag(staffUser(), id, false);

    expect((await gated(id, supporter())).status).toBe(404);
    expect((await request(app).get(`/api/worlds/${id}/content`)).status).toBe(200);
  });
});

describe('revoking Supporter content access', () => {
  it.each(['mod', 'dev', 'admin'])('lets a %s revoke and restore', async (accountType) => {
    const member = supporter();
    const staff = createUser({ accountType });

    const revoked = await revoke(staff, member);
    expect(revoked.status).toBe(200);
    expect(revoked.body.user.supporterContentRevokedAt).toBeTruthy();

    const restored = await restore(staff, member);
    expect(restored.status).toBe(200);
    expect(restored.body.user.supporterContentRevokedAt).toBeNull();
  });

  it('refuses an ordinary account, and a signed-out caller', async () => {
    const member = supporter();

    expect((await revoke(createUser(), member)).status).toBe(403);
    expect((await restore(createUser(), member)).status).toBe(403);
    expect((await request(app).put(`/api/users/${member.id}/supporter-content-access`)).status).toBe(401);
    expect(db.prepare('SELECT supporter_content_revoked_at AS at FROM users WHERE id = ?').get(member.id).at).toBeNull();
  });

  it('refuses a moderator revoking an administrator, and an unknown account', async () => {
    const mod = createUser({ accountType: 'mod' });

    expect((await revoke(mod, staffUser())).status).toBe(403);
    expect((await revoke(mod, { id: 'no-such-user' })).status).toBe(404);
  });

  it('leaves Supporter Flair and the Supporters wall as they were', async () => {
    const member = supporter('supporter_plus');
    const profile = async () => (await request(app).get(`/api/users/${member.id}/profile`)).body.data.supporter;
    const wall = async () => (await request(app).get('/api/patreon/supporters')).body.data;
    const flair = await profile();
    const listed = await wall();
    expect(flair).toEqual({ tier: 'supporter_plus', since: SINCE });

    await revoke(staffUser(), member);

    expect(await profile()).toEqual(flair);
    expect(await wall()).toEqual(listed);
    expect(listed.map((entry) => entry.id)).toContain(member.id);
  });

  it('leaves the account able to sign in and use the site', async () => {
    const member = supporter();
    await revoke(staffUser(), member);

    expect((await request(app).get('/api/users/me').set(authHeader(member))).status).toBe(200);
  });
});

describe('the entitlement route', () => {
  it('refuses a signed-out caller', async () => {
    expect((await entitlement()).status).toBe(401);
  });

  it.each([
    ['an account with no link', () => createUser()],
    ['a lapsed account', () => { const u = createUser(); linkAs(u, null); return u; }]
  ])('answers %s with no entitlement', async (_name, make) => {
    await listing();

    const res = await entitlement(make());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ qualifies: false, items: [] });
  });

  it('lists each Supporter-only listing with its id, kind and revision', async () => {
    db.prepare('UPDATE worlds SET supporter_only = 0').run();
    const first = await listing();
    const second = await listing();
    await listing({ flag: false });

    const res = await entitlement(supporter());

    expect(res.body.data.qualifies).toBe(true);
    expect(res.body.data.items).toEqual(expect.arrayContaining([
      { id: first.id, kind: 'world', revision: 1 },
      { id: second.id, kind: 'world', revision: 1 }
    ]));
    expect(res.body.data.items).toHaveLength(2);
  });

  it('shows a revision bump in the next read', async () => {
    const { id, author } = await listing();
    const member = supporter();
    const revisionOf = async () => (await entitlement(member)).body.data.items.find((item) => item.id === id).revision;
    const before = await revisionOf();

    await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ name: 'Renamed' });

    expect(await revisionOf()).toBe(before + 1);
  });

  it('answers a revoked account with no entitlement, and a restored one with it back', async () => {
    const { id } = await listing();
    const member = supporter();

    await revoke(staffUser(), member);
    expect((await entitlement(member)).body.data).toEqual({ qualifies: false, items: [] });

    await restore(staffUser(), member);
    expect((await entitlement(member)).body.data.items.map((item) => item.id)).toContain(id);
  });

  it('is tier-based for staff and authors, who get no special items', async () => {
    await listing();

    expect((await entitlement(staffUser())).body.data).toEqual({ qualifies: false, items: [] });
  });

  it('leaves out a quarantined listing', async () => {
    const { id } = await listing();
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(staffUser())).send({});

    const res = await entitlement(supporter());
    expect(res.body.data.items.map((item) => item.id)).not.toContain(id);
  });
});
