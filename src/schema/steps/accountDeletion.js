const { addColumns } = require('../columns');

/**
 * The columns a pending deletion needs on the users table.
 *
 * Both are null and zero until somebody asks, so there is no backfill: an account that has never asked to
 * leave reads exactly as it did before these existed.
 */
const apply = (database) => addColumns(database, 'users', [
  ['deletion_requested_at', 'TEXT'],
  ['deletion_removes_content', 'INTEGER NOT NULL DEFAULT 0']
]).length > 0;

module.exports = { name: 'accountDeletion', apply };
