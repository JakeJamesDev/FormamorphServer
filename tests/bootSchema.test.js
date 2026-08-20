import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { db, createTables, createIndexes } from './context.js';

const require = createRequire(import.meta.url);

/**
 * The schema step `server.js` runs before it serves.
 *
 * A deploy that adds a table must need nothing run by hand: forgetting `npm run init-db` would otherwise
 * leave the new endpoints answering `no such table`, which is an outage caused by a step nobody sees
 * until it is missed. These prove the two properties that makes safe — it repairs, and it repeats.
 */

/** Every table `createTables` is responsible for. */
const TABLES = [
  'users', 'worlds', 'comments',
  'messages', 'message_states',
  'policies', 'policy_acceptances',
  'feedback', 'feedback_comments', 'feedback_reads', 'feedback_votes',
  'audit_log', 'follows', 'world_likes',
  'events'
];

const tableNames = () => db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => row.name);

describe('the boot-time schema step', () => {
  it('is what server.js runs, alongside the kind migration', () => {
    // Named rather than inspected: the point is that these three are wired in, so a future table lands
    // on a deployed server without anyone remembering a command.
    const source = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');

    expect(source).toContain('createTables()');
    expect(source).toContain('createIndexes()');
    expect(source).toContain('addKindColumn()');
    expect(source).toContain('addQuarantineColumns()');
    expect(source).toContain('addAvatarColumns()');
    expect(source).toContain('addAuthorRoleColumn()');
    expect(source).toContain('addFeedbackEditedColumn()');
    expect(source).toContain('addFeedSeenColumn()');
    expect(source).toContain('addTokenVersionColumn()');
  });

  it('migrates the columns before it indexes them', () => {
    // Found live: an index naming `quarantine_expires_at` ran before the migration that adds it, so on
    // every database the migration existed for, indexing threw and took the migration down with it —
    // leaving the server answering `no such column` for the whole feature. The two facts are asserted
    // together because the order only matters while an index names a migrated column.
    const boot = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
    const schema = require('fs').readFileSync(require.resolve('../src/utils/initDb.js'), 'utf8');

    const indexes = schema.slice(schema.indexOf('const createIndexes'));
    expect(indexes).toContain('quarantine_expires_at');

    expect(boot.indexOf('addQuarantineColumns()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addAvatarColumns()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addAuthorRoleColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addFeedbackEditedColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addFeedSeenColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addKindColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
  });

  it('brings an existing table up to date, which creating cannot', () => {
    // The split worth remembering: `createTables` adds *tables*, never *columns*. Quarantine was the
    // first change to a table already in production, so it needs its own migration in the same path.
    const source = require('fs').readFileSync(require.resolve('../src/utils/addQuarantineColumns.js'), 'utf8');

    expect(source).toContain('ALTER TABLE worlds');

    const avatars = require('fs').readFileSync(require.resolve('../src/utils/addAvatarColumns.js'), 'utf8');
    expect(avatars).toContain('ALTER TABLE users');

    const roles = require('fs').readFileSync(require.resolve('../src/utils/addAuthorRoleColumn.js'), 'utf8');
    expect(roles).toContain('ALTER TABLE feedback_comments');

    const edited = require('fs').readFileSync(require.resolve('../src/utils/addFeedbackEditedColumn.js'), 'utf8');
    expect(edited).toContain('ALTER TABLE feedback');

    const seen = require('fs').readFileSync(require.resolve('../src/utils/addFeedSeenColumn.js'), 'utf8');
    expect(seen).toContain('ALTER TABLE users');
  });

  it('creates every table it is responsible for', () => {
    const names = tableNames();

    for (const table of TABLES) expect(names).toContain(table);
  });

  it('puts back a table that is missing', () => {
    // The repair case: a database that predates a feature gets it on the next boot.
    db.exec('DROP TABLE feedback_votes');
    expect(tableNames()).not.toContain('feedback_votes');

    createTables();
    createIndexes();

    expect(tableNames()).toContain('feedback_votes');
  });

  it('leaves existing rows alone when it runs again', () => {
    // Every boot after the first re-runs this, so it has to be a no-op over real data.
    db.prepare("INSERT INTO users (id, username, password) VALUES ('u-keep', 'keeper', 'x')").run();

    createTables();
    createIndexes();

    expect(db.prepare("SELECT username FROM users WHERE id = 'u-keep'").get().username).toBe('keeper');
  });

  it('survives being run twice in a row', () => {
    expect(() => {
      createTables();
      createIndexes();
      createTables();
      createIndexes();
    }).not.toThrow();
  });

  it('does not seed the admin account', () => {
    // `createAdminUser` is deliberately left out of the boot path: a server that invents an account with
    // a default password on every boot is a hazard, and `npm run init-db` still does it on a new install.
    db.prepare('DELETE FROM users').run();

    createTables();
    createIndexes();

    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get().count).toBe(0);
  });
});
