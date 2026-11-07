import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { app, request, db, scratchDir } from './context.js';
import { createUser, authHeader, worldPayload, seedUsers, seedLikes } from './helpers.js';

/**
 * The one-off Hidden Gems backfill: download counters in backups become daily buckets in the live log.
 * Fixture backups are snapshots of the test database with set counters, so they carry the real schema.
 */

const require = createRequire(import.meta.url);
const { backfillDownloadDays } = require('../src/utils/backfillDownloadDays');
const { rotateHiddenGems } = require('../src/utils/rotateHiddenGems');
const { HiddenGem } = require('../src/models/HiddenGem');

const T0 = new Date('2026-11-07T12:00:00.000Z');
const PRE_DEPLOY = 'pre-deploy-abc1234-2026-11-07T11-00-00.000Z.db';

let dir;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = scratchDir('fms-backfill-');
});

afterEach(() => {
  vi.useRealTimers();
});

const publish = async (author, name) => {
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload({ name }));
  expect(res.status).toBe(201);
  return res.body.data.id;
};

/** Write a backup named `name` holding these download counters; `.zst` names are compressed. */
const backup = (name, counters) => {
  const set = db.prepare('UPDATE worlds SET downloads = ? WHERE id = ?');
  for (const [id, count] of Object.entries(counters)) set.run(count, id);
  const bytes = db.serialize();
  const file = path.join(dir, name);
  fs.writeFileSync(file, name.endsWith('.zst') ? zlib.zstdCompressSync(bytes) : bytes);
  return file;
};

/** A world's window downloads for a window ending on `day`. */
const windowDownloads = (id, day) =>
  HiddenGem.population(new Date(`${day}T12:00:00.000Z`)).find((row) => row.id === id).downloads;

const flagged = async () => {
  const res = await request(app).get('/api/worlds?kind=world&limit=100');
  expect(res.status).toBe(200);
  return res.body.data.filter((row) => row.hidden_gem).map((row) => row.id).sort();
};

