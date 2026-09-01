const { addColumns } = require('../columns');

/**
 * Classify each listing as a world, a character, or a dictionary.
 *
 * Every existing row is a world, which the DEFAULT supplies, so there is no backfill pass and nothing to
 * undo.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['kind', "TEXT NOT NULL DEFAULT 'world'"]
]).length > 0;

module.exports = { name: 'kind', apply };
