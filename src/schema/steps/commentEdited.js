const { addColumns } = require('../columns');

/**
 * Record that a comment has been rewritten since it was left.
 *
 * `updated_at` cannot answer this: it is stamped at insert, so a never-edited comment is indistinguishable
 * from an edited one. Not backfilled: nothing before this was editable, so a null is the truth.
 */
const apply = (database) => addColumns(database, 'comments', [
  ['edited_at', 'TEXT']
]).length > 0;

module.exports = { name: 'commentEdited', apply };
