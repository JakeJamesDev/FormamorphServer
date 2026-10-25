/**
 * Give feedback its third branch, the question.
 *
 * SQLite cannot change a CHECK in place, so the table is rebuilt with the question branch in its `type`,
 * `category` and `status` checks. The step knows it has run when the stored `CREATE TABLE feedback` names
 * `question`.
 *
 * The shape below is frozen at this point in the schema's history, after `reporterRole` and
 * `feedbackEdited`. A column added to `feedback` later has a step of its own, which runs after this one.
 *
 * `atomic: false` because `feedback_comments`, `feedback_votes` and `feedback_reads` cascade on
 * `feedback_id`: dropping the old table with enforcement on deletes every one of their rows. Enforcement
 * cannot change inside a transaction, so the step turns it off, rebuilds in one transaction of its own,
 * checks every reference before commit, and turns it back on.
 */

const FEEDBACK_TABLE_REBUILT = `
  CREATE TABLE feedback_rebuilt (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'suggestion', 'question')),
    reporter_id TEXT,
    reporter_role TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    diagnostics TEXT NOT NULL DEFAULT '{}',
    locked_at TEXT,
    edited_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (type = 'bug' AND status IN ('open', 'need_info', 'confirmed', 'resolved', 'wontfix')
                    AND category IN ('crash', 'ai', 'editor', 'community', 'visuals', 'other'))
      OR
      (type = 'suggestion' AND status IN ('open', 'considering', 'planned', 'declined', 'done')
                           AND category IN ('gameplay', 'writing', 'editor', 'community', 'interface', 'other'))
      OR
      (type = 'question' AND status IN ('open', 'answered', 'closed')
                         AND category IN ('gameplay', 'editor', 'setup', 'community', 'account', 'other'))
    ),
    FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL
  )
`;

const CARRIED = [
  'id', 'type', 'reporter_id', 'reporter_role', 'title', 'category', 'body', 'status', 'diagnostics',
  'locked_at', 'edited_at', 'created_at', 'updated_at'
];

/** The rebuilt table and every table that references it. */
const CHECKED = ['feedback', 'feedback_comments', 'feedback_votes', 'feedback_reads'];

const storedSql = (database) => {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = 'feedback'").get();
  return row ? row.sql : null;
};

const apply = (database) => {
  const sql = storedSql(database);
  if (!sql || sql.includes("'question'")) return false;

  const enforcing = database.pragma('foreign_keys', { simple: true });
  if (enforcing) database.pragma('foreign_keys = OFF');

  try {
    return database.transaction(() => {
      database.exec(FEEDBACK_TABLE_REBUILT);
      database.exec(`
        INSERT INTO feedback_rebuilt (${CARRIED.join(', ')})
        SELECT ${CARRIED.join(', ')} FROM feedback
      `);
      database.exec('DROP TABLE feedback');
      database.exec('ALTER TABLE feedback_rebuilt RENAME TO feedback');

      // Throwing rolls the rebuild back, so a dangling reference never commits. Scoped to the tables the
      // rebuild touches, so an unrelated dangling row elsewhere cannot block a boot.
      const broken = CHECKED.flatMap((table) => database.pragma(`foreign_key_check(${table})`));
      if (broken.length) {
        throw new Error(`foreign_key_check found ${broken.length} broken reference(s), first in ${broken[0].table}`);
      }
      return true;
    })();
  } finally {
    if (enforcing) database.pragma('foreign_keys = ON');
  }
};

module.exports = { name: 'feedbackQuestions', atomic: false, apply };
