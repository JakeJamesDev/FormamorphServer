import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      usedFraction: 0.4
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
