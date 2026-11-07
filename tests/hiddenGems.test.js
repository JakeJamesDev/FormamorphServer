import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, seedUsers, seedLikes } from './helpers.js';

/**
 * Hidden Gems: downloads logged by UTC day, a rotation every 12 hours over a 60-day window, and the
 * catalog's `hidden_gem` flag. Driven through the routes and `rotateHiddenGems(now)` under a set clock.
 *
 * The base fixture is one obvious gem (five likes, one download), one popular world (five likes, four
 * downloads) and two plain worlds (four downloads, no likes). Four downloads sits on the cutoff, so only
 * the gem is eligible.
 */

const require = createRequire(import.meta.url);
const { rotateHiddenGems, startHiddenGemRotation } = require('../src/utils/rotateHiddenGems');
const { HiddenGem } = require('../src/models/HiddenGem');
const World = require('../src/models/World');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-11-07T12:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);

/** Move the set clock; every route and seeded like reads it. */
const setClock = (date) => vi.setSystemTime(date);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setClock(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const publish = async (author, over = {}) => {
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(over));
  expect(res.status).toBe(201);
  return res.body.data;
};

const download = (id, user = null) => {
  const req = request(app).get(`/api/worlds/${id}/content`);
  return user ? req.set(authHeader(user)) : req;
};

const downloadTimes = async (id, times) => {
  for (let i = 0; i < times; i += 1) expect((await download(id)).status).toBe(200);
};

/** `hidden_gem` per catalog row id, as this reader gets it. */
const flags = async (reader = null, kind = 'world') => {
  const req = request(app).get(`/api/worlds?kind=${kind}&limit=100`);
  const res = await (reader ? req.set(authHeader(reader)) : req);
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.data.map((row) => [row.id, row.hidden_gem]));
};

const flagged = async (reader = null, kind = 'world') =>
  Object.entries(await flags(reader, kind)).filter(([, gem]) => gem).map(([id]) => id).sort();

let likerBatch = 0;

/** A batch of likers, five by default, shared by every world that needs likes in one test. */
const likers = (count = 5) => seedUsers(count, `liker-${(likerBatch += 1)}`);

const seedBase = async () => {
  const author = createUser({ username: 'tidewright' });
  const fans = likers();
  const gem = await publish(author, { name: 'Lantern Hollow' });
  const popular = await publish(author, { name: 'Crowded Harbor' });
  const plainA = await publish(author, { name: 'Gray Flats' });
  const plainB = await publish(author, { name: 'Salt Road' });

  await downloadTimes(gem.id, 1);
  for (const world of [popular, plainA, plainB]) await downloadTimes(world.id, 4);
  seedLikes(gem.id, fans);
  seedLikes(popular.id, fans);

  return { author, fans, gem, popular, plainA, plainB };
};

