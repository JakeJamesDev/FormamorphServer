const { addColumns } = require('../columns');

/**
 * The stamp that says an account's email is proven to be theirs.
 *
 * Null on every existing row, and correctly so: no client ever collected an address, so there is nothing
 * out there to backfill and nobody is marked verified who never proved anything. The unique index on
 * `email` that goes with this column is in the indexes step, which runs last for the usual reason.
 */
const apply = (database) => addColumns(database, 'users', [
  ['email_verified_at', 'TEXT']
]).length > 0;

module.exports = { name: 'emailVerification', apply };
