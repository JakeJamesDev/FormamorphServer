const { tableExists } = require('../columns');

/**
 * One row per measured name per UTC day: a disk's total or used bytes, a directory, the database, or the
 * local backups. Long format, so a new directory needs a new name and no schema step.
 *
 * `files` is null on a disk row. `measured_at` is the ISO time of the run that wrote the row.
 */
const apply = (database) => {
  if (tableExists(database, 'storage_days')) return false;

  database.exec(`
    CREATE TABLE storage_days (
      day TEXT NOT NULL,
      name TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      files INTEGER,
      measured_at TEXT NOT NULL,
      PRIMARY KEY (day, name)
    );
  `);

  return true;
};

module.exports = { name: 'storageDays', apply };
