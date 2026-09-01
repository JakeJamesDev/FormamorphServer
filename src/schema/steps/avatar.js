const { addColumns } = require('../columns');

/**
 * The columns a profile image needs on the users table.
 *
 * `avatar_updated_at` is kept even though the filename changes on every upload: it is what the audit log
 * reads, and a null filename with a stamp is the difference between never having set one and having
 * removed one. Nobody has an avatar until they upload one, so there is no backfill.
 */
const apply = (database) => addColumns(database, 'users', [
  ['avatar_file', 'TEXT'],
  ['avatar_updated_at', 'TEXT']
]).length > 0;

module.exports = { name: 'avatar', apply };
