import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { db } from './context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: allowPlacementTies } = require('../src/schema/steps/placementTies');

/**
 * The move from one world per place to any number of worlds sharing one.
 *
 * The old table said the rule in its primary key: (event, place) made a shared place impossible to store.
 * This step rebuilds it around (event, place, position), so the key still keeps rows apart once a deleted
 * listing has left them with no world id to differ on. What has to hold: a stored podium survives the
 * rebuild at position 0, the new table takes a tie, and the place ceiling still bites at the column.
 */

/** The placements table as every database in the wild has it before this step. */
const OLD_PLACEMENTS_SQL = `
  CREATE TABLE event_placements (
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

/** A database at the old shape, with the two tables the placements table points at. */
const oldDb = () => {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  old.exec('CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT)');
  old.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  old.exec(OLD_PLACEMENTS_SQL);
  old
    .prepare("INSERT INTO events (id, title, created_at, updated_at) VALUES ('e-1', 'Autumn Ruins', 'x', 'x')")
    .run();
  return old;
};

/** A stored podium at the old shape: gold and silver, each with its listing. */
const seedOldPodium = (old) => {
  const rows = [
    { place: 1, worldId: 'w-gold', worldName: 'The Long Thaw', authorName: 'sedgewright' },
    { place: 2, worldId: 'w-silver', worldName: 'Runner Up', authorName: 'marrowlark' }
  ];

  for (const row of rows) {
    old.prepare('INSERT INTO worlds (id, name) VALUES (?, ?)').run(row.worldId, row.worldName);
    old.prepare(`
      INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
      VALUES ('e-1', @place, @worldId, @worldName, @authorName, '2025-11-02T10:00:00.000Z')
    `).run(row);
  }

  return rows;
};

const columnsOf = (connection, table) => connection
  .prepare(`PRAGMA table_info(${table})`)
  .all()
  .map((column) => column.name);

const placementsIn = (connection) => connection
  .prepare('SELECT * FROM event_placements ORDER BY event_id, place, position')
  .all();

/** A real events row and real worlds, so the rebuilt table's constraints have something to bite against. */
const seedPodiumTargets = (eventId, worldIds) => {
  db.prepare(`
    INSERT INTO events (id, type, title, banner_text, body, starts_at, ends_at, created_at, updated_at)
    VALUES (?, 'contest', 'Tie Contest', 'b', 'b', '2025-01-01', '2025-01-02', '2025-01-01', '2025-01-01')
  `).run(eventId);
  db.prepare("INSERT OR IGNORE INTO users (id, username, password) VALUES ('u-tie', 'tie', 'x')").run();

  for (const worldId of worldIds) {
    db.prepare(`
      INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file)
      VALUES (?, ?, 'd', 'u-tie', 't.png', 'c.json')
    `).run(worldId, worldId);
  }

  return (place, worldId, position = 0) => db.prepare(`
    INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at, position)
    VALUES (?, ?, ?, 'n', 'a', '2025-01-01', ?)
  `).run(eventId, place, worldId, position);
};

describe('the shared-place schema', () => {
  it('is on a freshly created database, so the step has nothing to do there', () => {
    expect(columnsOf(db, 'event_placements')).toContain('position');
  });

  it('holds two worlds in one place, at different positions', () => {
    const insert = seedPodiumTargets('e-t1', ['w-a1', 'w-b1']);

    insert(1, 'w-a1', 0);
    insert(1, 'w-b1', 1);

    expect(db.prepare('SELECT COUNT(*) AS count FROM event_placements WHERE event_id = ?').get('e-t1').count)
      .toBe(2);
  });

  it('refuses two worlds at the same position in a place, so the stored order is never ambiguous', () => {
    const insert = seedPodiumTargets('e-t2', ['w-a2', 'w-b2']);

    insert(1, 'w-a2', 0);

    expect(() => insert(1, 'w-b2', 0)).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('holds one place per world', () => {
    const insert = seedPodiumTargets('e-t3', ['w-c3']);

    insert(1, 'w-c3', 0);

    expect(() => insert(3, 'w-c3', 0)).toThrow(/UNIQUE/);
  });

  it('refuses a fourth place at the column, not only at the route', () => {
    const insert = seedPodiumTargets('e-t4', ['w-d4']);

    expect(() => insert(4, 'w-d4', 0)).toThrow(/CHECK/);
  });

  it('keeps a tied row, its place and its position after the listing is deleted', () => {
    const insert = seedPodiumTargets('e-t5', ['w-e5', 'w-f5']);
    insert(1, 'w-e5', 0);
    insert(1, 'w-f5', 1);

    db.prepare('DELETE FROM worlds WHERE id IN (?, ?)').run('w-e5', 'w-f5');

    expect(db.prepare(
      'SELECT place, position, world_id FROM event_placements WHERE event_id = ? ORDER BY place, position'
    ).all('e-t5')).toEqual([
      { place: 1, position: 0, world_id: null },
      { place: 1, position: 1, world_id: null }
    ]);
  });
});

describe('migrating a one-world-per-place database', () => {
  it('keeps every stored podium row, at position 0', () => {
    const old = oldDb();
    const seeded = seedOldPodium(old);

    expect(allowPlacementTies(old)).toBe(true);
    expect(placementsIn(old)).toEqual(seeded.map((row) => ({
      event_id: 'e-1',
      place: row.place,
      position: 0,
      world_id: row.worldId,
      world_name: row.worldName,
      author_name: row.authorName,
      created_at: '2025-11-02T10:00:00.000Z'
    })));

    old.close();
  });

  it('is a no-op the second time, so every boot after the first costs nothing', () => {
    const old = oldDb();
    seedOldPodium(old);

    allowPlacementTies(old);

    expect(allowPlacementTies(old)).toBe(false);
    expect(placementsIn(old)).toHaveLength(2);

    old.close();
  });

  it('takes a shared place once it has run, which the old key made impossible', () => {
    const old = oldDb();
    seedOldPodium(old);
    allowPlacementTies(old);

    old.prepare('INSERT INTO worlds (id, name) VALUES (?, ?)').run('w-tied', 'Tied');
    old.prepare(`
      INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at, position)
      VALUES ('e-1', 1, 'w-tied', 'Tied', 'ashen', '2025-11-02T10:00:00.000Z', 1)
    `).run();

    expect(placementsIn(old).filter((row) => row.place === 1).map((row) => row.world_id))
      .toEqual(['w-gold', 'w-tied']);

    old.close();
  });

  it('keeps the place ceiling through the rebuild', () => {
    const old = oldDb();
    seedOldPodium(old);
    allowPlacementTies(old);

    old.prepare('INSERT INTO worlds (id, name) VALUES (?, ?)').run('w-fourth', 'Fourth');

    expect(() => old.prepare(`
      INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at, position)
      VALUES ('e-1', 4, 'w-fourth', 'Fourth', 'ashen', '2025-11-02T10:00:00.000Z', 0)
    `).run()).toThrow(/CHECK/);

    old.close();
  });

  it('keeps one place per world through the rebuild', () => {
    const old = oldDb();
    seedOldPodium(old);
    allowPlacementTies(old);

    expect(() => old.prepare(`
      INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at, position)
      VALUES ('e-1', 3, 'w-gold', 'The Long Thaw', 'sedgewright', '2025-11-02T10:00:00.000Z', 0)
    `).run()).toThrow(/UNIQUE/);

    old.close();
  });

  it('keeps the listing reference, so a deleted entry still reads out of the archive', () => {
    // The whole reason the key could not simply become (event, world): a taken-down listing leaves the
    // reference null, and two null references have to stay two rows.
    const old = oldDb();
    seedOldPodium(old);
    allowPlacementTies(old);

    old.prepare('DELETE FROM worlds').run();

    expect(placementsIn(old).map((row) => ({ place: row.place, position: row.position, world: row.world_id })))
      .toEqual([
        { place: 1, position: 0, world: null },
        { place: 2, position: 0, world: null }
      ]);

    old.close();
  });

  it('takes the podium with it when the contest is deleted', () => {
    const old = oldDb();
    seedOldPodium(old);
    allowPlacementTies(old);

    old.prepare("DELETE FROM events WHERE id = 'e-1'").run();

    expect(placementsIn(old)).toEqual([]);

    old.close();
  });

  it('leaves a database with no placements table alone', () => {
    const empty = new Database(':memory:');

    expect(allowPlacementTies(empty)).toBe(false);

    empty.close();
  });
});