describe('picking', () => {
  it('flags the well-liked, low-download world and gives every row a boolean flag', async () => {
    const { gem, popular, plainA, plainB } = await seedBase();

    expect(rotateHiddenGems(T0)).toEqual([gem.id]);

    expect(await flags()).toEqual({ [gem.id]: true, [popular.id]: false, [plainA.id]: false, [plainB.id]: false });
  });

  it('gives a non-world row a false flag', async () => {
    const author = createUser();
    const entity = await publish(author, { name: 'Reed Hermit', kind: 'entity' });
    await seedBase();
    rotateHiddenGems(T0);

    expect((await flags(null, 'entity'))[entity.id]).toBe(false);
  });

  it('flags nothing before the first rotation', async () => {
    await seedBase();

    expect(await flagged()).toEqual([]);
  });

  it.each([[2, false], [3, true]])('a world with %i window likes is picked: %s', async (count, picked) => {
    const author = createUser();
    const fans = likers();
    const world = await publish(author, { name: 'Quiet Fen' });
    const busy = await Promise.all(['Ash Market', 'Iron Quay', 'Rope Walk'].map((name) => publish(author, { name })));

    await downloadTimes(world.id, 1);
    for (const other of busy) await downloadTimes(other.id, 4);
    seedLikes(world.id, fans.slice(0, count));

    rotateHiddenGems(T0);

    expect(await flagged()).toEqual(picked ? [world.id] : []);
  });

  it('picks at most three, highest score first, ties broken by id, the same on every run', async () => {
    const author = createUser();
    const fans = likers();
    const gems = await Promise.all(['Moth Lane', 'Wick Street', 'Ember Row', 'Cinder Yard'].map((name) => publish(author, { name })));
    const busy = await Promise.all(['Bell Square', 'Grain Hall', 'Tin Bridge', 'Oak Gate', 'Mill Pond'].map((name) => publish(author, { name })));

    for (const world of gems) {
      await downloadTimes(world.id, 1);
      seedLikes(world.id, fans);
    }
    for (const world of busy) await downloadTimes(world.id, 4);

    const expected = gems.map((world) => world.id).sort().slice(0, 3);
    expect(rotateHiddenGems(T0)).toEqual(expected);
    expect(await flagged()).toEqual(expected);
  });

  it.each([
    ['pinned', async ({ gem }, staff) => request(app).put(`/api/worlds/${gem.id}/pin`).set(authHeader(staff)).send({})],
    ['Supporter-only', async ({ gem }, staff) => request(app).put(`/api/worlds/${gem.id}/supporter-only`).set(authHeader(staff)).send({ supporterOnly: true })],
    ['quarantined', async ({ gem }, staff) => request(app).put(`/api/worlds/${gem.id}/quarantine`).set(authHeader(staff)).send({ days: 7 })],
    // No route unlists a world or sends an approved one back to review, so both rows are set directly.
    ['unlisted', async ({ gem }) => db.prepare("UPDATE worlds SET visibility = 'unlisted' WHERE id = ?").run(gem.id)],
    ['unapproved', async ({ gem }) => db.prepare("UPDATE worlds SET moderation_state = 'pending' WHERE id = ?").run(gem.id)]
  ])('does not pick a %s world', async (_label, change) => {
    const staff = createUser({ accountType: 'admin' });
    const base = await seedBase();
    const res = await change(base, staff);
    if (res && res.status) expect(res.status).toBe(200);

    expect(rotateHiddenGems(T0)).toEqual([]);
    expect(await flagged(staff)).toEqual([]);
  });

  it('does not pick a non-world listing with a gem\'s numbers', async () => {
    const { author, fans, gem } = await seedBase();
    const entity = await publish(author, { name: 'Lamp Keeper', kind: 'entity' });
    await downloadTimes(entity.id, 1);
    seedLikes(entity.id, fans);

    expect(rotateHiddenGems(T0)).toEqual([gem.id]);
    expect(await flagged(null, 'all')).toEqual([gem.id]);
  });
});

describe('contest entries', () => {
  const contest = () => Event.create({
    type: 'contest',
    title: 'Lantern Contest',
    bannerText: 'Build a lantern town.',
    body: 'Build a lantern town.',
    startsAt: at(-HOUR).toISOString(),
    endsAt: at(HOUR).toISOString()
  });

  const seedEntry = async () => {
    const event = contest();
    const base = await seedBase();
    const entrant = createUser({ username: 'wickmaker' });
    const entry = await publish(entrant, { name: 'Wick Harbor', contestEventId: event.id });
    await downloadTimes(entry.id, 1);
    seedLikes(entry.id, base.fans);
    return { ...base, event, entry, entrant };
  };

  it('never picks an entry whose likes are hidden', async () => {
    const { gem, entry, entrant } = await seedEntry();

    expect(rotateHiddenGems(T0)).toEqual([gem.id]);
    expect((await flags())[entry.id]).toBe(false);
    expect((await flags(entrant))[entry.id]).toBe(false);
  });

  it('picks the same entry once its results are announced', async () => {
    const { gem, event, entry } = await seedEntry();
    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1).toISOString(), event.id);
    Event.announceResults(event.id);

    expect([...rotateHiddenGems(T0)].sort()).toEqual([gem.id, entry.id].sort());
  });
});

