const { tableExists, columnNames } = require('../columns');

/**
 * Let two or more worlds share a place on a contest podium.
 *
 * The old table said "one world per place" in its primary key, so a tie was not something the validator
 * could allow — it was unstorable. This rebuilds the table around the new key and adds the `position`
 * column that holds the order inside a place, from 0. Every stored podium comes across at position 0.
 *
 * The key becomes (event, place, position) rather than (event, world): a listing that is taken down leaves
 * `world_id` null, and two null references would collide on a world-based key. The new key also makes "no
 * two worlds at the same position in a place" a constraint rather than a convention, so the stored order
 * can never be ambiguous. One place per world stays a unique of its own.
 *
 * A rebuild rather than an ALTER, because SQLite cannot change a primary key in place. `IF NOT EXISTS` is
 * no help here — the table already exists — so the `position` column is what says whether this has run.
 *
 * Unlike the `eventPlacements` rebuild, this one runs with `foreign_keys` left on, inside the step runner's
 * own transaction. That step rebuilt `events`, which this table points at, so enforcement would have
 * cascaded the podium away underneath it. Nothing points at `event_placements`, so dropping it cascades to
 * nothing, and every row copied across satisfies the same two references it already satisfied.
 */

const TIED_PLACEMENTS_TABLE = `
  CREATE TABLE event_placements_tied (
    event_id TEXT NOT NULL,
    place INTEGER NOT NULL CHECK (place IN (1, 2, 3)),
    -- The order inside a place, from 0. Worlds that share a place are stored earliest-published first.
    position INTEGER NOT NULL DEFAULT 0,
    world_id TEXT,
    world_name TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, place, position),
    UNIQUE (event_id, world_id),
    FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
    FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE SET NULL
  )
`;

/** The columns the rebuild carries across. `position` is the new one and is not among them. */
const CARRIED = ['event_id', 'place', 'world_id', 'world_name', 'author_name', 'created_at'];

const apply = (database) => {
  if (!tableExists(database, 'event_placements')) return false;
  if (columnNames(database, 'event_placements').includes('position')) return false;

  database.exec(TIED_PLACEMENTS_TABLE);
  database.exec(`
    INSERT INTO event_placements_tied (${CARRIED.join(', ')}, position)
    SELECT ${CARRIED.join(', ')}, 0 FROM event_placements
  `);
  database.exec('DROP TABLE event_placements');
  database.exec('ALTER TABLE event_placements_tied RENAME TO event_placements');

  return true;
};

module.exports = { name: 'placementTies', apply };
