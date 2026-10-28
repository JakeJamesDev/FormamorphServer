import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, db, paths } from './context.js';
import { createUser, authHeader, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const World = require('../src/models/World');
const PatreonLink = require('../src/models/PatreonLink');
const PendingUpdate = require('../src/models/PendingUpdate');

/**
 * An admin's app publish of a Supporter-only listing: never public, admin only, and revisions that reach
 * Supporters through the normal update route.
 */

afterEach(() => vi.restoreAllMocks());

const layer = async (color) => `data:image/png;base64,${(await sharp({ create: { width: 32, height: 32, channels: 4, background: color } }).png().toBuffer()).toString('base64')}`;

const mascotPayload = async (overrides = {}) => ({
  name: 'Fixture Mascot',
  kind: 'mascot',
  thumbnail: TINY_PNG,
  supporterOnly: true,
  contentData: { rig: { parts: ['base'] }, transition: 'fade', layers: { base: await layer('#c84') } },
  ...overrides
});

const admin = () => createUser({ accountType: 'admin' });
const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);
const put = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const row = (id) => db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);
const worldCount = () => db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;
const privateFiles = () => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR);
const cacheFiles = (id) => privateFiles().filter((name) => name.startsWith(`processed-${id}-`));

const supporter = () => {
  const user = createUser();
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00', checkedAt: new Date().toISOString() });
  return user;
};

const reviewSetting = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value });

describe('an admin publishing Supporter-only from the app', () => {
  it('creates the listing Supporter-only, pinned and approved, with no content in the reply', async () => {
    const author = admin();
    const res = await post(author, await mascotPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.contentData).toBeUndefined();
    const stored = row(res.body.data.id);
    expect(stored).toMatchObject({ kind: 'mascot', supporter_only: 1, moderation_state: 'approved', author_id: author.id });
    expect(stored.pinned_at).toBeTruthy();
    expect(fs.existsSync(path.join(paths.SUPPORTER_PRIVATE_DIR, stored.content_file))).toBe(true);
    expect(fs.existsSync(path.join(paths.WORLDS_DIR, stored.content_file))).toBe(false);
    expect((await request(app).get(`/api/worlds/${stored.id}/content`)).status).toBe(403);
  });

  it('writes the content to the private area before the row exists', async () => {
    const create = World.create;
    let atInsert = null;
    vi.spyOn(World, 'create').mockImplementation((data, contentFile, thumbnailFile) => {
      atInsert = {
        public: fs.existsSync(path.join(paths.WORLDS_DIR, contentFile)),
        private: fs.existsSync(path.join(paths.SUPPORTER_PRIVATE_DIR, contentFile))
      };
      return create(data, contentFile, thumbnailFile);
    });

    expect((await post(admin(), await mascotPayload())).status).toBe(201);
    expect(atInsert).toEqual({ public: false, private: true });
  });

  it('commits no row and removes its files when a step of the create fails', async () => {
    vi.spyOn(World, 'pin').mockImplementation(() => { throw new Error('pin failed'); });
    const before = worldCount();
    const privateBefore = privateFiles().length;

    const res = await post(admin(), await mascotPayload({ name: 'Rolled Back' }));

    expect(res.status).toBe(500);
    expect(worldCount()).toBe(before);
    expect(privateFiles()).toHaveLength(privateBefore);
  });

  it('is approved at once with Listing Review on', async () => {
    await reviewSetting(true);
    try {
      const res = await post(admin(), await mascotPayload());
      expect(row(res.body.data.id).moderation_state).toBe('approved');
    } finally {
      await reviewSetting(false);
    }
  });

  it.each(['mod', 'dev', 'player'])('refuses a %s and writes nothing', async (accountType) => {
    const user = accountType === 'player' ? createUser() : createUser({ accountType });
    const before = worldCount();
    const privateBefore = privateFiles().length;

    const res = await post(user, await mascotPayload());

    expect(res.status).toBe(403);
    expect(worldCount()).toBe(before);
    expect(privateFiles()).toHaveLength(privateBefore);
  });

  it('refuses a flag that is not a boolean, and a contest entry', async () => {
    const notBoolean = await post(admin(), await mascotPayload({ supporterOnly: 'yes' }));
    expect(notBoolean.status).toBe(400);
    expect(notBoolean.body.error).toMatch(/must be a boolean/);
    const entry = await post(admin(), await mascotPayload({ contestEventId: 'any-event' }));
    expect(entry.status).toBe(400);
    expect(entry.body.error).toMatch(/Supporter-only listing cannot be entered/);
  });

  it("publishes an admin's listing public without the flag (control)", async () => {
    const res = await post(admin(), await mascotPayload({ supporterOnly: false }));

    expect(res.status).toBe(201);
    expect(row(res.body.data.id)).toMatchObject({ supporter_only: 0, pinned_at: null });
    expect(res.body.data.contentData).toBeTruthy();
  });
});

describe("a revision of an admin's Supporter-only listing", () => {
  it('stays private, bumps the revision, retires the old copies and reaches a Supporter', async () => {
    const author = admin();
    const id = (await post(author, await mascotPayload())).body.data.id;
    const fan = supporter();
    const gated = () => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(fan));

    expect((await gated()).body.data.contentData.transition).toBe('fade');
    const firstCopies = cacheFiles(id);
    expect(firstCopies).toHaveLength(1);
    const before = row(id).revision;

    const update = await put(author, id, { contentData: { rig: { parts: ['base'] }, transition: 'slide', layers: { base: await layer('#48c') } } });

    expect(update.status).toBe(200);
    expect(update.body.data.contentData).toBeUndefined();
    const stored = row(id);
    expect(stored.revision).toBe(before + 1);
    expect(fs.existsSync(path.join(paths.WORLDS_DIR, stored.content_file))).toBe(false);

    const entitlement = await request(app).get('/api/supporter-content/entitlement').set(authHeader(fan));
    expect(entitlement.body.data.items).toContainEqual({ id, kind: 'mascot', revision: before + 1 });

    expect((await gated()).body.data.contentData.transition).toBe('slide');
    expect(cacheFiles(id)).toHaveLength(1);
    expect(cacheFiles(id)).not.toContain(firstCopies[0]);
  });

  it("is offered in the author's own listings, as the update target", async () => {
    const author = admin();
    const id = (await post(author, await mascotPayload())).body.data.id;

    const mine = await request(app).get('/api/users/me/worlds?kind=mascot').set(authHeader(author));

    expect(mine.status).toBe(200);
    const entry = mine.body.data.find((w) => (w._id || w.id) === id);
    expect(entry).toBeTruthy();
    expect(entry.contentData).toBeUndefined();
  });

  it('applies at once with Listing Review on, and holds nothing', async () => {
    const author = admin();
    const id = (await post(author, await mascotPayload())).body.data.id;
    await reviewSetting(true);
    try {
      const update = await put(author, id, { contentData: { rig: { parts: ['base'] }, transition: 'slide', layers: { base: await layer('#48c') } } });

      expect(update.status).toBe(200);
      expect(update.body.data.contentData).toBeUndefined();
      expect(PendingUpdate.findByWorldId(id)).toBeFalsy();
      expect(row(id).moderation_state).toBe('approved');
    } finally {
      await reviewSetting(false);
    }
  });
});
