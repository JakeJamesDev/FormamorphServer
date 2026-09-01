const { addColumns } = require('../columns');

/**
 * Record that a report has been rewritten since it was filed, since the other reader may already have read
 * the earlier wording. Not backfilled: nothing before this was editable, so a null is the truth.
 */
const apply = (database) => addColumns(database, 'feedback', [
  ['edited_at', 'TEXT']
]).length > 0;

module.exports = { name: 'feedbackEdited', apply };
