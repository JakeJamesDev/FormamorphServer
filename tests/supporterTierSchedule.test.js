import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');
const { TIER_KEYS, tierRank } = require('../src/config/patreon');

/**
 * The tier schedule of a Supporter-only listing: the gated download by tier, the stages opening by the
 * clock alone, the admin create and edit forms, and the schedule in the payloads. The clock is the fake `Date`.
 */

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-12-01T12:00:00.000Z');
const at = (days) => new Date(START.getTime() + days * DAY).toISOString();
const later = (days) => vi.setSystemTime(new Date(START.getTime() + days * DAY));

const TOP = 'supporter_top';
const PLUS = 'supporter_plus';
const LOW = 'supporter';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const admin = () => createUser({ accountType: 'admin' });
const member = (tier) => {
  const user = createUser();
  PatreonLink.link({
    userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart: '2026-03-01T00:00:00.000+00:00', checkedAt: new Date().toISOString()
  });
  return user;
};

const publish = (user, overrides = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload({ supporterOnly: true, ...overrides }));
const flag = (user, id, body) =>
  request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(user)).send({ supporterOnly: true, ...body });
const gated = (id, user) => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(user));
const entitlement = (user) => request(app).get('/api/supporter-content/entitlement').set(authHeader(user));
const detail = async (id) => (await request(app).get(`/api/worlds/${id}`)).body.data;
const catalogEntry = async (id) => (await request(app).get('/api/worlds')).body.data.find((w) => w.id === id);
const rows = (id) => db.prepare('SELECT tier, opens_at FROM supporter_schedule WHERE world_id = ? ORDER BY tier').all(id);
const audit = (id) => db.prepare('SELECT action, snippet FROM audit_log WHERE target_id = ? ORDER BY id').all(id);

const THREE_STAGES = { days: { [TOP]: 5, [PLUS]: 5, [LOW]: 5 }, goPublic: true };

/** A Supporter-only world on the given schedule, published by an admin. */
const scheduled = async (supporterSchedule = THREE_STAGES, overrides = {}) => {
  const res = await publish(admin(), { supporterSchedule, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.id;
};

describe('tier ranking', () => {
  it('ranks every tier key by the tier list, lowest first', () => {
    expect(TIER_KEYS.map(tierRank)).toEqual(TIER_KEYS.map((_, index) => index));
    expect(tierRank(TOP)).toBeGreaterThan(tierRank(PLUS));
    expect(tierRank(PLUS)).toBeGreaterThan(tierRank(LOW));
    expect(tierRank(null)).toBe(-1);
  });
});

describe('a stage open to the top tier only', () => {
  it('admits the top tier and refuses the two lower tiers, naming the open tier and the date', async () => {
    const id = await scheduled();

    expect((await gated(id, member(TOP))).status).toBe(200);

    const plus = await gated(id, member(PLUS));
    expect(plus.status).toBe(403);
    expect(plus.body).toMatchObject({ requiredTier: TOP, opensAt: at(5) });
    expect(plus.body.error).toContain(TOP);
    expect(plus.body.error).toContain(at(5));

    const low = await gated(id, member(LOW));
    expect(low.status).toBe(403);
    expect(low.body).toMatchObject({ requiredTier: TOP, opensAt: at(10) });
  });

  it('keeps the plain refusal for an account with no tier', async () => {
    const id = await scheduled();

    const res = await gated(id, createUser());

    expect(res.status).toBe(403);
    expect(res.body.requiredTier).toBeUndefined();
  });
});

describe('each stage opens by the clock alone, with no sweep run', () => {
  it('opens the middle tier at its date and the lowest tier at its own', async () => {
    const id = await scheduled();
    const plus = member(PLUS);
    const low = member(LOW);

    later(5);
    expect((await gated(id, plus)).status).toBe(200);
    expect((await gated(id, low)).status).toBe(403);

    later(10);
    expect((await gated(id, low)).status).toBe(200);
  });

  it('is exact at the date', async () => {
    const id = await scheduled();
    const plus = member(PLUS);

    vi.setSystemTime(new Date(START.getTime() + 5 * DAY - 1));
    expect((await gated(id, plus)).status).toBe(403);
    later(5);
    expect((await gated(id, plus)).status).toBe(200);
  });

  it('opens a skipped stage with the next tier down', async () => {
    const id = await scheduled({ days: { [TOP]: 5, [LOW]: 5 }, goPublic: true });
    const plus = member(PLUS);

    expect(rows(id)).toEqual([{ tier: LOW, opens_at: at(5) }, { tier: PLUS, opens_at: at(5) }]);
    expect((await gated(id, plus)).status).toBe(403);
    later(5);
    expect((await gated(id, plus)).status).toBe(200);
  });

  it('goes public at the public date', async () => {
    const id = await scheduled();

    expect((await request(app).get(`/api/worlds/${id}/content`)).status).toBe(403);
    later(15);

    expect((await request(app).get(`/api/worlds/${id}/content`)).status).toBe(200);
    expect((await gated(id, member(LOW))).status).toBe(404);
  });
});

describe('a listing with no schedule rows', () => {
  it('opens to every tier at once, as before', async () => {
    const res = await publish(admin(), { supporterDays: 5 });
    const id = res.body.data.id;

    for (const tier of TIER_KEYS) expect((await gated(id, member(tier))).status).toBe(200);
    expect(rows(id)).toEqual([]);
    expect(await detail(id)).not.toHaveProperty('supporterSchedule');
  });
});

describe('no public date', () => {
  it('keeps the last stage open with no end, and the tiers below it closed', async () => {
    const id = await scheduled({ days: { [TOP]: 5 }, goPublic: false });
    const plus = member(PLUS);

    expect(rows(id)).toEqual([{ tier: LOW, opens_at: null }, { tier: PLUS, opens_at: null }]);
    expect(db.prepare('SELECT supporter_until FROM worlds WHERE id = ?').get(id).supporter_until).toBeNull();

    later(3650);
    expect((await gated(id, member(TOP))).status).toBe(200);
    const refused = await gated(id, plus);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ requiredTier: TOP, opensAt: null });
  });

  it('opens the lower tiers at the public date when a null date meets one', async () => {
    const id = await scheduled({ opensAt: { [PLUS]: null, [LOW]: null }, publicAt: at(8) });
    const plus = member(PLUS);

    expect((await gated(id, plus)).status).toBe(403);
    later(8);
    expect((await request(app).get(`/api/worlds/${id}/content`)).status).toBe(200);
  });
});

