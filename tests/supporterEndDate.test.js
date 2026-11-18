import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, db, paths } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');
const { sweepSupporterExpiry } = require('../src/utils/sweepSupporterExpiry');
const { isSupporterOnlyNow } = require('../src/utils/supporterWindow');

/**
 * The timed end of a Supporter-only listing: the end date on create and on the Supporter-only route, the
 * read-time expiry, the sweep, and the entitlement route's expired list. The clock is the fake `Date`.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-12-01T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const admin = () => createUser({ accountType: 'admin' });
const supporter = () => {
  const user = createUser();
  PatreonLink.link({
    userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00', checkedAt: new Date().toISOString()
  });
  return user;
};

const publish = (user, overrides = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload({ supporterOnly: true, ...overrides }));
const flag = (user, id, body) =>
  request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(user)).send(body);
const publicContent = (id) => request(app).get(`/api/worlds/${id}/content`);
const gated = (id, user) => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(user));
const entitlement = (user) => request(app).get('/api/supporter-content/entitlement').set(authHeader(user));
const detail = async (id) => (await request(app).get(`/api/worlds/${id}`)).body.data;
const row = (id) => db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);
const audit = (id) => db.prepare('SELECT action, snippet FROM audit_log WHERE target_id = ? ORDER BY id').all(id);
const inDir = (dir, id) => fs.existsSync(path.join(dir, `${id}.json`));
const cacheFiles = (id) => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).filter((name) => name.startsWith(`processed-${id}-`));
const later = (ms) => vi.setSystemTime(new Date(START.getTime() + ms));

/** A Supporter-only world ending in `days` days, published by an admin. */
const timed = async (days = 1) => {
  const res = await publish(admin(), { supporterDays: days });
  expect(res.status).toBe(201);
  return res.body.data.id;
};

describe('an end date on create', () => {
  it('stores the end date as the duration from now', async () => {
    const id = await timed(5);

    expect(row(id)).toMatchObject({ supporter_only: 1, supporter_until: new Date(START.getTime() + 5 * DAY).toISOString() });
  });

  it('leaves no end date without a duration', async () => {
    const res = await publish(admin());

    expect(res.status).toBe(201);
    expect(row(res.body.data.id).supporter_until).toBeNull();
  });

  it('refuses a duration on a kind that cannot be timed, and writes nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;

    const res = await publish(admin(), { kind: 'dictionary', supporterDays: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Mascot or a World/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n).toBe(before);
  });

  it('refuses a duration from a non-admin, with or without the flag, and writes nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;
    const player = createUser();

    expect((await publish(player, { supporterDays: 3 })).status).toBe(403);
    expect((await publish(player, { supporterOnly: false, supporterDays: 3 })).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n).toBe(before);
  });

  it.each([0, -2, 1.5, 'ten', 99999])('refuses a duration of %s', async (supporterDays) => {
    expect((await publish(admin(), { supporterDays })).status).toBe(400);
  });

  it('refuses a duration on a listing that is not Supporter-only', async () => {
    expect((await publish(admin(), { supporterOnly: false, supporterDays: 3 })).status).toBe(400);
  });
});

