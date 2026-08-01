require('dotenv').config();
const db = require('../config/db');

/**
 * The columns quarantine needs on the worlds table.
 *
 * `quarantine_extended` is per-episode rather than per-listing: releasing clears it, so a listing
 * quarantined again months later gets its one grace extension afresh.
 */
const COLUMNS = [
  ['quarantined_at', 'TEXT'],
  ['quarantine_expires_at', 'TEXT'],
  ['quarantine_extended', 'INTEGER NOT NULL DEFAULT 0']
];

/**
 * Add the quarantine columns to the worlds table.
 *
 * The first change this server has made to a table that already exists in production, so it cannot ride
 * on `CREATE TABLE IF NOT EXISTS` the way every table since has. Additive and idempotent: nothing is
 * quarantined until an admin says so, so there is no backfill and nothing to undo. Safe on a live
 * database, and safe to run twice.
 *
 * Takes the connection so tests can run it against a database still on the pre-quarantine schema — the
 * case that actually matters, and the one the shared connection can't reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addQuarantineColumns = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds `worlds` with these already on it, so
  // there is nothing to migrate. Checked explicitly because `PRAGMA table_info` on a missing table
  // returns `[]` rather than throwing, which is indistinguishable from "table exists, column doesn't".
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'")
    .get();

  if (!tableExists) {
    console.log('No worlds table yet — nothing to migrate (createTables builds it with quarantine)');
    return false;
  }

  const existing = new Set(database.prepare('PRAGMA table_info(worlds)').all().map((column) => column.name));
  const missing = COLUMNS.filter(([name]) => !existing.has(name));

  if (missing.length === 0) {
    console.log('quarantine columns already exist');
    return false;
  }

  // One ALTER per column; SQLite takes them one at a time. NOT NULL is safe alongside a DEFAULT, which
  // it backfills existing rows with as the column is added.
  for (const [name, type] of missing) {
    database.exec(`ALTER TABLE worlds ADD COLUMN ${name} ${type}`);
    console.log(`Added ${name} column to worlds table`);
  }

  // The sweeper asks "what is past its deadline" on a schedule, so that lookup earns an index.
  database.exec('CREATE INDEX IF NOT EXISTS idx_worlds_quarantine ON worlds(quarantine_expires_at)');
  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addQuarantineColumns();
  } catch (error) {
    console.error('Error adding quarantine columns:', error);
  } finally {
    db.close();
  }
}

module.exports = { addQuarantineColumns, QUARANTINE_COLUMNS: COLUMNS };
