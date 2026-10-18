const { addColumns } = require('../columns');

/**
 * When a suspension ends. Null on a suspended account means no end, so an account suspended before this
 * column existed stays suspended until staff lift it, and there is nothing to backfill.
 */
const apply = (database) => addColumns(database, 'users', [
  ['suspended_until', 'TEXT']
]).length > 0;

module.exports = { name: 'suspensionEnd', apply };
