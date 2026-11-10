import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, request, db, paths, scratchDir } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { checkStorage, setProbe, resetProbe } = require('../src/utils/storageCheck');
const { DIRECTORY_PARTS, PART_NAMES } = require('../src/config/storage');
const { DAY_MS, utcDay } = require('../src/config/time');

/**
 * The hourly storage check and the admin storage report.
 *
 * The upload directories are the real ones under the scratch storage root, filled with files of known
 * size. The local backups directory and the database file are scratch too, because their real paths sit
 * in the project. Only the disk totals are injected: a test cannot fill a real disk.
 */

const REPORT = '/api/storage/report';
const NOON = new Date('2026-03-10T12:00:00.000Z');

let work;
let backups;
let dbFile;
let free;

/** A disk answer for `statfs`: 1000 blocks of 1 KiB, 400 of them used. `free` is what a user can still write. */
const fakeStatfs = async () => ({ bsize: 1024, blocks: 1000, bfree: 600, bavail: free });

const put = (dir, name, bytes) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
};

const emptyDirectories = () => {
  for (const dir of [...Object.values(DIRECTORY_PARTS), backups]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(backups, { recursive: true });
};

beforeEach(() => {
  work = scratchDir('fms-storage-');
  backups = path.join(work, 'backups');
  dbFile = path.join(work, 'test.db');
  free = 600;
  fs.writeFileSync(dbFile, Buffer.alloc(1000, 2));
  emptyDirectories();
  setProbe({
    statfs: fakeStatfs,
    roles: { storage: paths.STORAGE_ROOT, data: work },
    directories: { ...DIRECTORY_PARTS, backups },
    dbPath: dbFile
  });
});

afterEach(() => {
  resetProbe();
  db.exec('DELETE FROM storage_days');
});

let people = 0;
const staffer = (accountType) => createUser({ username: `${accountType}-${(people += 1)}`, accountType });
const asAdmin = () => request(app).get(REPORT).set(authHeader(staffer('admin')));

describe('the storage table', () => {
  it('holds day, name, bytes and files, keyed by day and name', () => {
    const columns = db.prepare("SELECT name, pk FROM pragma_table_info('storage_days') ORDER BY cid").all();

    expect(columns.filter((column) => column.pk).map((column) => column.name)).toEqual(['day', 'name']);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['day', 'name', 'bytes', 'files']));
  });
});

