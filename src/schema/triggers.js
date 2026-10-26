/**
 * Triggers shared by the fresh schema in `tables` and the step that adds each one to an older database.
 */

/**
 * Returns an `answered` question to `open` when its accepted comment is deleted. It must run `BEFORE`:
 * SQLite applies the `SET NULL` action before an `AFTER` trigger runs, so an `AFTER` trigger never finds
 * the match. A later rebuild of `feedback` must drop this trigger first and create it again after.
 */
const ACCEPTED_ANSWER_TRIGGER = 'feedback_accepted_comment_deleted';

const ACCEPTED_ANSWER_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS ${ACCEPTED_ANSWER_TRIGGER}
  BEFORE DELETE ON feedback_comments
  FOR EACH ROW
  BEGIN
    UPDATE feedback
    SET accepted_comment_id = NULL,
        status = CASE WHEN status = 'answered' THEN 'open' ELSE status END
    WHERE id = OLD.feedback_id AND accepted_comment_id = OLD.id;
  END
`;

module.exports = { ACCEPTED_ANSWER_TRIGGER, ACCEPTED_ANSWER_TRIGGER_SQL };
