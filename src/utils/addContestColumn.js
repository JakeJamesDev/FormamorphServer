require('dotenv').config();
const db = require('../config/db');

/**
 * Add the contest entry column to the worlds table.
 *
 * An entry is a flag on the listing rather than a row of its own: entry happens at publish and nowhere
 * else, so a listing belongs to at most one contest for its whole life, and a join table's history would
 * record something that cannot happen. What history there is — a withdrawal — lives in the audit log.
 *
 * `ON DELETE SET NULL` rather than the default. `foreign_keys` is on, so a plain reference would make an
 * event with entries impossible to delete, and deleting an event nobody was told about is exactly what
 * the delete route is for.
 *
 * Additive and idempotent: nothing is entered in anything until somebody publishes into a contest, so
 * there is no backfill and nothing to undo. Safe on a live database, and safe to run twice.
 *
 * Takes the connection so tests can run it against a database still on the pre-contest schema — the case
 * that actually matters, and the one the shared connection cannot reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addContestColumn = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds `worlds` with this already on it. Checked
  // by name because `PRAGMA table_info` on a missing table returns an empty list rather than throwing,
  // which is indistinguishable from "table exists, column doesn't".
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'")
    .get();

  if (!tableExists) {
    console.log('No worlds table yet — nothing to migrate (createTables builds it with the contest column)');
    return false;
  }

  const existing = database.prepare('PRAGMA table_info(worlds)').all().some((column) => column.name === 'contest_event_id');

  if (existing) {
    console.log('contest_event_id column already exists');
    return false;
  }

  // SQLite allows a REFERENCES clause on an added column only when it defaults to NULL, which this does.
  database.exec(`
    ALTER TABLE worlds
    ADD COLUMN contest_event_id TEXT REFERENCES events (id) ON DELETE SET NULL
  `);
  console.log('Added contest_event_id column to worlds table');

  // The contest tab asks for one event's entries and the publish route asks whether one person already
  // has one, so this column is looked up by value far more often than it is written.
  database.exec('CREATE INDEX IF NOT EXISTS idx_worlds_contest ON worlds(contest_event_id)');
  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addContestColumn();
  } catch (error) {
    console.error('Error adding contest column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addContestColumn };
