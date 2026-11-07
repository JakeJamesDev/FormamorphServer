const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const db = require('../config/db');
const Setting = require('../models/Setting');
const { HiddenGem } = require('../models/HiddenGem');
const { HIDDEN_GEM_BACKFILL } = require('../config/settings');
const { DAY_MS, utcDay } = require('../config/time');

/** The nightly backup runs at 04:17 UTC; its file name holds only the date. */
const NIGHTLY_TIME = 'T04:17:00.000Z';

const NIGHTLY_NAME = /^db-(\d{4}-\d{2}-\d{2})\.db(\.zst)?$/;
const PRE_DEPLOY_NAME = /^pre-deploy-[0-9a-f]+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[.-](\d+))?Z\.db$/;

/**
 * When a backup was taken, read from its file name.
 *
 * @param {string} file - A backup path
 * @returns {Date} The backup's time
 */
const backupTime = (file) => {
  const name = path.basename(file);
  const nightly = NIGHTLY_NAME.exec(name);
  const preDeploy = PRE_DEPLOY_NAME.exec(name);
  let iso = null;

  if (nightly) iso = `${nightly[1]}${NIGHTLY_TIME}`;
  // Older names end in `-NNNZ` milliseconds, newer ones in `.NNNZ`.
  if (preDeploy) iso = `${preDeploy[1]}T${preDeploy[2]}:${preDeploy[3]}:${preDeploy[4]}.${preDeploy[5] ?? '0'}Z`;

  const time = iso ? new Date(iso) : null;
  if (!time || Number.isNaN(time.getTime())) throw new Error(`No backup time in the file name: ${name}`);

  return time;
};

/**
 * Each world's download counter in a backup. The file is read into memory and never opened for writing.
 *
 * @param {string} file - A `.db` or `.db.zst` backup
 * @returns {Map<string, number>} Counter by world id
 */
const readCounters = (file) => {
  const raw = fs.readFileSync(file);
  const bytes = file.endsWith('.zst') ? zlib.zstdDecompressSync(raw) : raw;

  // A WAL-mode header will not open from memory; a finished backup has no WAL frames, so mark it rollback.
  if (bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;

  const backup = new Database(bytes, { readonly: true });
  try {
    const rows = backup.prepare('SELECT id, downloads FROM worlds').all();
    return new Map(rows.map((row) => [row.id, row.downloads || 0]));
  } finally {
    backup.close();
  }
};

/**
 * The UTC days a gap's downloads spread over: after the earlier day, up to and including the later one.
 * Two backups on one day give that day.
 *
 * @param {Date} earlier - The earlier backup's time
 * @param {Date} later - The later backup's time
 * @returns {string[]} UTC `YYYY-MM-DD` days, ascending
 */
const spanDays = (earlier, later) => {
  const last = utcDay(later);
  const days = [];

  for (let t = Date.parse(`${utcDay(earlier)}T00:00:00Z`) + DAY_MS; utcDay(new Date(t)) <= last; t += DAY_MS) {
    days.push(utcDay(new Date(t)));
  }

  return days.length > 0 ? days : [last];
};

/**
 * The buckets the backups imply, for worlds still in the live table.
 *
 * @param {string[]} files - Backups in time order, the pre-deploy backup last
 * @returns {{ buckets: Map<string, Map<string, number>>, downloads: number, skipped: number }}
 *   Count by day by world id, their total, and how many backup world ids no longer exist
 */
const planBuckets = (files) => {
  if (files.length < 2) throw new Error('Give at least two backups.');

  const times = files.map(backupTime);
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] <= times[i - 1]) {
      throw new Error(`Backups are out of time order: ${path.basename(files[i])} is not after ${path.basename(files[i - 1])}`);
    }
  }

  const live = new Set(db.prepare('SELECT id FROM worlds').pluck().all());
  const skippedIds = new Set();
  const buckets = new Map();
  let downloads = 0;
  let earlier = readCounters(files[0]);

  for (let i = 1; i < files.length; i += 1) {
    const later = readCounters(files[i]);
    const days = spanDays(times[i - 1], times[i]);

    for (const [id, counter] of later) {
      const gain = Math.max(0, counter - (earlier.get(id) || 0));
      if (gain === 0) continue;
      if (!live.has(id)) {
        skippedIds.add(id);
        continue;
      }

      const share = Math.floor(gain / days.length);
      const byDay = buckets.get(id) || new Map();
      days.forEach((day, index) => {
        const count = share + (index === days.length - 1 ? gain % days.length : 0);
        if (count > 0) byDay.set(day, (byDay.get(day) || 0) + count);
      });
      buckets.set(id, byDay);
      downloads += gain;
    }

    earlier = later;
  }

  return { buckets, downloads, skipped: skippedIds.size };
};

/** Throw when the backfill already ran. */
const refuseRerun = () => {
  const ran = Setting.get(HIDDEN_GEM_BACKFILL);
  if (ran) throw new Error(`The backfill already ran at ${ran.ranAt}.`);
};

/**
 * Rebuild the daily download log from backups, once. Adds to buckets the live log already holds. On write,
 * it also replaces every rotation with a fresh one scored on the rebuilt log.
 *
 * @param {string[]} files - Backups in time order, the pre-deploy backup last
 * @param {Object} [options]
 * @param {boolean} [options.write] - Store the buckets; without it, only count them
 * @param {Date} [options.now] - The run's time, for tests
 * @returns {{ worlds: number, buckets: number, downloads: number, skipped: number, picks: string[]|null }}
 */
const backfillDownloadDays = (files, { write = false, now = new Date() } = {}) => {
  refuseRerun();

  const { buckets, downloads, skipped } = planBuckets(files);
  const summary = {
    worlds: buckets.size,
    buckets: [...buckets.values()].reduce((sum, byDay) => sum + byDay.size, 0),
    downloads,
    skipped,
    picks: null
  };

  if (!write) return summary;

  const add = db.prepare(`
    INSERT INTO world_download_days (world_id, day, count) VALUES (?, ?, ?)
    ON CONFLICT (world_id, day) DO UPDATE SET count = count + excluded.count
  `);

  summary.picks = db.transaction(() => {
    refuseRerun();

    for (const [id, byDay] of buckets) {
      for (const [day, count] of byDay) add.run(id, day, count);
    }
    Setting.set(HIDDEN_GEM_BACKFILL, {
      ranAt: now.toISOString(), backups: files.map((file) => path.basename(file)), downloads
    });

    // Every rotation so far scored an almost empty log.
    db.prepare('DELETE FROM hidden_gem_rotations').run();
    return HiddenGem.rotate(now);
  })();

  return summary;
};

module.exports = { backfillDownloadDays };
