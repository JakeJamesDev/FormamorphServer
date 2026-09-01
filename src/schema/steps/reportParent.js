const { addColumns } = require('../columns');

/**
 * Where a report's target sits, when it sits inside something: a comment's listing. The queue's "view in
 * context" needs it, since the target id alone names a comment nothing can navigate to. Nullable and not
 * backfilled, because a report filed before the column existed has no answer for it.
 */
const apply = (database) => addColumns(database, 'reports', [
  ['target_parent_id', 'TEXT']
]).length > 0;

module.exports = { name: 'reportParent', apply };
