require('dotenv').config();
const db = require('../config/db');

/**
 * Add the `kind` column to the worlds table, classifying each row as a world, a character, or a
 * dictionary. Additive and idempotent: every existing row is a world, which the DEFAULT supplies, so
 * there is no backfill pass and nothing to undo. Safe to run against a live database.
 *
 * Takes the connection so tests can run it against a database still on the pre-`kind` schema — the case
 * that actually matters, and the one the shared connection can't reproduce.
 */
const addKindColumn = (database = db) => {
  // A fresh database has no schema at all yet — `npm run init-db` creates `worlds` with `kind` already on
  // it, so there is nothing to migrate. Checked explicitly because `PRAGMA table_info` on a missing table
  // returns `[]` rather than throwing, which is indistinguishable from "table exists, column doesn't" —
  // and taking that path would run ALTER TABLE against nothing.
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'")
    .get();

  if (!tableExists) {
    console.log('No worlds table yet — nothing to migrate (init-db creates it with kind)');
    return false;
  }

  const columnExists = database
    .prepare('PRAGMA table_info(worlds)')
    .all()
    .some((column) => column.name === 'kind');

  if (columnExists) {
    console.log('kind column already exists');
    return false;
  }

  // NOT NULL is safe alongside a DEFAULT: SQLite backfills existing rows with it as the column is added.
  database.exec(`
    ALTER TABLE worlds
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'world'
  `);
  console.log('Added kind column to worlds table');
  console.log("All existing rows are classified as 'world' by default");

  // Every listing query filters on kind, so it earns an index.
  database.exec('CREATE INDEX IF NOT EXISTS idx_worlds_kind ON worlds(kind)');
  console.log('Added idx_worlds_kind index');
  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addKindColumn();
  } catch (error) {
    console.error('Error adding kind column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addKindColumn };
