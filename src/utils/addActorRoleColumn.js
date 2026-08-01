require('dotenv').config();
const db = require('../config/db');

/**
 * Record what an actor was when they acted, rather than only whether they were an administrator.
 *
 * `actor_was_admin` predates the mod team: it was written as `account_type === 'admin'`, so every
 * moderation by a mod or a dev recorded a zero — the same value an ordinary account would get. The log
 * exists to say who did what under whose authority, and it was answering that question wrong for two
 * thirds of the staff.
 *
 * Backfilled from `actor_was_admin`, which is the only thing the old rows know: a 1 was an admin, and a
 * 0 is left null rather than guessed at, since it covers ordinary accounts and the whole mod team alike.
 * Null reads as "unknown", the same as it does on a feedback reply.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addActorRoleColumn = (database = db) => {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'")
    .get();

  if (!tableExists) {
    console.log('No audit_log table yet — nothing to migrate (createTables builds it with the column)');
    return false;
  }

  const existing = new Set(
    database.prepare('PRAGMA table_info(audit_log)').all().map((column) => column.name)
  );

  if (existing.has('actor_role')) {
    console.log('actor_role column already exists');
    return false;
  }

  database.exec('ALTER TABLE audit_log ADD COLUMN actor_role TEXT');
  const filled = database
    .prepare("UPDATE audit_log SET actor_role = 'admin' WHERE actor_was_admin = 1")
    .run();
  console.log(`Added actor_role column to audit_log (${filled.changes} existing admin rows backfilled)`);

  return true;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addActorRoleColumn();
  } catch (error) {
    console.error('Error adding actor_role column:', error);
  } finally {
    db.close();
  }
}

module.exports = { addActorRoleColumn };
