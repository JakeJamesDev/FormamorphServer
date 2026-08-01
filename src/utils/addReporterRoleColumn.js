require('dotenv').config();
const db = require('../config/db');

/**
 * Record what a report's author was when they filed it.
 *
 * The same fix `addAuthorRoleColumn` made for replies, for the opening post. A thread's byline was joined
 * live at read time, so a promotion or a demotion rewrote the badge on every report an account had ever
 * filed — and a thread ended up showing a live badge on its opening post above snapshotted ones on the
 * replies beneath it.
 *
 * Deliberately not backfilled. Nothing knows what somebody was when they filed an existing report, which
 * is the whole reason the column exists. A null reads as "unknown" and falls back to the live join, which
 * is what every row did before.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addReporterRoleColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")
    .get();

  if (!tableExists) {
    console.log('No feedback table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(
    database.prepare('PRAGMA table_info(feedback)').all().map((column) => column.name)
  );

  if (existing.has('reporter_role')) {
    console.log('reporter_role column already exists');
    return false;
  }

  database.exec('ALTER TABLE feedback ADD COLUMN reporter_role TEXT');
  console.log('Added reporter_role column to feedback table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addReporterRoleColumn();
  } catch (error) {
    console.error('Error adding reporter_role column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addReporterRoleColumn };
