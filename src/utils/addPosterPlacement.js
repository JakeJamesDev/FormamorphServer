require('dotenv').config();
const db = require('../config/db');

/**
 * Add the poster placement column to the events table.
 *
 * Where the organizer framed their artwork inside the poster band, as one nullable JSON object. Nullable
 * because framing is optional: an event that has none renders the centered cover every event rendered as
 * before this column existed, which is what lets a client run ahead of this server and the other way
 * round.
 *
 * One column rather than three, because the three numbers are one choice — a client reads all of them or
 * none of them, and a row holding two of the three would be a placement nothing could render.
 *
 * Additive and idempotent — nothing is backfilled and nothing is rewritten, so it is safe on a live
 * database and safe to run twice.
 *
 * Takes the connection so tests can run it against a database still on the pre-placement schema — the
 * case that actually matters, and the one the shared connection cannot reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addPosterPlacement = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds `events` with this already on it.
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
    .get();

  if (!tableExists) {
    console.log('No events table yet — nothing to migrate (createTables builds it with the placement column)');
    return false;
  }

  const columns = database.prepare('PRAGMA table_info(events)').all().map((column) => column.name);

  if (columns.includes('poster_placement')) {
    console.log('poster_placement column already exists');
    return false;
  }

  database.exec('ALTER TABLE events ADD COLUMN poster_placement TEXT');
  console.log('Added poster_placement column to events table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addPosterPlacement();
  } catch (error) {
    console.error('Error adding the poster placement column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addPosterPlacement };
