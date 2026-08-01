require('dotenv').config();
const db = require('../config/db');

/**
 * The columns a profile image needs on the users table.
 *
 * `avatar_updated_at` is kept even though the filename changes on every upload: it is what the audit log
 * and any future "changed recently" question read, and a null filename with a stamp is the difference
 * between never having set one and having removed one.
 */
const COLUMNS = [
  ['avatar_file', 'TEXT'],
  ['avatar_updated_at', 'TEXT']
];

/**
 * Add the avatar columns to the users table.
 *
 * A change to a table that already exists in production, so it cannot ride on `CREATE TABLE IF NOT
 * EXISTS` — that statement creates tables and never adds columns. Additive and idempotent: nobody has an
 * avatar until they upload one, so there is no backfill and nothing to undo. Safe on a live database,
 * and safe to run twice.
 *
 * Takes the connection so tests can run it against a database still on the pre-avatar schema — the case
 * that actually matters, and the one the shared connection can't reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addAvatarColumns = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds `users` with these already on it, so
  // there is nothing to migrate. Checked explicitly because `PRAGMA table_info` on a missing table
  // returns an empty list rather than throwing, which is indistinguishable from "table exists, column
  // doesn't".
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  if (!tableExists) {
    console.log('No users table yet — nothing to migrate (createTables builds it with the avatar columns)');
    return false;
  }

  const existing = new Set(database.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  const missing = COLUMNS.filter(([name]) => !existing.has(name));

  if (missing.length === 0) {
    console.log('avatar columns already exist');
    return false;
  }

  // One ALTER per column; SQLite takes them one at a time.
  for (const [name, type] of missing) {
    database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    console.log(`Added ${name} column to users table`);
  }

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addAvatarColumns();
  } catch (error) {
    console.error('Error adding avatar columns:', error);
  } finally {
    db.close();
  }
}

module.exports = { addAvatarColumns, AVATAR_COLUMNS: COLUMNS };
