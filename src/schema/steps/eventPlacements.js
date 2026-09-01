const { tableExists, columnNames } = require('../columns');

/**
 * Move contests from a single winner to a podium of up to three places.
 *
 * Builds the placements table, renames the broadcast column to the results vocabulary, lifts a recorded
 * winner into first place with its snapshots, and rebuilds `events` without the single-winner columns.
 * The rebuild is what removes them, because SQLite refuses `DROP COLUMN` on a column named in a foreign
 * key. A contest with a winner counts as announced, stamped from the row's own `updated_at`.
 *
 * Both table shapes below are frozen at this point in the schema's history on purpose. A column added to
 * `events` later has a step of its own, which runs after this one.
 *
 * `atomic: false` because `foreign_keys` has to be off around the rebuild and cannot change inside a
 * transaction. The step turns it off, runs everything in one transaction of its own, and turns it back on.
 */

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
    results_message_id TEXT,
    results_announced_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (start_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (end_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (results_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  )
`;

/** The columns carried across the rebuild: everything the new table has that the old one also had. */
const CARRIED = [
  'id', 'type', 'title', 'banner_text', 'body', 'rules_text', 'poster_color', 'poster_image',
  'starts_at', 'ends_at', 'cancelled_at', 'start_message_id', 'end_message_id', 'results_message_id',
  'created_by', 'created_at', 'updated_at'
];

const apply = (database) => {
  if (!tableExists(database, 'events')) return false;

  // `event_placements` references `events`, so dropping the old table with enforcement on would take the
  // podium rows with it.
  const enforcing = database.pragma('foreign_keys', { simple: true });
  if (enforcing) database.pragma('foreign_keys = OFF');

  try {
    return database.transaction(() => moveToPodium(database))();
  } finally {
    if (enforcing) database.pragma('foreign_keys = ON');
  }
};

const moveToPodium = (database) => {
  let changed = false;

  const hadPlacements = tableExists(database, 'event_placements');
  database.exec(PLACEMENTS_TABLE);
  if (!hadPlacements) changed = true;

  let columns = columnNames(database, 'events');

  // The broadcast column keeps its value and its foreign key and only changes name. A database migrated
  // before this rename still has the old name with no winner columns left to trigger the rebuild below.
  if (columns.includes('winner_message_id') && !columns.includes('results_message_id')) {
    database.exec('ALTER TABLE events RENAME COLUMN winner_message_id TO results_message_id');
    columns = columnNames(database, 'events');
    changed = true;
  }

  const winners = columns.includes('winner_name')
    ? database.prepare(`
        SELECT id, winner_world_id, winner_name, winner_author_name, updated_at
        FROM events
        WHERE winner_name IS NOT NULL OR winner_world_id IS NOT NULL
      `).all()
    : [];

  if (!columns.includes('results_announced_at')) {
    database.exec('ALTER TABLE events ADD COLUMN results_announced_at TEXT');
    changed = true;
  }

  // `INSERT OR IGNORE` so a second run cannot overwrite a podium an admin has edited since.
  if (winners.length) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
      VALUES (@eventId, 1, @worldId, @worldName, @authorName, @createdAt)
    `);
    const stamp = database.prepare(
      'UPDATE events SET results_announced_at = @at WHERE id = @id AND results_announced_at IS NULL'
    );

    for (const row of winners) {
      insert.run({
        eventId: row.id,
        worldId: row.winner_world_id || null,
        // A row that lost its listing before this ran still has to satisfy NOT NULL.
        worldName: row.winner_name || 'a deleted listing',
        authorName: row.winner_author_name || 'a departed account',
        createdAt: row.updated_at
      });
      stamp.run({ id: row.id, at: row.updated_at });
    }

    changed = true;
  }

  if (columns.includes('winner_world_id') || columns.includes('winner_name')) {
    database.exec(EVENTS_TABLE_REBUILT);
    database.exec(`
      INSERT INTO events_rebuilt (${CARRIED.join(', ')}, results_announced_at)
      SELECT ${CARRIED.join(', ')}, results_announced_at FROM events
    `);
    database.exec('DROP TABLE events');
    database.exec('ALTER TABLE events_rebuilt RENAME TO events');
    changed = true;
  }

  return changed;
};

module.exports = { name: 'eventPlacements', atomic: false, apply };
