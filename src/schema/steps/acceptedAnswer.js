const { addColumns, tableExists } = require('../columns');
const { ACCEPTED_ANSWER_TRIGGER, ACCEPTED_ANSWER_TRIGGER_SQL } = require('../triggers');

/**
 * Give a question its accepted answer: one comment on the same thread, or null.
 *
 * The column goes after the `feedbackQuestions` rebuild, which copies a fixed column list, and the trigger
 * after the column. A fresh database gets both from `tables`.
 */

const apply = (database) => {
  if (!tableExists(database, 'feedback')) return false;

  const added = addColumns(database, 'feedback', [
    ['accepted_comment_id', 'TEXT REFERENCES feedback_comments (id) ON DELETE SET NULL']
  ]);

  const hasTrigger = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(ACCEPTED_ANSWER_TRIGGER);
  if (!hasTrigger) database.exec(ACCEPTED_ANSWER_TRIGGER_SQL);

  return added.length > 0 || !hasTrigger;
};

module.exports = { name: 'acceptedAnswer', apply };
