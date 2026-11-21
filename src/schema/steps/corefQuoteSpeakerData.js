const { addColumns } = require('../columns');

/** Stores what the player saw: the persona id, the cast, each quote's shown speaker, and the versions. All null when absent. */
const apply = (database) => addColumns(database, 'coref_contributions', [
  ['player_id', 'TEXT'],
  ['cast_members', 'TEXT'],
  ['quotes', 'TEXT'],
  ['client_version', 'TEXT'],
  ['reading_version', 'INTEGER']
]).length > 0;

module.exports = { name: 'corefQuoteSpeakerData', apply };
