const { addColumns } = require('../columns');

/** Stores the name of each entity a contribution references, as JSON `{ entityId: name }`, for staff review. */
const apply = (database) => addColumns(database, 'coref_contributions', [
  ['entity_names', "TEXT NOT NULL DEFAULT '{}'"]
]).length > 0;

module.exports = { name: 'corefEntityNames', apply };
