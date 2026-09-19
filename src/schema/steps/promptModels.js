const { addColumns } = require('../columns');

/**
 * The models a prompt listing says it works with, as a JSON array of strings.
 *
 * On every row rather than prompt rows alone, so every kind reads back a list. The DEFAULT gives each
 * existing row an empty one, so there is no backfill pass.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['models', "TEXT NOT NULL DEFAULT '[]'"]
]).length > 0;

module.exports = { name: 'promptModels', apply };
