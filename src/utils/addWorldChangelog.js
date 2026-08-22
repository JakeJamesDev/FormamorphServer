require('dotenv').config();
const db = require('../config/db');

/**
 * The changelog table, worded exactly as `createTables` builds it so a fresh database and a migrated one
 * match. Kept as its own constant for the same reason the podium migration does: the two copies are the
 * thing that can drift, so they sit somewhere a reader can put them side by side.
 */
const CHANGELOG_TABLE = `
  CREATE TABLE IF NOT EXISTS world_changelog (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
  )
`;

/**
 * Give an existing database the listing changelog table.
 *
 * A new *table* is something `createTables` already covers, so this exists for the same reason the boot
 * sequence runs both: to be the one named step, alongside every other, that a future column on this table
 * can be added to. Idempotent — a second run finds it built and changes nothing.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addWorldChangelog = (database = db) => {
  const worldsExist = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'")
    .get();

  // Built before its parent, the foreign key would point at nothing. A database with no `worlds` table is
  // a fresh one, where `createTables` builds both in order anyway.
  if (!worldsExist) {
    console.log('No worlds table yet — nothing to migrate (createTables builds the changelog with it)');
    return false;
  }

  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_changelog'")
    .get();

  if (existing) {
    console.log('world_changelog table already exists');
    return false;
  }

  database.exec(CHANGELOG_TABLE);
  console.log('Created world_changelog table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addWorldChangelog();
  } catch (error) {
    console.error('Error adding the world changelog table:', error);
  } finally {
    db.close();
  }
}

module.exports = { addWorldChangelog };
