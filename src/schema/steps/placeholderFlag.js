const { addColumns } = require('../columns');

/**
 * The column that says a listing's thumbnail is the server's stand-in rather than art its author sent.
 *
 * Every existing row starts unflagged. `npm run backfill-placeholders` flags the ones that carry the
 * stand-in, and only when somebody runs it.
 */
const apply = (database) =>
  addColumns(database, 'worlds', [['placeholder', 'INTEGER NOT NULL DEFAULT 0']]).length > 0;

module.exports = { name: 'placeholderFlag', apply };
