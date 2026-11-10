const fsp = require('fs/promises');
const path = require('path');
const StorageDay = require('../models/StorageDay');
const paths = require('../config/paths');
const { DIRECTORY_PARTS, PART_NAMES, DISK_ROLES, VACUUM_SPACE_FACTOR } = require('../config/storage');
const { hourly } = require('./hourly');
const { utcDay } = require('../config/time');

/**
 * Storage: how full each filesystem is, and how much the upload directories, the database and the local
 * backups use. The hourly job stores the numbers per UTC day; the report adds the disks, read at request time.
 */

/** What the job reads. Tests replace the disk reading and the locations; nothing else is injected. */
const defaults = () => ({
  statfs: (target) => fsp.statfs(target),
  roles: DISK_ROLES,
  directories: DIRECTORY_PARTS,
  dbPath: paths.DB_PATH
});

let probe = defaults();

/** @param {Object} overrides - Any of `statfs`, `roles`, `directories`, `dbPath` */
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

/**
 * The admin storage report: the disks now, each part as the last run measured it, and whether a vacuum fits.
 *
 * @returns {Promise<{ disks: Object[], parts: Object, vacuumFits: boolean }>} The report
 */
const buildStorageReport = async () => {
  const stored = StorageDay.latestByName();
  const parts = {};

  for (const name of PART_NAMES) parts[name] = stored.get(name) || null;

  return { disks: await readDisks(), parts, vacuumFits: await vacuumFits() };
};

module.exports = { checkStorage, startStorageMonitor, buildStorageReport, setProbe, resetProbe };
