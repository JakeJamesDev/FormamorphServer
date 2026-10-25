const { addColumns } = require('../columns');

/** The id of what an audit entry was done to. Older entries keep a null, so there is no backfill. */
const apply = (database) => addColumns(database, 'audit_log', [
  ['target_id', 'TEXT']
]).length > 0;

module.exports = { name: 'auditTarget', apply };
