const { addColumns } = require('../columns');

/** Records what a Formamorph AI call was admitted on and which build sent it. */
const apply = (database) => addColumns(database, 'hosted_usage', [
  ['max_tokens', 'INTEGER'],
  ['reserve_micros', 'INTEGER'],
  ['client_version', 'TEXT']
]).length > 0;

module.exports = { name: 'hostedUsageTelemetry', apply };
