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
  'events', 'event_placements',
  'world_changelog',
  'reports'
];

const { addCommentEditedColumn } = require('../src/utils/addCommentEditedColumn');
const { addWorldChangelog } = require('../src/utils/addWorldChangelog');
const { addReports } = require('../src/utils/addReports');

const columnNames = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

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
    expect(source).toContain('addCommentEditedColumn()');
    expect(source).toContain('addFeedSeenColumn()');
    expect(source).toContain('addTokenVersionColumn()');
    expect(source).toContain('addContestColumn()');
    expect(source).toContain('addPosterColumns()');
    expect(source).toContain('addEventPlacements()');
    expect(source).toContain('addPosterPlacement()');
    expect(source).toContain('addWorldChangelog()');
    expect(source).toContain('addReports()');
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
    expect(boot.indexOf('addCommentEditedColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addFeedSeenColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addKindColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addContestColumn()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addPosterColumns()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addEventPlacements()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(boot.indexOf('addPosterPlacement()')).toBeLessThan(boot.indexOf('createIndexes()'));
    // The changelog index names a table this migration is what creates, so the same ordering rule applies
    // to a new *table* as to a new column.
    expect(indexes).toContain('world_changelog');
    expect(boot.indexOf('addWorldChangelog()')).toBeLessThan(boot.indexOf('createIndexes()'));
    expect(indexes).toContain('REPORTS_UNIQUE_OPEN');
    expect(boot.indexOf('addReports()')).toBeLessThan(boot.indexOf('createIndexes()'));
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

    const commentEdits = require('fs').readFileSync(require.resolve('../src/utils/addCommentEditedColumn.js'), 'utf8');
    expect(commentEdits).toContain('ALTER TABLE comments');

    const seen = require('fs').readFileSync(require.resolve('../src/utils/addFeedSeenColumn.js'), 'utf8');
    expect(seen).toContain('ALTER TABLE users');

    const contest = require('fs').readFileSync(require.resolve('../src/utils/addContestColumn.js'), 'utf8');
    expect(contest).toContain('ALTER TABLE worlds');

    const poster = require('fs').readFileSync(require.resolve('../src/utils/addPosterColumns.js'), 'utf8');
    expect(poster).toContain('ALTER TABLE events');

    // The one that cannot be an ALTER: SQLite refuses to drop a column named in a foreign key, so the
    // single-winner columns go by rebuilding the table around them.
    const podium = require('fs').readFileSync(require.resolve('../src/utils/addEventPlacements.js'), 'utf8');
    expect(podium).toContain('ALTER TABLE events ADD COLUMN results_announced_at');
    expect(podium).toContain('DROP TABLE events');
  });

  it('puts a new column onto a table that predates it', () => {
    // The repair `createTables` cannot do: a database from before comments were editable already has a
    // `comments` table, so `CREATE TABLE IF NOT EXISTS` is a no-op over it and the column never arrives.
    db.exec('DROP TABLE comments');
    db.exec(`CREATE TABLE comments (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, world_id TEXT NOT NULL, author_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    createTables();
    expect(columnNames('comments')).not.toContain('edited_at');

    addCommentEditedColumn(db);

    expect(columnNames('comments')).toContain('edited_at');
  });

  it('gives a database that predates the changelog its table', () => {
    // The migration's own repair, separate from `createTables` doing it: the two have to agree, because a
    // deploy where only one of them ran is the case both exist for.
    db.exec('DROP TABLE world_changelog');
    expect(tableNames()).not.toContain('world_changelog');

    addWorldChangelog(db);

    expect(tableNames()).toContain('world_changelog');
    expect(columnNames('world_changelog')).toEqual(
      expect.arrayContaining(['id', 'world_id', 'title', 'body', 'entry_date', 'created_at', 'updated_at'])
    );
  });

  it('gives a database that predates reports its table, index and all', () => {
    // Same agreement the changelog needs, plus the one thing this table cannot do without: the partial
    // unique index IS the duplicate guard, so a migration that built the table and not the index would
    // leave the rule enforced only by a check two racing requests can both pass.
    db.exec('DROP TABLE reports');
    expect(tableNames()).not.toContain('reports');

    addReports(db);

    expect(tableNames()).toContain('reports');
    expect(columnNames('reports')).toEqual(expect.arrayContaining([
      'id', 'reporter_id', 'target_kind', 'target_id', 'target_name', 'target_author_id',
      'target_author_username', 'target_snippet', 'target_parent_id', 'category', 'details', 'status', 'outcome',
      'target_gone_at', 'resolved_at', 'resolved_by', 'resolution_note', 'created_at'
    ]));

    const indexNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reports'")
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain('idx_reports_one_open');
  });

  it('adds a later column to a reports table that predates it', () => {
    // Found live, not imagined: a running server had built `reports` from the first version of this
    // schema, the table then grew `target_parent_id`, and every attempt to file answered
    // `no such column` — because `CREATE TABLE IF NOT EXISTS` is a no-op over a table that exists.
    db.exec('DROP TABLE reports');
    db.exec(`CREATE TABLE reports (
      id TEXT PRIMARY KEY, reporter_id TEXT, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      target_name TEXT, target_author_id TEXT, target_author_username TEXT, target_snippet TEXT,
      category TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'open', outcome TEXT,
      target_gone_at TEXT, resolved_at TEXT, resolved_by TEXT, resolution_note TEXT,
      created_at TEXT NOT NULL
    )`);

    createTables();
    expect(columnNames('reports')).not.toContain('target_parent_id');

    addReports(db);

    expect(columnNames('reports')).toContain('target_parent_id');
    // A write naming it is what was broken, so that is what is asserted.
    expect(() => db.prepare(`
      INSERT INTO reports (id, target_kind, target_id, target_parent_id, category, status, created_at)
      VALUES ('after-migration', 'comment', 'c1', 'w1', 'spam', 'open', '2026-08-24T00:00:00.000Z')
    `).run()).not.toThrow();
  });

  it('restores the duplicate-guard index to a reports table that lost it', () => {
    // The index IS the rule under a race, so a database holding the table without it is one where two
    // simultaneous filings both land.
    db.exec('DROP INDEX IF EXISTS idx_reports_one_open');

    addReports(db);

    const indexNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reports'")
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain('idx_reports_one_open');
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
