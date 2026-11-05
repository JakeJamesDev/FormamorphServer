const { addColumns } = require('../columns');

/** Records how a Formamorph AI call streamed and why it ended. */
const apply = (database) => addColumns(database, 'hosted_usage', [
  ['first_token_ms', 'INTEGER'],
  ['max_gap_ms', 'INTEGER'],
  ['finish_reason', 'TEXT'],
  ['failure', 'TEXT']
]).length > 0;

module.exports = { name: 'hostedUsageDiagnostics', apply };