describe('the Supporter-only route and the end date', () => {
  it('sets, changes and clears the end date, with an audit entry for each', async () => {
    const staff = admin();
    const id = await timed(5);

    const set = await flag(staff, id, { supporterOnly: true, supporterDays: 9 });
    expect(set.body.data.supporterUntil).toBe(new Date(START.getTime() + 9 * DAY).toISOString());
    expect(row(id).supporter_until).toBe(new Date(START.getTime() + 9 * DAY).toISOString());

    const until = new Date(START.getTime() + 20 * DAY).toISOString();
    await flag(staff, id, { supporterOnly: true, supporterUntil: until });
    expect(row(id).supporter_until).toBe(until);

    await flag(staff, id, { supporterOnly: true, supporterDays: null });
    expect(row(id)).toMatchObject({ supporter_only: 1, supporter_until: null });

    expect(audit(id).filter((entry) => entry.action === 'listing_supporter_until').map((entry) => entry.snippet))
      .toEqual([new Date(START.getTime() + 9 * DAY).toISOString(), until, 'none']);
  });

  it('puts an end date on a listing flagged in the same call', async () => {
    const created = await request(app).post('/api/worlds').set(authHeader(createUser())).send(worldPayload());
    const id = created.body.data.id;

    await flag(admin(), id, { supporterOnly: true, supporterDays: 4 });

    const until = new Date(START.getTime() + 4 * DAY).toISOString();
    expect(row(id).supporter_until).toBe(until);
    expect(audit(id)).toContainEqual({ action: 'listing_supporter_until', snippet: until });
  });

  it('refuses a past end date, a bad one, and both fields at once, changing nothing', async () => {
    const id = await timed(5);
    const staff = admin();
    const unchanged = row(id).supporter_until;

    const past = await flag(staff, id, { supporterOnly: true, supporterUntil: new Date(START.getTime() - DAY).toISOString() });
    expect(past.status).toBe(400);
    expect(past.body.error).toMatch(/future/);
    expect((await flag(staff, id, { supporterOnly: true, supporterUntil: 'someday' })).status).toBe(400);
    expect((await flag(staff, id, { supporterOnly: true, supporterDays: 2, supporterUntil: unchanged })).status).toBe(400);
    expect(row(id).supporter_until).toBe(unchanged);
    expect(audit(id).filter((entry) => entry.action === 'listing_supporter_until')).toHaveLength(0);
  });

  it('refuses an end date from anyone but an admin', async () => {
    const id = await timed(5);

    expect((await flag(createUser({ accountType: 'mod' }), id, { supporterOnly: true, supporterDays: 2 })).status).toBe(403);
    expect(row(id).supporter_until).toBe(new Date(START.getTime() + 5 * DAY).toISOString());
  });

  it('refuses an end date when the call clears the flag', async () => {
    const id = await timed(5);

    expect((await flag(admin(), id, { supporterOnly: false, supporterDays: 2 })).status).toBe(400);
    expect(row(id).supporter_only).toBe(1);
  });
});

