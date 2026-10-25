const { addColumns } = require('../columns');

/** When an admin marked an account as a trusted author. Null means not trusted, so there is no backfill. */
const apply = (database) => addColumns(database, 'users', [
  ['trusted_at', 'TEXT']
]).length > 0;

module.exports = { name: 'trustedAt', apply };