describe('download log', () => {
  it('counts world-content downloads: a gem that passes the cutoff is not picked', async () => {
    const { gem } = await seedBase();
    await downloadTimes(gem.id, 3);

    expect(rotateHiddenGems(T0)).toEqual([]);
  });

  it('still answers 404 for a missing world', async () => {
    const res = await download('no-such-world');

    expect(res.status).toBe(404);
  });

  it('counts nothing for a missing id, so the log never breaks its route', () => {
    expect(World.incrementDownloads('no-such-world')).toBe(0);
  });

  it('counts Supporter-content downloads', async () => {
    const admin = createUser({ accountType: 'admin' });
    const { gem, author } = await seedBase();
    const setFlag = (value) => request(app).put(`/api/worlds/${gem.id}/supporter-only`).set(authHeader(admin)).send({ supporterOnly: value });

    expect((await setFlag(true)).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get(`/api/worlds/${gem.id}/supporter-content`).set(authHeader(author))).status).toBe(200);
    }
    expect((await setFlag(false)).status).toBe(200);

    expect(rotateHiddenGems(T0)).toEqual([]);
  });

  it.each([[0, true], [4, false]])('counts %i dependency downloads (picked: %s)', async (times, picked) => {
    const { author, fans, gem } = await seedBase();
    const source = await publish(author, { name: 'Lamplighter', kind: 'entity' });
    const host = await publish(author, { name: 'Dusk Pier', requiredDependencies: [source.id] });
    for (let i = 0; i < times; i += 1) {
      expect((await request(app).get(`/api/worlds/${host.id}/dependencies/${source.id}/content`)).status).toBe(200);
    }
    seedLikes(source.id, fans);
    // Only a world can be picked, so the source becomes one to show what its downloads logged.
    db.prepare("UPDATE worlds SET kind = 'world' WHERE id = ?").run(source.id);
    db.prepare('DELETE FROM listing_dependencies WHERE source_id = ?').run(source.id);

    expect([...rotateHiddenGems(T0)].sort()).toEqual((picked ? [gem.id, source.id] : [gem.id]).sort());
  });
});

describe('window', () => {
  // Day 59 back is the window's first day; day 60 back is outside it.
  it.each([[60, true], [59, false]])('downloads %i days back leave a world eligible: %s', async (daysBack, picked) => {
    const { author, fans, gem } = await seedBase();
    const old = await publish(author, { name: 'Old Mill' });
    setClock(at(-daysBack * DAY));
    await downloadTimes(old.id, 6);
    setClock(T0);
    seedLikes(old.id, fans);

    expect([...rotateHiddenGems(T0)].sort()).toEqual((picked ? [gem.id, old.id] : [gem.id]).sort());
  });

  it.each([[60, false], [59, true]])('likes %i days back count: %s', async (daysBack, picked) => {
    const author = createUser();
    const fans = likers();
    const gem = await publish(author, { name: 'Lantern Hollow' });
    const busy = await Promise.all(['Ash Market', 'Iron Quay', 'Rope Walk'].map((name) => publish(author, { name })));
    await downloadTimes(gem.id, 1);
    for (const other of busy) await downloadTimes(other.id, 4);
    setClock(at(-daysBack * DAY));
    seedLikes(gem.id, fans);
    setClock(T0);

    expect(rotateHiddenGems(T0)).toEqual(picked ? [gem.id] : []);
  });

  it('picks nothing once every download has left the window', async () => {
    await seedBase();

    expect(rotateHiddenGems(at(61 * DAY))).toEqual([]);
    expect(await flagged()).toEqual([]);
  });
});

