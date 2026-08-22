require('dotenv').config();
const db = require('../config/db');

/**
 * Record that a comment has been rewritten since it was left.
 *
 * `updated_at` cannot answer this: it is stamped at insert, so every row has one and a never-edited
 * comment is indistinguishable from an edited one. Not backfilled — nothing before this was editable,
 * so every existing row is genuinely unedited and a null is the truth rather than a gap.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addCommentEditedColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'")
    .get();

  if (!tableExists) {
    console.log('No comments table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(
    database.prepare('PRAGMA table_info(comments)').all().map((column) => column.name)
  );

  if (existing.has('edited_at')) {
    console.log('comments edited_at column already exists');
    return false;
  }

  database.exec('ALTER TABLE comments ADD COLUMN edited_at TEXT');
  console.log('Added edited_at column to comments table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addCommentEditedColumn();
  } catch (error) {
    console.error('Error adding the comment edited_at column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addCommentEditedColumn };
