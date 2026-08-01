require('dotenv').config();
const db = require('../config/db');

/**
 * Record that a report has been rewritten since it was filed.
 *
 * The other reader may already have read the earlier wording — the same reason a comment carries one.
 * Not backfilled: nothing before this was editable, so every existing row is genuinely unedited and a
 * null is the truth rather than a gap.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addFeedbackEditedColumn = (database = db) => {
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

  if (existing.has('edited_at')) {
    console.log('feedback edited_at column already exists');
    return false;
  }

  database.exec('ALTER TABLE feedback ADD COLUMN edited_at TEXT');
  console.log('Added edited_at column to feedback table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addFeedbackEditedColumn();
  } catch (error) {
    console.error('Error adding the feedback edited_at column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addFeedbackEditedColumn };
