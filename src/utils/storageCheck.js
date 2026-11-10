const fsp = require('fs/promises');
const path = require('path');
const StorageDay = require('../models/StorageDay');
const paths = require('../config/paths');
const World = require('../models/World');
const {
  DIRECTORY_PARTS, PART_NAMES, DISK_ROLES, VACUUM_SPACE_FACTOR, ALERT_LEVELS,
  R2_FREE_TIER_BYTES, CLOUDFLARE_GRAPHQL_URL, R2_WINDOW_DAYS, R2_READ_TIMEOUT_MS, r2Settings, r2PartName,
  REPORT_DEFAULT_DAYS, FORECAST_WINDOW_DAYS, FORECAST_MIN_DAYS
} = require('../config/storage');
const { alertOnDisks } = require('./storageAlerts');
const { hourly } = require('./hourly');
const { utcDay, DAY_MS } = require('../config/time');

/**
 * Storage: how full each filesystem is, and how much the upload directories, the database and the local
 * backups use. The hourly job stores the numbers per UTC day; the report adds the disks, read at request time.
 */

/** What the job reads. Tests replace the disk reading, the Cloudflare fetch and the locations. */
const defaults = () => ({
  statfs: (target) => fsp.statfs(target),
  fetch: (url, init) => fetch(url, init),
  roles: DISK_ROLES,
  directories: DIRECTORY_PARTS,
  dbPath: paths.DB_PATH
});

let probe = defaults();

/** @param {Object} overrides - Any of `statfs`, `fetch`, `roles`, `directories`, `dbPath` */
const setProbe = (overrides) => { probe = { ...probe, ...overrides }; };
const resetProbe = () => { probe = defaults(); };

