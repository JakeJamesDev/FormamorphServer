require('dotenv').config();
const db = require('../config/db');

/** The podium table, worded exactly as `createTables` builds it so a fresh database and a migrated one match. */
const PLACEMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS event_placements (
    event_id TEXT NOT NULL,
    place INTEGER NOT NULL CHECK (place IN (1, 2, 3)),
    world_id TEXT,
    world_name TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, place),
    UNIQUE (event_id, world_id),
    FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
    FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE SET NULL
  )
`;

/** The events table without its single-winner columns, again worded as `createTables` builds it. */
const EVENTS_TABLE_REBUILT = `
  CREATE TABLE events_rebuilt (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('contest', 'announcement')),
    title TEXT NOT NULL,
    banner_text TEXT NOT NULL,
    body TEXT NOT NULL,
    rules_text TEXT,
    poster_color TEXT,
    poster_image TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    cancelled_at TEXT,
    start_message_id TEXT,
    end_message_id TEXT,
    winner_message_id TEXT,
    results_announced_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (start_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (end_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (winner_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  )
`;

/** The columns carried across the rebuild — everything the new table has that the old one also had. */
const CARRIED = [
  'id', 'type', 'title', 'banner_text', 'body', 'rules_text', 'poster_color', 'poster_image',
  'starts_at', 'ends_at', 'cancelled_at', 'start_message_id', 'end_message_id', 'winner_message_id',
  'created_by', 'created_at', 'updated_at'
];

/**
 * Move contests from a single winner to a podium of up to three places.
 *
 * Three steps: lift whatever winner a contest already recorded into first place with its snapshots, build
 * the placements table, and rebuild `events` without the columns that held the old answer. A contest with
 * a winner counts as announced — the pick *was* the announcement — so the stamp is backfilled from the
 * row's own `updated_at` rather than invented as now.
 *
 * The legacy columns go rather than being mirrored: nothing shipped against them, so no client is left
 * reading one, and dropping them is what makes the podium the only answer to who won. It takes a table
 * rebuild rather than `DROP COLUMN`, which SQLite refuses for a column named in a foreign key.
 *
 * Idempotent as a whole: a second run finds the table built, the stamps set and the columns gone, and
 * changes nothing. Takes the connection so tests can run it against a database still on the single-winner
 * schema — the case that actually matters, and the one the shared connection cannot reproduce.
 *
 * @param {Object} [database] - The connection to migrate
 * @returns {boolean} Whether anything was changed
 */
const addEventPlacements = (database = db) => {
  // A fresh database has no schema yet — `createTables` builds both tables already in their new shape.
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
    .get();

  if (!tableExists) {
    console.log('No events table yet — nothing to migrate (createTables builds it with placements)');
    return false;
  }

  let changed = false;

  const hadPlacements = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_placements'")
    .get();

  database.exec(PLACEMENTS_TABLE);
  if (!hadPlacements) {
    console.log('Created event_placements table');
    changed = true;
  }

  const columns = database.prepare('PRAGMA table_info(events)').all().map((column) => column.name);
  const legacy = columns.includes('winner_name')
    ? database.prepare(`
        SELECT id, winner_world_id, winner_name, winner_author_name, updated_at
        FROM events
        WHERE winner_name IS NOT NULL OR winner_world_id IS NOT NULL
      `).all()
    : [];

  if (!columns.includes('results_announced_at')) {
    database.exec('ALTER TABLE events ADD COLUMN results_announced_at TEXT');
    console.log('Added results_announced_at column to events table');
    changed = true;
  }

  // `INSERT OR IGNORE` so a second run cannot fight a podium an admin has edited since.
  if (legacy.length) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
      VALUES (@eventId, 1, @worldId, @worldName, @authorName, @createdAt)
    `);
    const stamp = database.prepare(
      'UPDATE events SET results_announced_at = @at WHERE id = @id AND results_announced_at IS NULL'
    );

    database.transaction((rows) => {
      for (const row of rows) {
        insert.run({
          eventId: row.id,
          worldId: row.winner_world_id || null,
          // A row that lost its listing before this ran still has to satisfy NOT NULL, and there is
          // nothing truer to put there than that the name is gone.
          worldName: row.winner_name || 'a deleted listing',
          authorName: row.winner_author_name || 'a departed account',
          createdAt: row.updated_at
        });
        stamp.run({ id: row.id, at: row.updated_at });
      }
    })(legacy);

    console.log(`Lifted ${legacy.length} winner${legacy.length === 1 ? '' : 's'} into first place`);
    changed = true;
  }

  if (columns.includes('winner_world_id') || columns.includes('winner_name')) {
    rebuildEvents(database);
    console.log('Rebuilt the events table without its single-winner columns');
    changed = true;
  }

  if (!changed) console.log('placements already migrated');
  return changed;
};

/**
 * Swap `events` for a copy without the winner columns.
 *
 * The pragma has to be off around it and cannot be changed inside a transaction, so the two are ordered
 * rather than nested: `event_placements` references `events`, and dropping the old table with enforcement
 * on would take the podium rows with it.
 *
 * @param {Object} database - The connection to rebuild on
 */
const rebuildEvents = (database) => {
  const enforcing = database.pragma('foreign_keys', { simple: true });
  if (enforcing) database.pragma('foreign_keys = OFF');

  try {
    database.transaction(() => {
      database.exec(EVENTS_TABLE_REBUILT);
      database.exec(`
        INSERT INTO events_rebuilt (${CARRIED.join(', ')}, results_announced_at)
        SELECT ${CARRIED.join(', ')}, results_announced_at FROM events
      `);
      database.exec('DROP TABLE events');
      database.exec('ALTER TABLE events_rebuilt RENAME TO events');
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
        CREATE INDEX IF NOT EXISTS idx_events_ends ON events(ends_at);
      `);
    })();
  } finally {
    if (enforcing) database.pragma('foreign_keys = ON');
  }
};

// Only self-run as a script; importing must neither migrate nor close the shared connection.
if (require.main === module) {
  try {
    addEventPlacements();
  } catch (error) {
    console.error('Error migrating event placements:', error);
  } finally {
    db.close();
  }
}

module.exports = { addEventPlacements };
