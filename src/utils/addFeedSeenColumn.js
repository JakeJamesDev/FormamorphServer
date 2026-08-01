require('dotenv').config();
const db = require('../config/db');

/**
 * Remember when somebody last opened their notification feed.
 *
 * The feed itself is computed — listings by the accounts you follow, newer than when you followed them —
 * so there is no notifications table and nothing to mark read row by row. This one stamp is the whole of
 * the unread state.
 *
 * Null means never opened, which reads as "everything since you started following is new". That is the
 * right answer for an existing account as well as a new one, so there is nothing to backfill.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addFeedSeenColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  if (!tableExists) {
    console.log('No users table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(database.prepare('PRAGMA table_info(users)').all().map((column) => column.name));

  if (existing.has('feed_seen_at')) {
    console.log('feed_seen_at column already exists');
    return false;
  }

  database.exec('ALTER TABLE users ADD COLUMN feed_seen_at TEXT');
  console.log('Added feed_seen_at column to users table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addFeedSeenColumn();
  } catch (error) {
    console.error('Error adding the feed_seen_at column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addFeedSeenColumn };
