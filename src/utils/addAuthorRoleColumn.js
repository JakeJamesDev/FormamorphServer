require('dotenv').config();
const db = require('../config/db');

/**
 * Record what a reply's author was when they wrote it.
 *
 * Before this, a thread showed "Formamorph Team" for anyone whose account type was `admin` *right now*,
 * joined live at read time. That made the label retroactive: demote somebody and every reply they ever
 * left changes its signature; promote somebody and their old replies become official team statements.
 * The audit log already avoids exactly this by snapshotting; feedback comments never did.
 *
 * Deliberately not backfilled. There is no way to know what anybody was when they wrote an existing
 * comment — which is the whole reason the column exists. A null reads as "unknown", and the thread falls
 * back to the live join for those, as it always did.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addAuthorRoleColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_comments'")
    .get();

  if (!tableExists) {
    console.log('No feedback_comments table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(
    database.prepare('PRAGMA table_info(feedback_comments)').all().map((column) => column.name)
  );

  if (existing.has('author_role')) {
    console.log('author_role column already exists');
    return false;
  }

  database.exec('ALTER TABLE feedback_comments ADD COLUMN author_role TEXT');
  console.log('Added author_role column to feedback_comments table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addAuthorRoleColumn();
  } catch (error) {
    console.error('Error adding author_role column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addAuthorRoleColumn };
