const { addColumns } = require('../columns');

/** When staff pinned a listing. Null means not pinned, so there is no backfill. */
const apply = (database) => addColumns(database, 'worlds', [
  ['pinned_at', 'TEXT']
]).length > 0;

module.exports = { name: 'pinnedAt', apply };