describe('staff and the listing author', () => {
  it('pass at every stage', async () => {
    const author = admin();
    const res = await publish(author, { supporterSchedule: THREE_STAGES });
    const id = res.body.data.id;

    expect((await gated(id, author)).status).toBe(200);
    expect((await gated(id, createUser({ accountType: 'mod' }))).status).toBe(200);
    expect((await gated(id, admin())).status).toBe(200);
  });
});

describe('the entitlement reply', () => {
  it('carries the account tier and the same lists for every qualifying tier', async () => {
    const id = await scheduled();

    const top = (await entitlement(member(TOP))).body.data;
    const low = (await entitlement(member(LOW))).body.data;

    expect(top.tier).toBe(TOP);
    expect(low.tier).toBe(LOW);
    expect(low.items).toEqual(top.items);
    expect(low.items.map((item) => item.id)).toContain(id);
    expect(low.expired).toEqual(top.expired);
    expect((await entitlement(createUser())).body.data.tier).toBeNull();
  });
});

describe('creating a schedule', () => {
  it('stores each lower tier as a row and the public date as supporter_until', async () => {
    const id = await scheduled();

    expect(rows(id)).toEqual([{ tier: LOW, opens_at: at(10) }, { tier: PLUS, opens_at: at(5) }]);
    expect(db.prepare('SELECT supporter_until FROM worlds WHERE id = ?').get(id).supporter_until).toBe(at(15));
    expect(audit(id).find((entry) => entry.action === 'listing_supporter_schedule').snippet)
      .toBe(`${PLUS}=${at(5)} ${LOW}=${at(10)} public=${at(15)}`);
  });

  it('refuses a non-admin, another kind, and a schedule on a public listing, writing nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;

    expect((await publish(createUser(), { supporterSchedule: THREE_STAGES })).status).toBe(403);
    expect((await publish(createUser(), { supporterOnly: false, supporterSchedule: THREE_STAGES })).status).toBe(403);
    const kind = await publish(admin(), { kind: 'dictionary', supporterSchedule: THREE_STAGES });
    expect(kind.status).toBe(400);
    expect(kind.body.error).toMatch(/Mascot or a World/);
    expect((await publish(admin(), { supporterOnly: false, supporterSchedule: THREE_STAGES })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n).toBe(before);
  });

  it.each([
    ['no stage', { days: {}, goPublic: true }],
    ['a bad day count', { days: { [TOP]: 0 }, goPublic: true }],
    ['an unknown tier', { days: { gold: 3 }, goPublic: true }],
    ['no goPublic', { days: { [TOP]: 3 } }],
    ['both forms', { days: { [TOP]: 3 }, goPublic: true, opensAt: {}, publicAt: null }],
    ['a missing tier key', { opensAt: { [PLUS]: null }, publicAt: null }],
    ['a lower tier before a higher one', { opensAt: { [PLUS]: at(9), [LOW]: at(4) }, publicAt: null }],
    ['a tier after the public date', { opensAt: { [PLUS]: at(3), [LOW]: at(30) }, publicAt: at(20) }],
    ['a public date in the past', { opensAt: { [PLUS]: null, [LOW]: null }, publicAt: at(-1) }]
  ])('refuses %s, writing nothing', async (_label, supporterSchedule) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;

    expect((await publish(admin(), { supporterSchedule })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n).toBe(before);
  });

  it('refuses a schedule beside supporterDays', async () => {
    expect((await publish(admin(), { supporterSchedule: THREE_STAGES, supporterDays: 3 })).status).toBe(400);
  });
});

