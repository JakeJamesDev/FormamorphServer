const { addColumns } = require('../columns');

/**
 * Record what an actor was when they acted, rather than only whether they were an administrator.
 *
 * `actor_was_admin` predates the mod team: every moderation by a mod or a dev recorded a zero, the same
 * value an ordinary account would get. Backfilled from that flag, which is all the old rows know: a 1 was
 * an admin, and a 0 is left null rather than guessed at, since it covers ordinary accounts and the whole
 * mod team alike.
 */
const apply = (database) => {
  const added = addColumns(database, 'audit_log', [['actor_role', 'TEXT']]);
  if (added.length === 0) return false;

  database.prepare("UPDATE audit_log SET actor_role = 'admin' WHERE actor_was_admin = 1").run();
  return true;
};

module.exports = { name: 'actorRole', apply };
