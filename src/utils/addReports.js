require('dotenv').config();
const db = require('../config/db');

/**
 * The reports table, worded exactly as `createTables` builds it so a fresh database and a migrated one
 * match. Kept as its own constant for the reason the changelog migration does: the two copies are the
 * thing that can drift, so they sit somewhere a reader can put them side by side.
 */
const REPORTS_TABLE = `
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    -- SET NULL rather than CASCADE: a ticket outlives the account that filed it, exactly as feedback does.
    reporter_id TEXT,
    -- Polymorphic on purpose, and so deliberately without a foreign key: the three targets live in three
    -- tables, and a report has to survive its target being deleted — which is one of the ways one ends.
    target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'comment', 'profile')),
    target_id TEXT NOT NULL,
    -- What the target was at filing time. Snapshots, for the audit log's reason: the ticket has to still
    -- read after the listing, the comment or the account it describes is gone.
    target_name TEXT,
    target_author_id TEXT,
    target_author_username TEXT,
    target_snippet TEXT,
    -- Where the target sits, when it sits inside something: a comment's listing. What makes the queue's
    -- "view in context" possible at all — the target id alone names a comment nothing can navigate to.
    target_parent_id TEXT,
    category TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    -- Set only on resolution, and only ever to one of the two answers a reporter is owed.
    outcome TEXT CHECK (outcome IN ('actioned', 'dismissed')),
    -- When the target stopped existing while the report was still open. The report stays open.
    target_gone_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
  )
`;

/**
 * The one-open-per-reporter-per-target rule, as a constraint rather than only as a check in the model.
 *
 * Partial, so re-filing after a resolution is allowed — which is the point: a fresh violation after an
 * update is a new report, not a duplicate of a closed one.
 */
const REPORTS_UNIQUE_OPEN = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open
    ON reports (reporter_id, target_kind, target_id) WHERE status = 'open'
`;

/** The queue reads open reports grouped by target; nothing else is ever asked for. */
const REPORTS_QUEUE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_reports_open ON reports (status, target_kind, target_id)
`;

/**
 * Columns added to `reports` after the table first shipped.
 *
 * The half `CREATE TABLE IF NOT EXISTS` cannot do: a database that already has the table is a no-op to
 * it, so a column added later never arrives and every write naming it fails with `no such column`. Found
 * exactly that way — a running server built the table, the schema grew a column, and filing broke.
 *
 * Each is nullable and unbackfilled, because there is nothing true to backfill: a report filed before the
 * column existed genuinely has no answer for it.
 */
const REPORTS_LATER_COLUMNS = [
  ['target_parent_id', 'ALTER TABLE reports ADD COLUMN target_parent_id TEXT']
];

/**
 * Give an existing database the reports table, its later columns, and its indexes.
 *
 * A new *table* is something `createTables` already covers, so this exists for the reason the boot
 * sequence runs both: to be the one named step, alongside every other, that a future column on this table
 * is added to. Idempotent — a second run finds everything built and changes nothing.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was added
 */
const addReports = (database = db) => {
  const usersExist = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  // Built before its parent, the reporter foreign key would point at nothing. A database with no `users`
  // table is a fresh one, where `createTables` builds both in order anyway.
  if (!usersExist) {
    console.log('No users table yet — nothing to migrate (createTables builds reports with it)');
    return false;
  }

  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reports'")
    .get();

  let changed = false;

  if (!existing) {
    database.exec(REPORTS_TABLE);
    console.log('Created reports table');
    changed = true;
  }

  // Runs whether the table was just built or was already there: on a fresh one every column is present
  // and this finds nothing to do, which is what makes the two paths agree.
  const columns = new Set(
    database.prepare('PRAGMA table_info(reports)').all().map((column) => column.name)
  );

  for (const [name, statement] of REPORTS_LATER_COLUMNS) {
    if (columns.has(name)) continue;

    database.exec(statement);
    console.log(`Added ${name} column to reports table`);
    changed = true;
  }

  // Outside the create branch for the same reason: a database that got the table from an earlier boot and
  // the index from nowhere would keep the duplicate rule enforced by the model alone, where a race past
  // it is exactly what the index is for.
  database.exec(REPORTS_UNIQUE_OPEN);
  database.exec(REPORTS_QUEUE_INDEX);

  return changed;
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addReports();
  } catch (error) {
    console.error('Error adding the reports table:', error);
  } finally {
    db.close();
  }
}

module.exports = { addReports, REPORTS_TABLE, REPORTS_UNIQUE_OPEN, REPORTS_QUEUE_INDEX };
