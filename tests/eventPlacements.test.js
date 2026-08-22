import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { db } from './context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { addEventPlacements } = require('../src/utils/addEventPlacements');

/**
 * The move from one winner to a podium of three.
 *
 * Nothing shipped against the single-winner columns, so they are replaced rather than mirrored — which
 * makes the migration the only thing standing between a database that recorded a winner and one that has
 * never heard of the column. What has to hold: the recorded winner comes out the other side as first
 * place, the contest still reads as decided, and the columns are actually gone.
 */

/** An events table as it stands on a database that only knows about a single winner. */
const legacyDb = () => {
  const legacy = new Database(':memory:');
  legacy.pragma('foreign_keys = ON');
  legacy.exec('CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT)');
  legacy.exec('CREATE TABLE messages (id TEXT PRIMARY KEY)');
  legacy.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  legacy.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'announcement',
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
      winner_world_id TEXT,
      winner_name TEXT,
      winner_author_name TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (start_message_id) REFERENCES messages (id) ON DELETE SET NULL,
      FOREIGN KEY (winner_world_id) REFERENCES worlds (id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    )
  `);
  return legacy;
};

const seedLegacy = (legacy, over = {}) => {
  const row = {
    id: 'e-old',
    type: 'contest',
    title: 'Autumn Ruins',
    winner_world_id: 'w-old',
    winner_name: 'The Long Thaw',
    winner_author_name: 'sedgewright',
    updated_at: '2025-11-02T10:00:00.000Z',
    ...over
  };

  if (row.winner_world_id) {
    legacy.prepare('INSERT OR IGNORE INTO worlds (id, name) VALUES (?, ?)')
      .run(row.winner_world_id, row.winner_name);
  }

  legacy.prepare(`
    INSERT INTO events (
      id, type, title, banner_text, body, starts_at, ends_at,
      winner_world_id, winner_name, winner_author_name, created_at, updated_at
    ) VALUES (
      @id, @type, @title, 'banner', 'body', '2025-10-01T00:00:00.000Z', '2025-10-31T00:00:00.000Z',
      @winner_world_id, @winner_name, @winner_author_name, '2025-10-01T00:00:00.000Z', @updated_at
    )
  `).run(row);

  return row;
};

const columnsOf = (connection, table) => connection
  .prepare(`PRAGMA table_info(${table})`)
  .all()
  .map((column) => column.name);

const placementsIn = (connection) => connection
  .prepare('SELECT * FROM event_placements ORDER BY event_id, place')
  .all();

/** A real events row and real worlds for the podium constraints to bite against. */
const seedPodiumTargets = (eventId, worldIds) => {
  db.prepare(`
    INSERT INTO events (id, type, title, banner_text, body, starts_at, ends_at, created_at, updated_at)
    VALUES (?, 'contest', 'Constraint Contest', 'b', 'b', '2025-01-01', '2025-01-02', '2025-01-01', '2025-01-01')
  `).run(eventId);
  db.prepare("INSERT OR IGNORE INTO users (id, username, password) VALUES ('u-constraint', 'constraint', 'x')").run();

  for (const worldId of worldIds) {
    db.prepare(`
      INSERT INTO worlds (id, name, description, author_id, thumbnail_file, preview_data, content_file)
      VALUES (?, ?, 'd', 'u-constraint', 't.png', '{}', 'c.json')
    `).run(worldId, worldId);
  }

  return (place, worldId) => db.prepare(`
    INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
    VALUES (?, ?, ?, 'n', 'a', '2025-01-01')
  `).run(eventId, place, worldId);
};

describe('the podium schema', () => {
  it('is on a freshly created database, with the single-winner columns already gone', () => {
    const columns = columnsOf(db, 'events');

    expect(columns).toContain('results_announced_at');
    expect(columns).not.toContain('winner_world_id');
    expect(columns).not.toContain('winner_name');
    expect(columns).not.toContain('winner_author_name');
    // The broadcast id stays: it is the podium announcement's now.
    expect(columns).toContain('winner_message_id');
    expect(columnsOf(db, 'event_placements')).toContain('place');
  });

  it('holds one world per place', () => {
    const insert = seedPodiumTargets('e-u1', ['w-a1', 'w-b1']);

    insert(1, 'w-a1');

    expect(() => insert(1, 'w-b1')).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('holds one place per world', () => {
    const insert = seedPodiumTargets('e-u2', ['w-c2']);

    insert(1, 'w-c2');

    expect(() => insert(2, 'w-c2')).toThrow(/UNIQUE/);
  });

  it('refuses a fourth place at the column, not only at the route', () => {
    const insert = seedPodiumTargets('e-u3', ['w-d3']);

    expect(() => insert(4, 'w-d3')).toThrow(/CHECK/);
  });

  it('lets two lost listings share a podium, since neither has an id left to clash on', () => {
    const insert = seedPodiumTargets('e-u4', ['w-e4', 'w-f4']);
    insert(1, 'w-e4');
    insert(2, 'w-f4');

    db.prepare('DELETE FROM worlds WHERE id IN (?, ?)').run('w-e4', 'w-f4');

    expect(db.prepare('SELECT world_id FROM event_placements WHERE event_id = ? ORDER BY place').all('e-u4'))
      .toEqual([{ world_id: null }, { world_id: null }]);
  });
});

describe('migrating a single-winner database', () => {
  it('lifts the recorded winner into first place, with its snapshots', () => {
    const legacy = legacyDb();
    const seeded = seedLegacy(legacy);

    expect(addEventPlacements(legacy)).toBe(true);
    expect(placementsIn(legacy)).toEqual([{
      event_id: seeded.id,
      place: 1,
      world_id: seeded.winner_world_id,
      world_name: seeded.winner_name,
      author_name: seeded.winner_author_name,
      created_at: seeded.updated_at
    }]);

    legacy.close();
  });

  it('treats the old pick as the announcement, stamped when it was made', () => {
    // The pick *was* the announcement on the old model, so a migrated contest has to still read as
    // decided — and dated then rather than now, or the archive would say every old contest was judged
    // on the day the server was upgraded.
    const legacy = legacyDb();
    const seeded = seedLegacy(legacy);

    addEventPlacements(legacy);

    expect(legacy.prepare('SELECT results_announced_at FROM events WHERE id = ?').get(seeded.id))
      .toEqual({ results_announced_at: seeded.updated_at });

    legacy.close();
  });

  it('drops the columns it replaced, foreign key and all', () => {
    const legacy = legacyDb();
    seedLegacy(legacy);

    addEventPlacements(legacy);

    const columns = columnsOf(legacy, 'events');
    expect(columns).not.toContain('winner_world_id');
    expect(columns).not.toContain('winner_name');
    expect(columns).not.toContain('winner_author_name');

    legacy.close();
  });

  it('carries every other column across the rebuild untouched', () => {
    const legacy = legacyDb();
    const seeded = seedLegacy(legacy, { winner_message_id: null });

    addEventPlacements(legacy);

    expect(legacy.prepare('SELECT * FROM events WHERE id = ?').get(seeded.id)).toMatchObject({
      id: seeded.id,
      type: 'contest',
      title: 'Autumn Ruins',
      banner_text: 'banner',
      body: 'body',
      starts_at: '2025-10-01T00:00:00.000Z',
      ends_at: '2025-10-31T00:00:00.000Z'
    });

    legacy.close();
  });

  it('keeps the podium rows through the events rebuild', () => {
    // The placements table points at `events`, and the rebuild drops that table. With enforcement left
    // on, the cascade would take the podium out from under the migration that had just written it.
    const legacy = legacyDb();
    seedLegacy(legacy);

    addEventPlacements(legacy);

    expect(placementsIn(legacy)).toHaveLength(1);
    expect(legacy.pragma('foreign_keys', { simple: true })).toBe(1);

    legacy.close();
  });

  it('leaves a contest that was never decided alone', () => {
    const legacy = legacyDb();
    const undecided = seedLegacy(legacy, {
      id: 'e-open', winner_world_id: null, winner_name: null, winner_author_name: null
    });

    addEventPlacements(legacy);

    expect(placementsIn(legacy)).toEqual([]);
    expect(legacy.prepare('SELECT results_announced_at FROM events WHERE id = ?').get(undecided.id))
      .toEqual({ results_announced_at: null });

    legacy.close();
  });

  it('names a winner whose listing was already gone rather than dropping the place', () => {
    const legacy = legacyDb();
    seedLegacy(legacy, { winner_world_id: null });

    addEventPlacements(legacy);

    expect(placementsIn(legacy)[0]).toMatchObject({
      place: 1, world_id: null, world_name: 'The Long Thaw', author_name: 'sedgewright'
    });

    legacy.close();
  });

  it('is a no-op the second time, so every boot after the first costs nothing', () => {
    const legacy = legacyDb();
    seedLegacy(legacy);

    addEventPlacements(legacy);

    expect(addEventPlacements(legacy)).toBe(false);
    expect(placementsIn(legacy)).toHaveLength(1);

    legacy.close();
  });

  it('does not fight a podium an admin has edited since', () => {
    const legacy = legacyDb();
    const seeded = seedLegacy(legacy);
    addEventPlacements(legacy);

    legacy.prepare('UPDATE event_placements SET world_name = ? WHERE event_id = ?')
      .run('Corrected', seeded.id);
    addEventPlacements(legacy);

    expect(placementsIn(legacy)[0].world_name).toBe('Corrected');

    legacy.close();
  });

  it('leaves a database with no events table alone', () => {
    const empty = new Database(':memory:');

    expect(addEventPlacements(empty)).toBe(false);

    empty.close();
  });
});