describe('read-time expiry, with no sweep run', () => {
  it('refuses the public route before the end date and serves it after', async () => {
    const id = await timed(1);

    expect((await publicContent(id)).status).toBe(403);

    later(2 * DAY);

    expect(row(id).supporter_only).toBe(1);
    const res = await publicContent(id);
    expect(res.status).toBe(200);
    expect(res.body.data.contentData).toBeTruthy();
  });

  it('serves a required dependency after the end date', async () => {
    // A component cannot be timed through the API, so the end date is set on the row directly.
    const component = await request(app).post('/api/worlds').set(authHeader(createUser()))
      .send(worldPayload({ name: 'Marsh Warden', kind: 'entity' }));
    const dependency = component.body.data.id;
    await flag(admin(), dependency, { supporterOnly: true });
    db.prepare('UPDATE worlds SET supporter_until = ? WHERE id = ?').run(new Date(START.getTime() + DAY).toISOString(), dependency);
    const host = await request(app).post('/api/worlds').set(authHeader(createUser()))
      .send(worldPayload({ name: 'Host', requiredDependencies: [dependency] }));
    expect(host.status).toBe(201);
    const url = `/api/worlds/${host.body.data.id}/dependencies/${dependency}/content`;

    expect((await request(app).get(url)).status).toBe(403);
    later(2 * DAY);
    expect((await request(app).get(url)).status).toBe(200);
  });

  it('stops listing it as current and lists it as expired', async () => {
    const id = await timed(1);
    const fan = supporter();

    let state = (await entitlement(fan)).body.data;
    expect(state.items.map((item) => item.id)).toContain(id);
    expect(state.expired).toEqual([]);

    later(2 * DAY);

    state = (await entitlement(fan)).body.data;
    expect(state.items.map((item) => item.id)).not.toContain(id);
    expect(state.expired).toContainEqual({ id, kind: 'world', revision: row(id).revision });
  });

  it('lists nothing for an account that does not qualify', async () => {
    await timed(1);
    later(2 * DAY);

    expect((await entitlement(createUser())).body.data).toEqual({ qualifies: false, tier: null, items: [], expired: [] });
  });

  it('closes the gated route', async () => {
    const id = await timed(1);
    const fan = supporter();
    expect((await gated(id, fan)).status).toBe(200);

    later(2 * DAY);

    expect((await gated(id, fan)).status).toBe(404);
  });

  it('carries the end date in the catalog and details only while Supporter-only', async () => {
    const id = await timed(3);
    const until = new Date(START.getTime() + 3 * DAY).toISOString();

    const catalog = async () => (await request(app).get('/api/worlds')).body.data.find((w) => w.id === id);
    expect(await catalog()).toMatchObject({ supporter_only: true, supporter_until: until });
    expect(await detail(id)).toMatchObject({ supporter_only: true, supporter_until: until });

    later(4 * DAY);

    expect(await catalog()).toMatchObject({ supporter_only: false });
    expect(await catalog()).not.toHaveProperty('supporter_until');
    expect(await detail(id)).toMatchObject({ supporter_only: false });
    expect(await detail(id)).not.toHaveProperty('supporter_until');
  });

  it('keeps the expiry date out of the payload', async () => {
    const id = await timed(1);
    later(2 * DAY);
    await sweepSupporterExpiry();

    expect(await detail(id)).not.toHaveProperty('supporter_expired_at');
  });

  it('omits contentData from the update reply while Supporter-only and includes it after expiry', async () => {
    const staff = admin();
    const created = await publish(staff, { supporterDays: 1 });
    const id = created.body.data.id;
    const edit = () => request(app).put(`/api/worlds/${id}`).set(authHeader(staff)).send({ description: 'Edited' });

    const during = await edit();
    expect(during.status).toBe(200);
    expect(during.body.data.contentData).toBeUndefined();

    later(2 * DAY);

    const after = await edit();
    expect(after.status).toBe(200);
    expect(after.body.data.contentData).toBeTruthy();
  });
});

describe('the expiry sweep', () => {
  it('clears the flag, moves the file public, clears the cache and records the expiry', async () => {
    const id = await timed(1);
    const fan = supporter();
    await gated(id, fan);
    expect(cacheFiles(id)).toHaveLength(1);
    expect(inDir(paths.SUPPORTER_PRIVATE_DIR, id)).toBe(true);

    later(2 * DAY);

    expect(await sweepSupporterExpiry()).toBe(1);

    expect(row(id)).toMatchObject({
      supporter_only: 0,
      supporter_until: null,
      supporter_expired_at: new Date(START.getTime() + 2 * DAY).toISOString()
    });
    expect(inDir(paths.WORLDS_DIR, id)).toBe(true);
    expect(inDir(paths.SUPPORTER_PRIVATE_DIR, id)).toBe(false);
    expect(cacheFiles(id)).toHaveLength(0);
    expect(audit(id).map((entry) => entry.action)).toContain('listing_supporter_expired');
    expect((await publicContent(id)).status).toBe(200);
  });

  it('changes nothing on a second run', async () => {
    const id = await timed(1);
    later(2 * DAY);
    await sweepSupporterExpiry();
    const after = row(id);
    const entries = audit(id).length;

    expect(await sweepSupporterExpiry()).toBe(0);

    expect(row(id)).toEqual(after);
    expect(audit(id)).toHaveLength(entries);
  });

  it('leaves a listing whose end date is ahead, and one with no end date', async () => {
    const running = await timed(5);
    const open = (await publish(admin())).body.data.id;
    later(2 * DAY);

    expect(await sweepSupporterExpiry()).toBe(0);

    expect(row(running).supporter_only).toBe(1);
    expect(row(open).supporter_only).toBe(1);
  });
});