describe('the storage report route', () => {
  it('refuses a visitor and a non-admin', async () => {
    expect((await request(app).get(REPORT)).status).toBe(401);
    expect((await request(app).get(REPORT).set(authHeader(staffer('normal')))).status).toBe(403);
    expect((await request(app).get(REPORT).set(authHeader(staffer('moderator')))).status).toBe(403);
  });

  it('lists every part as null before the first run', async () => {
    const res = await asAdmin();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.parts)).toEqual(PART_NAMES);
    expect(Object.values(res.body.data.parts).every((part) => part === null)).toBe(true);
  });

  it('reports the bytes and file count of each directory, the database with its WAL, and the backups', async () => {
    put(paths.WORLDS_DIR, 'a.json', 100);
    put(paths.WORLDS_DIR, 'nested/deep/b.json', 250);
    put(paths.THUMBNAILS_DIR, 't.webp', 10);
    put(paths.PENDING_DIR, 'p1.json', 7);
    put(paths.PENDING_DIR, 'p2.json', 8);
    put(paths.SUPPORTER_PRIVATE_DIR, 's.bin', 33);
    put(backups, 'db-2026-03-09.db.zst', 64);
    fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(500, 3));

    await checkStorage(NOON);
    const { parts } = (await asAdmin()).body.data;

    expect(parts.worlds).toEqual({ bytes: 350, files: 2, measuredAt: NOON.toISOString() });
    expect(parts.thumbnails).toMatchObject({ bytes: 10, files: 1 });
    expect(parts.pending).toMatchObject({ bytes: 15, files: 2 });
    expect(parts.avatars).toMatchObject({ bytes: 0, files: 0 });
    expect(parts['event-posters']).toMatchObject({ bytes: 0, files: 0 });
    expect(parts['supporter-private']).toMatchObject({ bytes: 33, files: 1 });
    expect(parts.backups).toMatchObject({ bytes: 64, files: 1 });
    expect(parts.database).toMatchObject({ bytes: 1500, files: 2 });
  });

  it('measures a directory that does not exist yet as empty', async () => {
    fs.rmSync(paths.AVATARS_DIR, { recursive: true, force: true });

    await checkStorage(NOON);

    expect((await asAdmin()).body.data.parts.avatars).toMatchObject({ bytes: 0, files: 0 });
  });

  it('reads the disks at request time, not from the last run', async () => {
    await checkStorage(NOON);
    free = 100;

    const { disks } = (await asAdmin()).body.data;

    expect(disks).toEqual([{
      id: 'storage+data',
      paths: [paths.STORAGE_ROOT, work],
      total: 1000 * 1024,
      used: 400 * 1024,
      free: 100 * 1024,
      usedFraction: 0.4,
      alertLevels: [0.8, 0.9]
    }]);
  });

  it('reports three paths on one filesystem once, reading a backups directory that does not exist yet from its parent', async () => {
    setProbe({ roles: { storage: paths.STORAGE_ROOT, data: work, app: path.join(work, 'later', 'backups') }, statfs: fakeStatfs });

    const { disks } = (await asAdmin()).body.data;

    expect(disks.map((disk) => disk.id)).toEqual(['storage+data+app']);
    expect(disks[0].paths).toEqual([paths.STORAGE_ROOT, work, work]);
  });

  it.skipIf(fs.statSync(os.tmpdir()).dev === fs.statSync(process.cwd()).dev)(
    'reports a path on another filesystem as its own disk',
    async () => {
      setProbe({ roles: { storage: paths.STORAGE_ROOT, data: work, app: process.cwd() }, statfs: fakeStatfs });

      const { disks } = (await asAdmin()).body.data;

      expect(disks.map((disk) => disk.id)).toEqual(['storage+data', 'app']);
    }
  );

  // The database file is 1000 bytes with a 500-byte WAL beside it, so the limit is 2000 bytes free.
  it.each([
    [2000, true],
    [2001, true],
    [1999, false],
    [1500, false]
  ])('says a vacuum fits only at twice the database file: %i bytes free', async (freeBytes, expected) => {
    fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(500, 3));
    setProbe({ statfs: async () => ({ bsize: 1, blocks: 100000, bfree: 90000, bavail: freeBytes }) });

    expect((await asAdmin()).body.data.vacuumFits).toBe(expected);
  });
});

const R2_KEYS = ['CLOUDFLARE_ANALYTICS_TOKEN', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_BACKUP_BUCKET'];
const TOKEN = 'cf-secret-token-123';
const GB = 1000 ** 3;

/** A Cloudflare reply: `rows` holds the newest row per alias (b0, b1), or an empty list for no rows. */
const cloudflareReply = (rows) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: { viewer: { accounts: [Object.fromEntries(Object.entries(rows).map(([alias, max]) => [alias, max ? [{ max }] : []]))] } },
    errors: null
  })
});