/** The path itself, or its nearest ancestor that exists: a backups directory is not made until the first backup. */
const nearestExisting = async (target) => {
  let current = target;
  for (;;) {
    try {
      await fsp.stat(current);
      return current;
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
};

/**
 * Every filesystem the roles live on, once. Roles on one device join into one id in role order.
 * `complete` is false when a role could not be read: the ids then miss that role and match no stored id.
 *
 * @returns {Promise<{ disks: { id: string, paths: string[], total: number, used: number, free: number, usedFraction: number }[], complete: boolean }>} The disks
 */
const readDiskState = async () => {
  const byDevice = new Map();
  let complete = true;

  for (const [role, wanted] of Object.entries(probe.roles)) {
    try {
      const dir = await nearestExisting(wanted);
      const { dev } = await fsp.stat(dir);
      const group = byDevice.get(dev) || { roles: [], paths: [] };
      group.roles.push(role);
      group.paths.push(dir);
      byDevice.set(dev, group);
    } catch (error) {
      complete = false;
      console.error(`Storage check: cannot read ${role} at ${wanted}:`, error.message);
    }
  }

  const disks = [];
  for (const { roles, paths: locations } of byDevice.values()) {
    try {
      const { bsize, blocks, bfree, bavail } = await probe.statfs(locations[0]);
      const total = blocks * bsize;
      const used = (blocks - bfree) * bsize;
      disks.push({
        id: roles.join('+'),
        paths: locations,
        total,
        used,
        free: bavail * bsize,
        usedFraction: total > 0 ? used / total : 0,
        alertLevels: ALERT_LEVELS
      });
    } catch (error) {
      console.error(`Storage check: cannot read the disk of ${locations[0]}:`, error.message);
    }
  }

  return { disks, complete };
};

const readDisks = async () => (await readDiskState()).disks;

/**
 * Bytes and file count under a directory. A missing root throws, so a dropped mount never stores a zero.
 * A subdirectory or file that vanishes mid-walk is skipped.
 *
 * @param {string} root - The directory
 * @returns {Promise<{ bytes: number, files: number }>} The totals
 */
const walk = async (root) => {
  let bytes = 0;
  let files = 0;
  const pending = [root];

  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' && current !== root) continue;
      throw error;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await fsp.lstat(full)).size;
          files += 1;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  return { bytes, files };
};

/** The database file with its WAL. The WAL is absent after a clean checkpoint. */
const measureDatabase = async () => {
  const main = await fsp.stat(probe.dbPath);
  let bytes = main.size;
  let files = 1;

  try {
    bytes += (await fsp.stat(`${probe.dbPath}-wal`)).size;
    files += 1;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { bytes, files };
};

/**
 * The newest stored size of each bucket, from one Cloudflare GraphQL request. A bucket with no row in the
 * window is absent from the result. Throws on any failed read; the message never holds the token.
 *
 * @param {{ token: string, accountId: string, buckets: string[] }} settings - From `r2Settings`
 * @param {Date} now - The end of the window
 * @returns {Promise<Map<string, { bytes: number, files: number }>>} By bucket name
 */
const readR2Sizes = async ({ token, accountId, buckets }, now) => {
  const since = new Date(now.getTime() - R2_WINDOW_DAYS * DAY_MS).toISOString();
  const until = now.toISOString();
  const fields = buckets.map((bucket, index) => `b${index}: r2StorageAdaptiveGroups(
      limit: 10, orderBy: [datetime_DESC],
      filter: { datetime_geq: ${JSON.stringify(since)}, datetime_leq: ${JSON.stringify(until)}, bucketName: ${JSON.stringify(bucket)} }
    ) { dimensions { datetime bucketName } max { payloadSize metadataSize objectCount } }`);
  const query = `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) { ${fields.join('\n')} } } }`;

  const response = await probe.fetch(CLOUDFLARE_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(R2_READ_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`The R2 read answered ${response.status}`);

  const reply = await response.json();
  if (reply?.errors?.length) throw new Error(`The R2 read returned errors: ${reply.errors.map((e) => e?.message).join('; ')}`);
  const account = reply?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('The R2 reply has no account');

  const sizes = new Map();
  buckets.forEach((bucket, index) => {
    const rows = account[`b${index}`];
    const newest = Array.isArray(rows) ? rows[0]?.max : undefined;
    if (Array.isArray(rows) && !newest) return;
    const { payloadSize, metadataSize, objectCount } = newest || {};
    if (![payloadSize, metadataSize, objectCount].every(Number.isFinite)) throw new Error('The R2 reply is malformed');
    sizes.set(bucket, { bytes: payloadSize + metadataSize, files: objectCount });
  });

  return sizes;
};

/**
 * Measure the disks and every part, and store them under today's UTC day. A part that fails to measure
 * writes nothing, so its last row stands; so do the disks when a role cannot be read, and that run sends no
 * alert. Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure at, for tests
 * @returns {Promise<{ stored: string[], failed: string[] }|null>} The names written and the names that failed, or null on a failed run
 */
const checkStorage = async (now = new Date()) => {
  try {
    const rows = [];
    const failed = [];

    const state = await readDiskState();
    const disks = state.complete ? state.disks : [];
    if (!state.complete) failed.push('disks');
    for (const disk of disks) {
      rows.push({ name: `disk:${disk.id}:total`, bytes: disk.total, files: null });
      rows.push({ name: `disk:${disk.id}:used`, bytes: disk.used, files: null });
    }

    const measures = [
      ...Object.entries(probe.directories).map(([name, dir]) => [name, () => walk(dir)]),
      ['database', measureDatabase]
    ];
    const results = await Promise.allSettled(measures.map(([, measure]) => measure()));

    results.forEach((result, index) => {
      const name = measures[index][0];
      if (result.status === 'fulfilled') {
        rows.push({ name, ...result.value });
      } else {
        failed.push(name);
        console.error(`Storage check: measuring ${name} failed:`, result.reason?.message);
      }
    });

    const r2 = r2Settings();
    if (r2) {
      try {
        for (const [bucket, size] of await readR2Sizes(r2, now)) rows.push({ name: r2PartName(bucket), ...size });
      } catch (error) {
        failed.push('r2');
        console.error('Storage check: reading R2 failed:', error.message);
      }
    }

    StorageDay.replace(utcDay(now), rows, now.toISOString());
    await alertOnDisks(disks);

    return { stored: rows.map((row) => row.name), failed };
  } catch (error) {
    console.error('Storage check failed:', error.message);
    return null;
  }
};

const startStorageMonitor = () => hourly(checkStorage);

/** Whether the filesystem that holds the database has room for a VACUUM, which needs twice the file. */
const vacuumFits = async () => {
  try {
    const { size } = await fsp.stat(probe.dbPath);
    const { bsize, bavail } = await probe.statfs(path.dirname(probe.dbPath));

    return bavail * bsize >= VACUUM_SPACE_FACTOR * size;
  } catch {
    return false;
  }
};

/** The R2 part: each configured bucket's newest stored size, or null while it has none. Null when R2 is off. */
const buildR2Report = (stored) => {
  const settings = r2Settings();
  if (!settings) return null;

  const buckets = {};
  for (const bucket of settings.buckets) {
    const row = stored.get(r2PartName(bucket));
    buckets[bucket] = row ? { bytes: row.bytes, objects: row.files, checkedAt: row.measuredAt } : null;
  }

  return { freeTierBytes: R2_FREE_TIER_BYTES, buckets };
};

const dayOffset = (now, offset) => utcDay(new Date(Date.parse(utcDay(now)) - offset * DAY_MS));

/** One entry per UTC day, newest first: the stored values by name (null for no row) and the day's downloads. */
const historyDays = (rows, days, now) => {
  const names = new Set(PART_NAMES);
  const byDay = new Map();
  const firstDay = dayOffset(now, days - 1);

  for (const row of rows) {
    if (row.day < firstDay) continue;
    names.add(row.name);
    if (!byDay.has(row.day)) byDay.set(row.day, new Map());
    byDay.get(row.day).set(row.name, { bytes: row.bytes, files: row.files });
  }

  const downloads = new Map(World.downloadsPerDaySince(firstDay).map((row) => [row.day, row.downloads]));
  const columns = [...PART_NAMES, ...[...names].filter((name) => !PART_NAMES.includes(name)).sort()];

  return Array.from({ length: days }, (_, index) => {
    const day = dayOffset(now, index);
    const stored = byDay.get(day);

    return {
      day,
      values: Object.fromEntries(columns.map((name) => [name, (stored && stored.get(name)) || null])),
      downloads: downloads.get(day) || 0
    };
  });
};

/**
 * Days until a disk is full: a least-squares line through its daily `used` values of the last window, read
 * from the line at today. Null with too few measured days, or when the line does not rise.
 */
const daysUntilFull = (rows, disk, now) => {
  const firstDay = dayOffset(now, FORECAST_WINDOW_DAYS - 1);
  const origin = Date.parse(firstDay);
  const points = rows
    .filter((row) => row.name === `disk:${disk.id}:used` && row.day >= firstDay)
    .map((row) => [(Date.parse(row.day) - origin) / DAY_MS, row.bytes]);

  if (points.length < FORECAST_MIN_DAYS) return null;

  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const spread = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  const slope = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / spread;

  if (!(slope > 0)) return null;

  const today = FORECAST_WINDOW_DAYS - 1;
  const usedToday = meanY + slope * (today - meanX);

  // The small bias keeps an exact division from rounding down to the day before.
  return Math.max(0, Math.floor((disk.total - usedToday) / slope + 1e-9));
};

/**
 * The admin storage report: the disks now, each part as the last run measured it, whether a vacuum fits,
 * the stored history per UTC day with downloads, and the days until each disk is full.
 *
 * @param {number} [days] - How many UTC days of history, today included
 * @param {Date} [now] - The clock
 * @returns {Promise<{ disks: Object[], parts: Object, vacuumFits: boolean, days: Object[], forecast: Object }>} The report
 */
const buildStorageReport = async (days = REPORT_DEFAULT_DAYS, now = new Date()) => {
  const stored = StorageDay.latestByName();
  const parts = {};

  for (const name of PART_NAMES) parts[name] = stored.get(name) || null;

  const rows = StorageDay.since(dayOffset(now, Math.max(days, FORECAST_WINDOW_DAYS) - 1));
  const disks = await readDisks();
  const forecast = Object.fromEntries(disks.map((disk) => [disk.id, { daysUntilFull: daysUntilFull(rows, disk, now) }]));

  return { disks, parts, vacuumFits: await vacuumFits(), r2: buildR2Report(stored), days: historyDays(rows, days, now), forecast };
};

module.exports = { checkStorage, startStorageMonitor, buildStorageReport, setProbe, resetProbe };