describe('a manual clear', () => {
  it('records the expiry and lists the listing as expired', async () => {
    const id = await timed(5);
    const fan = supporter();

    expect((await flag(admin(), id, { supporterOnly: false })).status).toBe(200);

    expect(row(id)).toMatchObject({ supporter_only: 0, supporter_until: null });
    expect(row(id).supporter_expired_at).toBe(START.toISOString());
    expect(inDir(paths.WORLDS_DIR, id)).toBe(true);
    expect((await entitlement(fan)).body.data.expired.map((item) => item.id)).toContain(id);
  });

  it('opens a listing whose date passed but whose sweep has not run', async () => {
    const id = await timed(1);
    later(2 * DAY);

    expect((await flag(admin(), id, { supporterOnly: false })).status).toBe(200);

    expect(row(id).supporter_expired_at).toBe(new Date(START.getTime() + 2 * DAY).toISOString());
    expect(inDir(paths.WORLDS_DIR, id)).toBe(true);
  });

  it('starts a fresh window when an expired listing is flagged again', async () => {
    const staff = admin();
    const id = await timed(1);
    later(2 * DAY);

    await flag(staff, id, { supporterOnly: true, supporterDays: 3 });

    expect(isSupporterOnlyNow(row(id))).toBe(true);
    expect(row(id)).toMatchObject({ supporter_until: new Date(START.getTime() + 5 * DAY).toISOString(), supporter_expired_at: null });
    expect((await publicContent(id)).status).toBe(403);
  });
});

describe('an edit after the end date and before the sweep', () => {
  it('survives the sweep', async () => {
    const staff = admin();
    const id = (await publish(staff, { supporterDays: 1 })).body.data.id;
    later(2 * DAY);
    const contentData = { ...worldPayload().contentData, worldOverview: { name: 'Edited after expiry' } };

    expect((await request(app).put(`/api/worlds/${id}`).set(authHeader(staff)).send({ contentData })).status).toBe(200);
    await sweepSupporterExpiry();

    expect((await publicContent(id)).body.data.contentData.worldOverview.name).toBe('Edited after expiry');
  });
});

describe('flagging a listing while a pending update links an image', () => {
  const LINK = 'https://cdn.example.com/art.png';
  const review = (value) =>
    request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value });

  afterEach(() => review(false));

  /** A live world with embedded art, then an author edit held for review. */
  const heldEdit = async (thumbnail) => {
    const author = createUser();
    const created = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload());
    const id = created.body.data.id;
    await review(true);
    const contentData = { ...worldPayload().contentData, worldOverview: { name: 'Held', thumbnail } };
    const edit = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData });
    expect(edit.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM pending_updates WHERE world_id = ?').get(id)).toBeTruthy();
    return id;
  };

  it('refuses, naming where each image sits, and leaves the listing public', async () => {
    const id = await heldEdit(LINK);

    const res = await flag(admin(), id, { supporterOnly: true });

    expect(res.status).toBe(400);
    expect(res.body.linkedImages).toEqual([{ where: 'World thumbnail', url: LINK }]);
    expect(row(id).supporter_only).toBe(0);
  });

  it('flags a listing whose pending update links nothing (control)', async () => {
    const id = await heldEdit(worldPayload().thumbnail);

    expect((await flag(admin(), id, { supporterOnly: true })).status).toBe(200);
    expect(row(id).supporter_only).toBe(1);
  });
});

describe('isSupporterOnlyNow', () => {
  it('is exact at the end date', () => {
    const listing = { supporter_only: 1, supporter_until: '2026-12-02T00:00:00.000Z' };
    const end = Date.parse(listing.supporter_until);

    expect(isSupporterOnlyNow(listing, end - 1)).toBe(true);
    expect(isSupporterOnlyNow(listing, end)).toBe(false);
    expect(isSupporterOnlyNow({ supporter_only: 0, supporter_until: listing.supporter_until }, end - 1)).toBe(false);
    expect(isSupporterOnlyNow({ supporter_only: 1, supporter_until: null }, end)).toBe(true);
  });
});
