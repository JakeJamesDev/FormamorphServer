const Setting = require('../models/Setting');
const { alertAdmins } = require('./hostedAlerts');
const { ALERT_LEVELS, STORAGE_ALERTS } = require('../config/storage');

/**
 * Disk-full alerts: one mail to the admins when a filesystem reaches a level it had not reached. The state is
 * the highest level each filesystem is at, so a hold at one level is silent and a drop arms the level again.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** A byte count in the largest unit that keeps it at 1 or more. */
const formatBytes = (bytes) => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
};

/** The highest level a fraction reaches, or null under every level. */
const levelOf = (usedFraction) => ALERT_LEVELS.filter((level) => usedFraction >= level).pop() ?? null;

const alertOf = (disk, level) => {
  const used = `${(disk.usedFraction * 100).toFixed(1)}%`;

  return {
    subject: `Disk ${disk.id} is ${Math.round(level * 100)}% full`,
    body: `The filesystem ${disk.id} (${disk.paths.join(', ')}) is ${used} used, with ${formatBytes(disk.free)} free.`
  };
};

/**
 * Compare each disk with its stored level and alert the admins on a rise. A disk missing from `disks` keeps its
 * state. Never throws.
 *
 * @param {{ id: string, paths: string[], free: number, usedFraction: number }[]} disks - This run's disk reading
 * @returns {Promise<string[]>} The subjects of the mails sent
 */
const alertOnDisks = async (disks) => {
  try {
    const state = { ...Setting.get(STORAGE_ALERTS) };
    const pending = [];

    for (const disk of disks) {
      const level = levelOf(disk.usedFraction);
      if (level !== null && level > (state[disk.id] ?? 0)) pending.push(alertOf(disk, level));
      if (level === null) delete state[disk.id];
      else state[disk.id] = level;
    }

    // Stored before the mails go out, so a slow or failed mail is never repeated next hour.
    Setting.set(STORAGE_ALERTS, state);
    for (const alert of pending) await alertAdmins(alert);

    return pending.map((alert) => alert.subject);
  } catch (error) {
    console.error('Storage alert failed:', error.message);
    return [];
  }
};

module.exports = { alertOnDisks };
