const { addColumns } = require('../columns');

/**
 * Record that a feedback reply has been rewritten by its author, so the thread can say so. Not backfilled:
 * a null is the truth for every row written before replies were editable.
 */
const apply = (database) => addColumns(database, 'feedback_comments', [
  ['edited_at', 'TEXT']
]).length > 0;

module.exports = { name: 'feedbackCommentEdited', apply };
