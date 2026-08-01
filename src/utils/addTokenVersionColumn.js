require('dotenv').config();
const db = require('../config/db');

/**
 * Give every account a session generation.
 *
 * A JWT is stateless: once signed it is good until it expires, and nothing the server does afterwards
 * can reach it. So a token lifted from a compromised machine survived the owner changing their password
 * and survived an admin suspending the account — the two things anybody actually does about a breach.
 *
 * This column is the missing handle. A token carries the version it was minted under, `protect` compares
 * it against the row, and bumping the row invalidates every token already out there in one write.
 *
 * Existing rows start at 0, which is also what a token minted before this claim existed is read as — so
 * the migration logs nobody out on the way in.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addTokenVersionColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  if (!tableExists) {
    console.log('No users table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(
    database.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
  );

  if (existing.has('token_version')) {
    console.log('token_version column already exists');
    return false;
  }

  database.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  console.log('Added token_version column to users table');

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addTokenVersionColumn();
  } catch (error) {
    console.error('Error adding token_version column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addTokenVersionColumn };
