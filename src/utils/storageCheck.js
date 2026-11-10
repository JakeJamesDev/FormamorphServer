const fsp = require('fs/promises');
const path = require('path');
const StorageDay = require('../models/StorageDay');
const paths = require('../config/paths');
const {
  DIRECTORY_PARTS, PART_NAMES, DISK_ROLES, VACUUM_SPACE_FACTOR,
  R2_FREE_TIER_BYTES, CLOUDFLARE_GRAPHQL_URL, R2_WINDOW_DAYS, R2_READ_TIMEOUT_MS, r2Settings, r2PartName
} = require('../config/storage');
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
 *
 * @returns {Promise<{ id: string, paths: string[], total: number, used: number, free: number, usedFraction: number }[]>} The disks
 */
const readDisks = async () => {
  const byDevice = new Map();

  for (const [role, wanted] of Object.entries(probe.roles)) {
    try {
      const dir = await nearestExisting(wanted);
      const { dev } = await fsp.stat(dir);
      const group = byDevice.get(dev) || { roles: [], paths: [] };
      group.roles.push(role);
      group.paths.push(dir);
      byDevice.set(dev, group);
    } catch (error) {
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
        usedFraction: total > 0 ? used / total : 0
      });
    } catch (error) {
      console.error(`Storage check: cannot read the disk of ${locations[0]}:`, error.message);
    }
  }

  return disks;
};

/**
 * Bytes and file count under a directory. A missing directory holds nothing; any other failure throws.
 * A file that vanishes mid-walk is skipped.
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
      if (error.code === 'ENOENT') continue;
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
 * writes nothing, so its last row stands. Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure at, for tests
 * @returns {Promise<{ stored: string[], failed: string[] }|null>} The names written and the names that failed, or null on a failed run
 */
const checkStorage = async (now = new Date()) => {
  try {
    const rows = [];
    const failed = [];

    for (const disk of await readDisks()) {
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

/**
 * The admin storage report: the disks now, each part as the last run measured it, and whether a vacuum fits.
 *
 * @returns {Promise<{ disks: Object[], parts: Object, vacuumFits: boolean, r2: (Object|null) }>} The report
 */
const buildStorageReport = async () => {
  const stored = StorageDay.latestByName();
  const parts = {};

  for (const name of PART_NAMES) parts[name] = stored.get(name) || null;

  return { disks: await readDisks(), parts, vacuumFits: await vacuumFits(), r2: buildR2Report(stored) };
};

module.exports = { checkStorage, startStorageMonitor, buildStorageReport, setProbe, resetProbe };