describe('the R2 read', () => {
  let saved;
  let calls;
  let errors;

  beforeEach(() => {
    saved = Object.fromEntries(R2_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      CLOUDFLARE_ANALYTICS_TOKEN: TOKEN, R2_ACCOUNT_ID: 'acct1', R2_BUCKET: 'files-bucket', R2_BACKUP_BUCKET: 'backups-bucket'
    });
    calls = [];
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of R2_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    errors.mockRestore();
  });

  const serve = (answer) => setProbe({ fetch: async (url, init) => { calls.push({ url, init }); return answer(); } });

  const BOTH = { b0: { payloadSize: 4 * GB, metadataSize: 5, objectCount: 120 }, b1: { payloadSize: 2 * GB, metadataSize: 7, objectCount: 9 } };

  it('reads both buckets with one request and reports size as payload plus metadata, beside the free tier', async () => {
    serve(() => cloudflareReply(BOTH));

    await checkStorage(NOON);
    const { r2 } = (await asAdmin()).body.data;

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(r2).toEqual({
      freeTierBytes: 10 * GB,
      buckets: {
        'files-bucket': { bytes: 4 * GB + 5, objects: 120, checkedAt: NOON.toISOString() },
        'backups-bucket': { bytes: 2 * GB + 7, objects: 9, checkedAt: NOON.toISOString() }
      }
    });
    const rows = db.prepare("SELECT day, name, bytes, files FROM storage_days WHERE name LIKE 'r2:%' ORDER BY name").all();
    expect(rows).toEqual([
      { day: '2026-03-10', name: 'r2:backups-bucket', bytes: 2 * GB + 7, files: 9 },
      { day: '2026-03-10', name: 'r2:files-bucket', bytes: 4 * GB + 5, files: 120 }
    ]);
  });

  it('keeps the last good value and its time through a failed read, and still stores the disk and directories', async () => {
    serve(() => cloudflareReply(BOTH));
    await checkStorage(NOON);
    put(paths.WORLDS_DIR, 'w.json', 4);
    const later = new Date(NOON.getTime() + 3600 * 1000);
    serve(() => ({ ok: false, status: 503, json: async () => ({}) }));

    const result = await checkStorage(later);

    expect(result.failed).toEqual(['r2']);
    const { r2, parts, disks } = (await asAdmin()).body.data;
    expect(r2.buckets['files-bucket']).toEqual({ bytes: 4 * GB + 5, objects: 120, checkedAt: NOON.toISOString() });
    expect(parts.worlds).toMatchObject({ bytes: 4, measuredAt: later.toISOString() });
    expect(disks).toHaveLength(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
  });

  it('keeps the last value when the network call throws or the reply holds errors', async () => {
    serve(() => cloudflareReply(BOTH));
    await checkStorage(NOON);
    const later = new Date(NOON.getTime() + 3600 * 1000);

    serve(() => { throw new Error('socket closed'); });
    await expect(checkStorage(later)).resolves.toMatchObject({ failed: ['r2'] });
    serve(() => ({ ok: true, status: 200, json: async () => ({ data: null, errors: [{ message: 'not authorized' }] }) }));
    await expect(checkStorage(later)).resolves.toMatchObject({ failed: ['r2'] });

    expect((await asAdmin()).body.data.r2.buckets['files-bucket'].checkedAt).toBe(NOON.toISOString());
  });

  it('skips R2 with no token: no request, no rows, r2 null', async () => {
    delete process.env.CLOUDFLARE_ANALYTICS_TOKEN;
    serve(() => cloudflareReply(BOTH));

    const result = await checkStorage(NOON);

    expect(calls).toHaveLength(0);
    expect(result.failed).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM storage_days WHERE name LIKE 'r2:%'").get().n).toBe(0);
    expect((await asAdmin()).body.data.r2).toBeNull();
  });

  it.each(['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_BACKUP_BUCKET'])('skips R2 when %s is missing', async (key) => {
    delete process.env[key];
    serve(() => cloudflareReply(BOTH));

    await checkStorage(NOON);

    expect(calls).toHaveLength(0);
    expect((await asAdmin()).body.data.r2).toBeNull();
  });

  it('keeps the token out of the log on a thrown fetch and on a reply with errors', async () => {
    serve(() => { throw new Error('socket closed'); });
    await checkStorage(NOON);
    serve(() => ({ ok: true, status: 200, json: async () => ({ data: null, errors: [{ message: 'not authorized' }] }) }));
    await checkStorage(NOON);

    expect(errors.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
  });

  it('reports a bucket with no rows as null, writes nothing for it, and still reports the other', async () => {
    serve(() => cloudflareReply({ b0: BOTH.b0, b1: null }));

    const result = await checkStorage(NOON);

    expect(result.failed).toEqual([]);
    const { r2 } = (await asAdmin()).body.data;
    expect(r2.buckets['backups-bucket']).toBeNull();
    expect(r2.buckets['files-bucket']).toMatchObject({ bytes: 4 * GB + 5, objects: 120 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM storage_days WHERE name = 'r2:backups-bucket'").get().n).toBe(0);
  });

  it('keeps R2 names out of parts and never returns the token', async () => {
    serve(() => cloudflareReply(BOTH));
    await checkStorage(NOON);

    const res = await asAdmin();

    expect(Object.keys(res.body.data.parts)).toEqual(PART_NAMES);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('the storage check', () => {
  it('stores each disk and part under the UTC day', async () => {
    put(paths.WORLDS_DIR, 'a.json', 5);

    await checkStorage(NOON);

    const rows = db.prepare('SELECT day, name, bytes, files FROM storage_days ORDER BY name').all();
    expect(rows).toContainEqual({ day: '2026-03-10', name: 'disk:storage+data:total', bytes: 1000 * 1024, files: null });
    expect(rows).toContainEqual({ day: '2026-03-10', name: 'disk:storage+data:used', bytes: 400 * 1024, files: null });
    expect(rows).toContainEqual({ day: '2026-03-10', name: 'worlds', bytes: 5, files: 1 });
    expect(rows).toHaveLength(2 + PART_NAMES.length);
  });

  it('replaces the rows of its day on a second run, and keeps the earlier day', async () => {
    put(paths.WORLDS_DIR, 'a.json', 5);
    await checkStorage(new Date(NOON.getTime() - DAY_MS));
    await checkStorage(NOON);
    put(paths.WORLDS_DIR, 'b.json', 6);
    const later = new Date(NOON.getTime() + 3600 * 1000);

    await checkStorage(later);

    const worlds = db.prepare("SELECT day, bytes, files, measured_at AS at FROM storage_days WHERE name = 'worlds' ORDER BY day").all();
    expect(worlds).toEqual([
      { day: '2026-03-09', bytes: 5, files: 1, at: new Date(NOON.getTime() - DAY_MS).toISOString() },
      { day: '2026-03-10', bytes: 11, files: 2, at: later.toISOString() }
    ]);
    expect((await asAdmin()).body.data.parts.worlds).toEqual({ bytes: 11, files: 2, measuredAt: later.toISOString() });
  });

  it('keeps the last row of a directory whose walk fails, and still measures the rest', async () => {
    put(paths.PENDING_DIR, 'p.json', 9);
    await checkStorage(NOON);
    // A file where the directory should be: readdir fails with ENOTDIR.
    fs.rmSync(paths.PENDING_DIR, { recursive: true });
    fs.writeFileSync(paths.PENDING_DIR, 'not a directory');
    put(paths.WORLDS_DIR, 'w.json', 4);
    const later = new Date(NOON.getTime() + 3600 * 1000);

    const result = await checkStorage(later);

    expect(result.failed).toEqual(['pending']);
    const { parts } = (await asAdmin()).body.data;
    expect(parts.pending).toEqual({ bytes: 9, files: 1, measuredAt: NOON.toISOString() });
    expect(parts.worlds).toMatchObject({ bytes: 4, measuredAt: later.toISOString() });
    fs.rmSync(paths.PENDING_DIR);
  });

  it('does not throw when the disk reading fails, and still stores the parts', async () => {
    setProbe({ statfs: async () => { throw new Error('no statfs'); } });
    put(paths.THUMBNAILS_DIR, 't.webp', 3);

    await expect(checkStorage(NOON)).resolves.toMatchObject({ failed: [] });

    const res = await asAdmin();
    expect(res.body.data.disks).toEqual([]);
    expect(res.body.data.parts.thumbnails).toMatchObject({ bytes: 3 });
  });

  it('walks without holding the event loop', async () => {
    for (let index = 0; index < 200; index += 1) put(paths.WORLDS_DIR, `many/${index}.json`, 1);

    // Count the event-loop turns other work gets while the check runs. A blocking walk leaves only a few.
    let done = false;
    let turns = 0;
    const run = checkStorage(NOON).then(() => { done = true; });
    const spin = () => { turns += 1; if (!done) setImmediate(spin); };
    setImmediate(spin);
    await run;

    expect(turns).toBeGreaterThan(50);
  });

  it('names its day by UTC, not local time', async () => {
    await checkStorage(new Date('2026-03-10T23:59:59.000Z'));

    expect(db.prepare('SELECT DISTINCT day FROM storage_days').all()).toEqual([{ day: utcDay(new Date('2026-03-10T00:00:00Z')) }]);
  });
});

describe('the storage history', () => {
  const { buildStorageReport } = require('../src/utils/storageCheck');
  const StorageDay = require('../src/models/StorageDay');
  const KIB = 1024;
  const TOTAL = 1000 * KIB;

  const dayAt = (back) => utcDay(new Date(NOON.getTime() - back * DAY_MS));
  const store = (back, rows) => StorageDay.replace(dayAt(back), rows, NOON.toISOString());
  const used = (back, kib) => store(back, [{ name: 'disk:storage+data:used', bytes: kib * KIB, files: null }]);
  const forecastOf = async (days = 30) => (await buildStorageReport(days, NOON)).forecast['storage+data'].daysUntilFull;

  let marker = 0;
  const download = (back, count) => {
    const id = `history-world-${(marker += 1)}`;
    const author = staffer('normal');
    db.prepare('INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, 'd', author.id, 't', 'c');
    db.prepare('INSERT INTO world_download_days (world_id, day, count) VALUES (?, ?, ?)').run(id, dayAt(back), count);
    return id;
  };

  afterEach(() => {
    db.exec('DELETE FROM world_download_days');
    db.exec("DELETE FROM worlds WHERE id LIKE 'history-world-%'");
  });

  it('lists one entry per UTC day, newest first, today included', async () => {
    const { days } = await buildStorageReport(5, NOON);

    expect(days.map((entry) => entry.day)).toEqual([0, 1, 2, 3, 4].map(dayAt));
  });

  it('shows a day without rows as null values, not zero', async () => {
    store(1, [{ name: 'worlds', bytes: 0, files: 0 }]);

    const [today, yesterday] = (await buildStorageReport(2, NOON)).days;

    expect(today.values.worlds).toBeNull();
    expect(yesterday.values.worlds).toEqual({ bytes: 0, files: 0 });
    expect(Object.values(today.values).every((value) => value === null)).toBe(true);
  });

  it('holds the same names on every day, the disk rows and any other stored name included', async () => {
    store(2, [{ name: 'disk:storage+data:total', bytes: TOTAL, files: null }, { name: 'r2:formamorph-files', bytes: 9, files: 3 }]);

    const { days } = await buildStorageReport(3, NOON);

    const keys = days.map((entry) => Object.keys(entry.values));
    expect(keys[0]).toEqual(keys[2]);
    expect(keys[0]).toEqual(expect.arrayContaining([...PART_NAMES, 'disk:storage+data:total', 'r2:formamorph-files']));
    expect(days[2].values['r2:formamorph-files']).toEqual({ bytes: 9, files: 3 });
    expect(days[0].values['r2:formamorph-files']).toBeNull();
  });

  it('sums downloads per day over all listings, and gives 0 for a day without any', async () => {
    download(0, 4);
    download(0, 3);
    download(2, 5);

    const { days } = await buildStorageReport(4, NOON);

    expect(days.map((entry) => entry.downloads)).toEqual([7, 0, 5, 0]);
  });

  it('serves the history over the route, with the default of 30 days', async () => {
    const res = await asAdmin();

    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(30);
    expect(res.body.data.days[0].day).toBe(utcDay(new Date()));
  });

  it.each(['0', '-1', '1.5', 'abc', '', '366'])('refuses days=%j', async (value) => {
    const res = await request(app).get(`${REPORT}?days=${value}`).set(authHeader(staffer('admin')));

    expect(res.status).toBe(400);
  });

  it.each([['1', 1], ['365', 365]])('accepts days=%s', async (value, length) => {
    const res = await request(app).get(`${REPORT}?days=${value}`).set(authHeader(staffer('admin')));

    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(length);
  });

  describe('the forecast', () => {
    it('counts the days until full along the line through the daily use', async () => {
      // 100 KiB growing 10 KiB a day to 190 KiB today; the disk holds 1000 KiB: 810 / 10 days left.
      for (let back = 9; back >= 0; back -= 1) used(back, 190 - back * 10);

      expect(await forecastOf()).toBe(81);
    });

    it('fits a line through a sparse set of days, not just the last two', async () => {
      // 5 KiB a day, measured on 7 of the last 30 days: 245 KiB today, 755 / 5 left.
      for (const back of [29, 25, 20, 15, 10, 5, 0]) used(back, 245 - back * 5);

      expect(await forecastOf()).toBe(151);
    });

    it('is the same for a short history list as for a long one', async () => {
      for (let back = 9; back >= 0; back -= 1) used(back, 190 - back * 10);

      expect(await forecastOf(1)).toBe(81);
    });

    it('is null with fewer than 7 measured days', async () => {
      for (let back = 5; back >= 0; back -= 1) used(back, 190 - back * 10);

      expect(await forecastOf()).toBeNull();
    });

    it('ignores days older than 30 when it counts the measured days', async () => {
      for (let back = 40; back >= 35; back -= 1) used(back, 100 + (40 - back));
      for (let back = 3; back >= 0; back -= 1) used(back, 190 - back * 10);

      expect(await forecastOf()).toBeNull();
    });

    it('is null when use is flat', async () => {
      for (let back = 9; back >= 0; back -= 1) used(back, 400);

      expect(await forecastOf()).toBeNull();
    });

    it('is null when use falls', async () => {
      for (let back = 9; back >= 0; back -= 1) used(back, 300 + back * 10);

      expect(await forecastOf()).toBeNull();
    });

    it('is 0 when the line is already at the total', async () => {
      for (let back = 9; back >= 0; back -= 1) used(back, 1000 - back * 10);

      expect(await forecastOf()).toBe(0);
    });

    it('is keyed by disk id, and null for a disk with no history', async () => {
      const { forecast } = await buildStorageReport(30, NOON);

      expect(forecast).toEqual({ 'storage+data': { daysUntilFull: null } });
    });
  });
});