describe('editing a schedule on the Supporter-only route', () => {
  it('replaces the schedule from the dates form, with one audit entry', async () => {
    const id = await scheduled();

    const res = await flag(admin(), id, { supporterSchedule: { opensAt: { [PLUS]: at(2), [LOW]: at(4) }, publicAt: at(6) } });

    expect(res.status).toBe(200);
    expect(res.body.data.supporterSchedule).toEqual([{ tier: PLUS, opensAt: at(2) }, { tier: LOW, opensAt: at(4) }]);
    expect(rows(id)).toEqual([{ tier: LOW, opens_at: at(4) }, { tier: PLUS, opens_at: at(2) }]);
    expect(db.prepare('SELECT supporter_until FROM worlds WHERE id = ?').get(id).supporter_until).toBe(at(6));
    expect(audit(id).filter((entry) => entry.action === 'listing_supporter_schedule')).toHaveLength(2);
  });

  it('counts the days form from now, and writes no entry for an unchanged schedule', async () => {
    const id = await scheduled();
    const staff = admin();
    later(2);

    await flag(staff, id, { supporterSchedule: { days: { [TOP]: 1, [PLUS]: 1 }, goPublic: true } });
    const entries = audit(id).length;
    expect(rows(id)).toEqual([{ tier: LOW, opens_at: null }, { tier: PLUS, opens_at: at(3) }]);
    await flag(staff, id, { supporterSchedule: { opensAt: { [PLUS]: at(3), [LOW]: null }, publicAt: at(4) } });

    expect(audit(id)).toHaveLength(entries);
  });

  it('moves a passed stage back into the future, until the listing goes public', async () => {
    const id = await scheduled();
    const plus = member(PLUS);
    later(6);
    expect((await gated(id, plus)).status).toBe(200);

    const res = await flag(admin(), id, { supporterSchedule: { opensAt: { [PLUS]: at(8), [LOW]: at(10) }, publicAt: at(15) } });

    expect(res.status).toBe(200);
    expect((await gated(id, plus)).status).toBe(403);
    later(8);
    expect((await gated(id, plus)).status).toBe(200);
  });

  it('refuses a public date that strands a stage, and an out-of-order schedule, changing nothing', async () => {
    const id = await scheduled();
    const staff = admin();
    const before = rows(id);

    expect((await flag(staff, id, { supporterDays: 2 })).status).toBe(400);
    const swapped = await flag(staff, id, { supporterSchedule: { opensAt: { [PLUS]: at(9), [LOW]: at(4) }, publicAt: null } });
    expect(swapped.status).toBe(400);
    expect(rows(id)).toEqual(before);
    expect(db.prepare('SELECT supporter_until FROM worlds WHERE id = ?').get(id).supporter_until).toBe(at(15));
  });

  it('refuses a non-admin, another kind, and a call that clears the flag', async () => {
    const id = await scheduled();
    const plain = await request(app).post('/api/worlds').set(authHeader(createUser()))
      .send(worldPayload({ kind: 'dictionary' }));
    const schedule = { supporterSchedule: THREE_STAGES };

    expect((await flag(createUser({ accountType: 'mod' }), id, schedule)).status).toBe(403);
    expect((await flag(admin(), plain.body.data.id, schedule)).status).toBe(400);
    expect((await flag(admin(), id, { supporterOnly: false, ...schedule })).status).toBe(400);
  });

  it('clears the rows with null and leaves the public date', async () => {
    const id = await scheduled();

    expect((await flag(admin(), id, { supporterSchedule: null })).status).toBe(200);

    expect(rows(id)).toEqual([]);
    expect(db.prepare('SELECT supporter_until FROM worlds WHERE id = ?').get(id).supporter_until).toBe(at(15));
    expect((await gated(id, member(LOW))).status).toBe(200);
  });

  it('keeps the rows after a manual clear but hides the schedule, and a new window starts without them', async () => {
    const id = await scheduled();
    const staff = admin();

    await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staff)).send({ supporterOnly: false });

    expect(rows(id)).toHaveLength(2);
    expect(await detail(id)).not.toHaveProperty('supporterSchedule');

    await flag(staff, id, {});
    expect(rows(id)).toEqual([]);
  });
});

describe('the schedule in the payloads', () => {
  it('rides the catalog and the details while Supporter-only, highest tier first', async () => {
    const id = await scheduled();
    const expected = [{ tier: PLUS, opensAt: at(5) }, { tier: LOW, opensAt: at(10) }];

    expect((await catalogEntry(id)).supporterSchedule).toEqual(expected);
    expect((await detail(id)).supporterSchedule).toEqual(expected);

    later(7);
    expect((await detail(id)).supporterSchedule).toEqual(expected);

    later(16);
    expect(await catalogEntry(id)).not.toHaveProperty('supporterSchedule');
    expect(await detail(id)).not.toHaveProperty('supporterSchedule');
  });
});
