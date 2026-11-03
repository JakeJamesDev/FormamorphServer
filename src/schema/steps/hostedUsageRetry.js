const { addColumns } = require('../columns');

/** Marks a Formamorph AI usage row as a proxy retry, or as an attempt the proxy stopped. */
const apply = (database) => addColumns(database, 'hosted_usage', [
  ['retry', 'INTEGER NOT NULL DEFAULT 0'],
  ['stopped', 'INTEGER NOT NULL DEFAULT 0']
]).length > 0;

module.exports = { name: 'hostedUsageRetry', apply };