describe('backfillDownloadDays', () => {
  it('picks a world whose downloads came before the window as a low-download world', async () => {
    const author = createUser();
    const fans = seedUsers(5, 'fan');
    const old = await publish(author, 'Lantern Hollow');
    const popular = await publish(author, 'Crowded Harbor');
    const busy = await Promise.all(['Gray Flats', 'Salt Road'].map((name) => publish(author, name)));
    const gone = await publish(author, 'Sunken Pier');
    seedLikes(old, fans);
    seedLikes(popular, fans);

    // The window of T0 starts on 2026-09-09, so the old world's 500 downloads all fall before it.
    const files = [
      backup('db-2026-09-06.db.zst', { [old]: 0, [popular]: 0, [busy[0]]: 0, [busy[1]]: 0, [gone]: 0 }),
      backup('pre-deploy-0a1b2c3-2026-09-08T10-00-00.000Z.db', { [old]: 500 }),
      backup('pre-deploy-4d5e6f7-2026-10-01T10-00-00.000Z.db', { [popular]: 4, [busy[0]]: 4, [busy[1]]: 4, [gone]: 9 }),
      backup(PRE_DEPLOY, {})
    ];
    const before = files.map((file) => fs.readFileSync(file));
    db.prepare('DELETE FROM worlds WHERE id = ?').run(gone);

    // The boot rotation saw an empty log and picked nothing.
    expect(rotateHiddenGems(T0)).toEqual([]);

    const result = backfillDownloadDays(files, { write: true, now: T0 });

    expect(result).toMatchObject({ worlds: 4, downloads: 512, skipped: 1, picks: [old] });
    expect(windowDownloads(old, '2026-11-07')).toBe(0);
    expect(await flagged()).toEqual([old]);
    // The hourly job leaves the backfill's fresh rotation alone until it is due.
    expect(rotateHiddenGems(new Date(T0.getTime() + 60 * 60 * 1000))).toBeNull();
    expect(await flagged()).toEqual([old]);
    files.forEach((file, i) => expect(fs.readFileSync(file).equals(before[i])).toBe(true));
  });

  it('spreads a gap evenly over the days after the earlier backup, the remainder on the last day', async () => {
    const world = await publish(createUser(), 'Moth Lane');
    const files = [backup('db-2026-10-20.db', { [world]: 0 }), backup('db-2026-10-23.db.zst', { [world]: 7 })];

    expect(backfillDownloadDays(files, { write: true, now: T0 }).buckets).toBe(3);

    // A 60-day window ending 2026-12-21 starts on 2026-10-23, the gap's last day.
    expect(windowDownloads(world, '2026-12-21')).toBe(3);
    expect(windowDownloads(world, '2026-12-20')).toBe(5);
    expect(windowDownloads(world, '2026-12-19')).toBe(7);
    expect(windowDownloads(world, '2026-10-20')).toBe(0);
  });

  it('counts a new world from 0, a falling counter as 0, and a same-day gap on that day', async () => {
    const author = createUser();
    const reset = await publish(author, 'Ember Row');
    const first = backup('pre-deploy-0a1b2c3-2026-11-05T00-14-33.306Z.db', { [reset]: 10 });
    // Published after the earlier backup, so absent from it.
    const fresh = await publish(author, 'Wick Street');
    const second = backup('db-2026-11-05.db.zst', { [fresh]: 4, [reset]: 6 });

    backfillDownloadDays([first, second], { write: true, now: T0 });

    expect(windowDownloads(fresh, '2026-11-05')).toBe(4);
    expect(windowDownloads(fresh, '2026-11-04')).toBe(0);
    expect(windowDownloads(reset, '2026-11-05')).toBe(0);
  });

  it('reads a pre-deploy name with dash milliseconds', async () => {
    const world = await publish(createUser(), 'Lantern Ford');
    const files = [
      backup('pre-deploy-bb348e1-2026-11-05T23-23-03-494Z.db', { [world]: 0 }),
      backup(PRE_DEPLOY, { [world]: 4 })
    ];

    backfillDownloadDays(files, { write: true, now: T0 });

    expect(windowDownloads(world, '2026-11-05')).toBe(0);
    expect(windowDownloads(world, '2026-11-07')).toBe(4);
  });

  it('adds to buckets the live log already holds', async () => {
    const world = await publish(createUser(), 'Cinder Yard');
    const files = [backup('db-2026-11-06.db', { [world]: 0 }), backup(PRE_DEPLOY, { [world]: 2 })];
    expect((await request(app).get(`/api/worlds/${world}/content`)).status).toBe(200);

    backfillDownloadDays(files, { write: true, now: T0 });

    expect(windowDownloads(world, '2026-11-07')).toBe(3);
  });

  it('writes nothing on a dry run, and refuses a second run', async () => {
    const world = await publish(createUser(), 'Bell Square');
    const files = [backup('db-2026-11-06.db', { [world]: 0 }), backup(PRE_DEPLOY, { [world]: 5 })];

    expect(backfillDownloadDays(files, { now: T0 })).toMatchObject({ worlds: 1, downloads: 5, picks: null });
    expect(windowDownloads(world, '2026-11-07')).toBe(0);

    backfillDownloadDays(files, { write: true, now: T0 });
    expect(() => backfillDownloadDays(files, { write: true, now: T0 })).toThrow(/already ran/);
    expect(() => backfillDownloadDays(files, { now: T0 })).toThrow(/already ran/);
    expect(windowDownloads(world, '2026-11-07')).toBe(5);
  });

  it.each([
    ['out of time order', ['db-2026-11-05.db', 'pre-deploy-0a1b2c3-2026-11-05T00-14-33.306Z.db'], /out of time order/],
    ['without a time in its name', ['db-2026-11-05.db', 'latest.db'], /No backup time/],
    ['a single backup', ['db-2026-11-05.db'], /at least two/]
  ])('refuses a list %s before any write', async (_, names, error) => {
    const world = await publish(createUser(), 'Grain Hall');
    const files = names.map((name, i) => backup(name, { [world]: i * 5 }));

    expect(() => backfillDownloadDays(files, { write: true, now: T0 })).toThrow(error);
    expect(windowDownloads(world, '2026-11-07')).toBe(0);
    expect(backfillDownloadDays([backup('db-2026-11-06.db', { [world]: 0 }), backup(PRE_DEPLOY, { [world]: 1 })], { now: T0 }).worlds).toBe(1);
  });
});
