const { addColumns, tableExists } = require('../columns');

/**
 * Give every feedback thread its number, one sequence for all types.
 *
 * The column goes after the `feedbackQuestions` rebuild, which copies a fixed column list. Threads already
 * stored are numbered in creation order, ties broken by id, in the same transaction that adds the column,
 * so a later boot never renumbers. The unique index is in `indexes`, after this backfill. A fresh database
 * gets the column from `tables`.
 */

const apply = (database) => {
  if (!tableExists(database, 'feedback')) return false;

  const added = addColumns(database, 'feedback', [['number', 'INTEGER NOT NULL DEFAULT 0']]);
  if (added.length === 0) return false;

  database.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS position FROM feedback
    )
    UPDATE feedback SET number = (SELECT position FROM ranked WHERE ranked.id = feedback.id)
  `);

  // Seeds the counter from the backfill's highest number. `tables` made the table, empty.
  database.exec(`
    INSERT INTO feedback_sequence (id, last_number)
    SELECT 1, COALESCE(MAX(number), 0) FROM feedback WHERE true
    ON CONFLICT(id) DO UPDATE SET last_number = excluded.last_number
  `);

  return true;
};

module.exports = { name: 'feedbackNumber', apply };