describe('rotation', () => {
  it('makes a new rotation only at 12 hours', async () => {
    const { author, fans, gem } = await seedBase();
    rotateHiddenGems(T0);

    // A second gem arrives, so a new rotation would pick it.
    const late = await publish(author, { name: 'Late Bloom' });
    await downloadTimes(late.id, 1);
    seedLikes(late.id, fans);

    expect(rotateHiddenGems(at(12 * HOUR - 1))).toBeNull();
    expect(await flagged()).toEqual([gem.id]);

    expect(rotateHiddenGems(at(12 * HOUR))).toEqual([late.id]);
    expect(await flagged()).toEqual([late.id]);
  });

  it('records a rotation with no eligible world, which clears every flag', async () => {
    const { gem } = await seedBase();
    rotateHiddenGems(T0);
    expect(await flagged()).toEqual([gem.id]);

    // The gem is cooling down and nothing else qualifies.
    expect(rotateHiddenGems(at(12 * HOUR))).toEqual([]);
    expect(await flagged()).toEqual([]);

    // The empty rotation restarted the 12-hour clock.
    expect(rotateHiddenGems(at(24 * HOUR - 1))).toBeNull();
  });

  it.each([[7 * DAY - 1, false], [7 * DAY, true]])('a world picked %i ms ago is eligible: %s', async (since, picked) => {
    const { gem } = await seedBase();
    rotateHiddenGems(T0);

    expect(rotateHiddenGems(at(since))).toEqual(picked ? [gem.id] : []);
  });

  it('logs a failed rotation, and the next run succeeds', async () => {
    const { gem } = await seedBase();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(HiddenGem, 'pick').mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(rotateHiddenGems(T0)).toBeNull();
    expect(logged).toHaveBeenCalledWith('Hidden Gem rotation failed:', expect.objectContaining({ message: 'disk full' }));
    expect(await flagged()).toEqual([]);

    expect(rotateHiddenGems(T0)).toEqual([gem.id]);
  });

  it('runs hourly once started', async () => {
    const { gem } = await seedBase();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    setClock(T0);
    const timer = startHiddenGemRotation();

    try {
      vi.advanceTimersByTime(HOUR);
      expect(await flagged()).toEqual([gem.id]);
    } finally {
      clearInterval(timer);
    }
  });
});

describe('flag at read time', () => {
  it.each([
    ['quarantined', (id, staff) => request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(staff)).send({ days: 7 })],
    ['pinned', (id, staff) => request(app).put(`/api/worlds/${id}/pin`).set(authHeader(staff)).send({})],
    ['Supporter-only', (id, staff) => request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staff)).send({ supporterOnly: true })],
    ['unlisted', (id) => db.prepare("UPDATE worlds SET visibility = 'unlisted' WHERE id = ?").run(id)]
  ])('a pick that becomes %s loses its flag for a guest, staff and its author', async (_label, change) => {
    const staff = createUser({ accountType: 'admin' });
    const { gem, author } = await seedBase();
    rotateHiddenGems(T0);
    expect(await flagged()).toEqual([gem.id]);

    const res = await change(gem.id, staff);
    if (res && res.status) expect(res.status).toBe(200);

    // A guest no longer sees a quarantined row at all; staff and the author still get the row.
    expect((await flags())[gem.id] ?? false).toBe(false);
    expect((await flags(staff))[gem.id]).toBe(false);
    expect((await flags(author))[gem.id]).toBe(false);
  });
});

describe('catalog ETag', () => {
  it('changes after a rotation that changes the picks, and not after one that is not due', async () => {
    await seedBase();
    const tag = async () => (await request(app).get('/api/worlds?limit=100')).headers.etag;

    const before = await tag();
    rotateHiddenGems(T0);
    const after = await tag();
    expect(after).not.toBe(before);

    rotateHiddenGems(at(HOUR));
    expect(await tag()).toBe(after);
  });
});
