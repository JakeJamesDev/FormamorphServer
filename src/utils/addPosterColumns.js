require('dotenv').config();
const db = require('../config/db');

/**
 * Add the poster styling columns to the events table.
 *
 * An organizer's color and artwork for the poster band. Both nullable, because both are optional: an
 * event that sets neither renders in the app's default band, which is exactly what every event created
 * before this migration did.
 *
 * Additive and idempotent — nothing is backfilled and nothing is rewritten, so it is safe on a live
 * database and safe to run twice. Clients older than the columns never ask for them, and a client newer
 * than the server tolerates their absence, so the deploy order does not matter either.
 *
 * Takes the connection so tests can run it against a database still on the pre-poster schema — the case
 * that actually matters, and the one the shared connection cannot reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addPosterColumns = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds `events` with these already on it.
  // Checked by name because `PRAGMA table_info` on a missing table returns an empty list rather than
  // throwing, which is indistinguishable from "table exists, column doesn't".
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
    .get();

  if (!tableExists) {
    console.log('No events table yet — nothing to migrate (createTables builds it with the poster columns)');
    return false;
  }

  const columns = database.prepare('PRAGMA table_info(events)').all().map((column) => column.name);
  let added = false;

  for (const column of ['poster_color', 'poster_image']) {
    if (columns.includes(column)) continue;
    database.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`);
    console.log(`Added ${column} column to events table`);
    added = true;
  }

  if (!added) console.log('poster columns already exist');
  return added;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addPosterColumns();
  } catch (error) {
    console.error('Error adding poster columns:', error);
  } finally {
    db.close();
  }
}

module.exports = { addPosterColumns };
