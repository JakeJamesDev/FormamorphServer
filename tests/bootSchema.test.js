import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, migrate } from './context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The schema step `server.js` runs before it serves and `npm run init-db` runs before it seeds.
 *
 * A deploy that adds a table or a column must need nothing run by hand: forgetting a migration would
 * otherwise leave the new endpoints answering `no such table` or `no such column`, an outage caused by a
 * step nobody sees until it is missed. These prove the properties that make that safe: it builds a fresh
 * database whole, it brings the oldest database still in the wild to the same shape, it repeats for free,
 * and a step that fails leaves nothing half-done.
 */

/** Every table the schema is responsible for. */
const TABLES = [
  'users', 'worlds', 'comments',
  'messages', 'message_states',
  'policies', 'policy_acceptances',
  'feedback', 'feedback_comments', 'feedback_reads', 'feedback_votes',
  'audit_log', 'follows', 'world_likes',
  'events', 'event_placements',
  'world_changelog',
  'reports',
  'signals',
  'settings',
  'account_tokens'
];

/**
 * The schema as the oldest database still in the wild has it: every table that later grew a column, in the
 * shape it first shipped with, and nothing that arrived later. Each shape is the current one with the
 * stepped columns taken out, so the only thing between this and the present is the step list.
 */
const OLDEST_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    status TEXT DEFAULT 'normal',
    account_type TEXT DEFAULT 'normal',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    author_id TEXT NOT NULL,
    thumbnail_file TEXT NOT NULL,
    preview_data TEXT NOT NULL,
    content_file TEXT NOT NULL,
    downloads INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    tags TEXT,
    spoiler INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users (id)
  );
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    world_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users (id)
  );
  CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'suggestion')),
    reporter_id TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    diagnostics TEXT NOT NULL DEFAULT '{}',
    locked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE TABLE feedback_comments (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL,
    author_id TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    actor_id TEXT,
    actor_username TEXT,
    actor_was_admin INTEGER NOT NULL DEFAULT 0,
    target_user_id TEXT,
    target_username TEXT,
    target_kind TEXT,
    target_name TEXT,
    snippet TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('contest', 'announcement')),
    title TEXT NOT NULL,
    banner_text TEXT NOT NULL,
    body TEXT NOT NULL,
    rules_text TEXT,
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
    FOREIGN KEY (end_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (winner_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (winner_world_id) REFERENCES worlds (id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'comment', 'profile')),
    target_id TEXT NOT NULL,
    target_name TEXT,
    target_author_id TEXT,
    target_author_username TEXT,
    target_snippet TEXT,
    category TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    outcome TEXT CHECK (outcome IN ('actioned', 'dismissed')),
    target_gone_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL,
    FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
  );
`;

const openDatabase = (file = ':memory:') => {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  return database;
};

const oldestDatabase = (file) => {
  const database = openDatabase(file);
  database.exec(OLDEST_SQL);
  return database;
};

const tableNames = (database) => database
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((row) => row.name);

const columnNames = (database, table) => database
  .prepare(`PRAGMA table_info(${table})`)
  .all()
  .map((row) => row.name);

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * Everything about a schema that a query can tell apart, with column order left out: a column added by
 * ALTER lands at the end of its table, and the shape is the same shape wherever it sits.
 */
const shapeOf = (database) => Object.fromEntries(tableNames(database).sort().map((table) => [table, {
  columns: database.prepare(`PRAGMA table_info(${table})`).all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort(byName),
  foreignKeys: database.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map(({ table: to, from, to: column, on_update, on_delete }) => ({ from, to, column, on_update, on_delete }))
    .sort((a, b) => a.from.localeCompare(b.from)),
  indexes: database.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex%'"
  ).all(table).map((row) => row.name).sort()
}]));

/**
 * Run one of the two callers as its own process, the way an operator does, and collect what it printed.
 *
 * A key given as `undefined` is *removed* from the environment rather than passed as the string
 * "undefined", so a test can run the server with something the worker has but a deploy might not. `cwd`
 * moves the process off the repo root, which is the only way to keep `dotenv` from putting a developer's
 * own `.env` back — every path the server resolves comes from `__dirname` or an environment variable, so
 * running it from elsewhere changes nothing else.
 */
const runScript = (script, env, { until, cwd = ROOT } = {}) => new Promise((resolve, reject) => {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];

  const child = spawn(process.execPath, [path.resolve(ROOT, script)], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`${script} did not finish; output so far:\n${output}`));
  }, 15000);
  const onData = (chunk) => {
    output += chunk;
    if (until && output.includes(until)) {
      clearTimeout(timer);
      child.kill();
      resolve({ code: null, output });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
});

/** A scratch directory holding a database file on the oldest schema, for a process of its own to migrate. */
const oldestOnDisk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-schema-'));
  const file = path.join(dir, 'old.db');
  oldestDatabase(file).close();
  return { dir, file };
};

describe('the schema step', () => {
  it('creates every table on a fresh database', () => {
    const names = tableNames(db);

    for (const table of TABLES) expect(names).toContain(table);
  });

  it('applies the tables, the seeded rows and the indexes to a fresh database, and nothing to it twice', () => {
    const fresh = openDatabase();

    expect(migrate(fresh)).toEqual(['tables', 'ageGate', 'privacyPolicy', 'placeholderUser', 'indexes']);
    expect(migrate(fresh)).toEqual([]);

    fresh.close();
  });

  it('seeds the reserved placeholder account, which no password can sign in as', () => {
    // Where a departing account's listings and comments go when they choose to leave the work behind. Both
    // author columns are NOT NULL, so this row is what makes that path possible at all.
    const fresh = openDatabase();
    migrate(fresh);

    const placeholder = fresh.prepare("SELECT * FROM users WHERE username = '[deleted user]'").get();
    expect(placeholder.id).toBe('00000000-0000-4000-8000-000000000000');
    expect(placeholder.status).toBe('system');
    expect(placeholder.password).not.toHaveLength(60); // nothing bcrypt can match

    fresh.close();
  });

  it('seeds the Privacy Policy switched off, and never overwrites it afterwards', () => {
    // The row ships disabled so this server can deploy ahead of the client that answers it; enabling it is
    // the cutover. A boot that overwrote an edited row would undo the owner's wording, or the cutover.
    const fresh = openDatabase();
    migrate(fresh);

    const seeded = fresh.prepare("SELECT * FROM policies WHERE id = 'privacy_policy'").get();
    expect(seeded.enabled).toBe(0);
    expect(seeded.acceptance_version).toBe(2);
    expect(seeded.body).toContain('**Last updated: 6 September 2026**');
    expect(seeded.body).toContain('**Your email address is optional.**');
    expect(seeded.body).toContain('Once verified, it can also receive password-reset links.');
    expect(seeded.body).toContain('**Resend** delivers verification and password-reset email.');

    fresh.prepare("UPDATE policies SET enabled = 1, body = 'The owner rewrote this.' WHERE id = 'privacy_policy'").run();
    expect(migrate(fresh)).toEqual([]);

    const edited = fresh.prepare("SELECT enabled, body FROM policies WHERE id = 'privacy_policy'").get();
    expect(edited).toEqual({ enabled: 1, body: 'The owner rewrote this.' });

    fresh.close();
  });

  it('seeds the fixed adult-content warning at version one', () => {
    const fresh = openDatabase();
    migrate(fresh);

    const seeded = fresh.prepare("SELECT * FROM policies WHERE id = 'age_gate'").get();
    expect(seeded.enabled).toBe(1);
    expect(seeded.acceptance_version).toBe(1);
    expect(seeded.title).toBe('Adult Content Ahead');
    expect(seeded.body).toContain('at least 18 years old');

    fresh.close();
  });

  it('brings the oldest schema up to the current one, shape for shape', () => {
    // The drift guard. Two paths produce the current schema: the tables step on a fresh database, and
    // every column step on an old one. A column that reaches one path and not the other is the outage
    // this exists to prevent.
    const fresh = openDatabase();
    const legacy = oldestDatabase();

    migrate(fresh);
    migrate(legacy);

    expect(shapeOf(legacy)).toEqual(shapeOf(fresh));
    expect(migrate(legacy)).toEqual([]);

    fresh.close();
    legacy.close();
  });

  it('drops the preview column from an old database, and reports nothing the second time', () => {
    // The column held a base64 copy of the thumbnail already on disk, and nothing ever read it back. The
    // step is the only thing between a live database that still carries it and the fresh shape that does
    // not, so it has to fire once and then be a no-op forever after.
    const legacy = oldestDatabase();
    expect(columnNames(legacy, 'worlds')).toContain('preview_data');

    expect(migrate(legacy)).toContain('dropPreviewData');

    expect(columnNames(legacy, 'worlds')).not.toContain('preview_data');
    expect(migrate(legacy)).toEqual([]);

    legacy.close();
  });

  it('runs the podium rebuild before the framing column, or the rebuild would drop it', () => {
    // The one pair of steps with an order between them: the podium step rebuilds `events` from a fixed
    // column list, so a column added to that table before it goes with the old table.
    const legacy = oldestDatabase();

    migrate(legacy);

    const columns = columnNames(legacy, 'events');
    expect(columns).toContain('poster_placement');
    expect(columns).not.toContain('winner_name');

    legacy.close();
  });

  it('leaves existing rows alone when it runs again', () => {
    // Every boot after the first re-runs this, so it has to be a no-op over real data. `setup.js` clears
    // the seeded policy after each test, so put the database back to current before asking for nothing.
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password) VALUES ('u-keep', 'keeper', 'x')").run();

    expect(migrate(db)).toEqual([]);

    expect(db.prepare("SELECT username FROM users WHERE id = 'u-keep'").get().username).toBe('keeper');
  });

  it('rolls a failed step back whole, names it, and runs nothing after it', () => {
    // A column that differs from a stepped one only in case slips past the name check and fails at the
    // ALTER, after the step has already added its first two columns. Those two must not survive: a step
    // that half-applies leaves a database no later run can recognize.
    const legacy = oldestDatabase();
    legacy.exec('ALTER TABLE worlds ADD COLUMN Quarantine_Extended INTEGER');

    expect(() => migrate(legacy)).toThrow(/quarantine/);

    const worlds = columnNames(legacy, 'worlds');
    expect(worlds).toContain('kind'); // the step before it stays applied
    expect(worlds).not.toContain('quarantined_at'); // its own work is rolled back
    expect(columnNames(legacy, 'users')).not.toContain('avatar_file'); // the step after it never ran

    legacy.close();
  });

  it('rolls the podium rebuild back whole when it fails partway', () => {
    // The one step that carries its own transaction. A leftover scratch table makes the rebuild throw
    // after the rename and the new column have already run; both must be gone afterwards.
    const legacy = oldestDatabase();
    legacy.exec('CREATE TABLE events_rebuilt (id TEXT PRIMARY KEY)');

    expect(() => migrate(legacy)).toThrow(/eventPlacements/);

    const events = columnNames(legacy, 'events');
    expect(events).toContain('poster_color'); // the step before it stays applied
    expect(events).toContain('winner_message_id'); // its rename is rolled back
    expect(events).not.toContain('results_announced_at'); // its column is rolled back
    expect(legacy.pragma('foreign_keys', { simple: true })).toBe(1); // enforcement is restored

    legacy.close();
  });

  it('gives an existing database the verification column, the token table and the unique address', () => {
    // The one migration in this feature that could fail on the live database: it constrains a column that
    // has been there, unconstrained, since the first release. Nothing ever wrote to it, so the index goes
    // on without a data pass — and once it is on, the constraint is the database's rather than a check
    // some route has to remember to make.
    const legacy = oldestDatabase();

    expect(migrate(legacy)).toContain('emailVerification');

    expect(columnNames(legacy, 'users')).toContain('email_verified_at');
    expect(tableNames(legacy)).toContain('account_tokens');
    legacy.prepare("INSERT INTO users (id, username, password, email) VALUES ('u-1', 'first', 'x', 'One@Example.test')").run();
    expect(() => legacy
      .prepare("INSERT INTO users (id, username, password, email) VALUES ('u-2', 'second', 'x', 'one@example.TEST')")
      .run()).toThrow(/UNIQUE/);
    // Most accounts have no address at all, and the index must not make the second of them a duplicate.
    legacy.prepare("INSERT INTO users (id, username, password) VALUES ('u-3', 'third', 'x')").run();
    legacy.prepare("INSERT INTO users (id, username, password) VALUES ('u-4', 'fourth', 'x')").run();

    legacy.close();
  });

  it('takes an outstanding link with the account it belongs to', () => {
    // Erasure deletes the user row and leaves the rest to the cascades. A verification link that outlived
    // its account would be a row pointing at nothing that an erased address could still be proven with.
    const legacy = oldestDatabase();
    migrate(legacy);
    legacy.prepare("INSERT INTO users (id, username, password) VALUES ('u-1', 'first', 'x')").run();
    legacy.prepare(`
      INSERT INTO account_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
      VALUES ('t-1', 'u-1', 'verify', 'a-hash', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();

    legacy.prepare("DELETE FROM users WHERE id = 'u-1'").run();

    expect(legacy.prepare('SELECT COUNT(*) AS count FROM account_tokens').get().count).toBe(0);

    legacy.close();
  });

  it('indexes the columns the catalog filters on', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worlds'")
      .all()
      .map((row) => row.name);

    expect(indexes).toEqual(expect.arrayContaining(['idx_worlds_kind', 'idx_worlds_quarantine', 'idx_worlds_contest']));
  });

  it('does not seed the admin account', () => {
    // The seed is deliberately left out of the boot path: a server that invents an account with a
    // default password on every boot is a hazard, and `npm run init-db` still does it on a new install.
    // The reserved placeholder is the only row a migration ever puts in this table, and it can't log in.
    db.prepare('DELETE FROM users').run();

    migrate(db);

    const seeded = db.prepare('SELECT username FROM users').all().map((row) => row.username);
    expect(seeded).toEqual(['[deleted user]']);
  });

  it('is what the server runs before it listens', async () => {
    const { dir, file } = oldestOnDisk();

    const { output } = await runScript('src/server.js', {
      DB_PATH: file,
      STORAGE_ROOT: path.join(dir, 'storage'),
      PORT: '0',
      NODE_ENV: 'test'
    }, { until: 'Server running' });

    expect(output).not.toContain('Schema setup failed');
    const migrated = openDatabase(file);
    expect(columnNames(migrated, 'worlds')).toContain('kind');
    expect(tableNames(migrated)).toContain('reports');
    // The seeded policy reaches a real deploy, not only the suite's own migrate.
    expect(migrated.prepare("SELECT enabled FROM policies WHERE id = 'privacy_policy'").get().enabled).toBe(0);
    // Serving never invents an owner: the seed belongs to init-db alone. The placeholder is not one.
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM users WHERE status <> 'system'").get().count).toBe(0);
    migrated.close();
  }, 20000);

  it('refuses to start at all without the Signal salt, before it touches the database', async () => {
    // The one environment check the server makes, and the only one worth stopping for: an unsalted hash of
    // an address is a lookup table away from the address, so a deploy that forgets the salt must not write
    // one row. Run from a scratch directory so the repo's own `.env` cannot hand the salt back.
    const { dir, file } = oldestOnDisk();

    const { code, output } = await runScript('src/server.js', {
      SIGNAL_SALT: undefined,
      DB_PATH: file,
      STORAGE_ROOT: path.join(dir, 'storage'),
      PORT: '0',
      NODE_ENV: 'test'
    }, { cwd: dir });

    expect(code).toBe(1);
    expect(output).toContain('SIGNAL_SALT is not set');
    expect(output).not.toContain('Server running');
    // Nothing ran: the schema step is after the check, so the oldest database is still the oldest.
    const untouched = openDatabase(file);
    expect(tableNames(untouched)).not.toContain('signals');
    expect(columnNames(untouched, 'worlds')).not.toContain('kind');
    untouched.close();
  }, 20000);

  it('starts with the salt set', async () => {
    // The other half of the guard: it refuses for the one reason and not because it refuses.
    const { dir, file } = oldestOnDisk();

    const { output } = await runScript('src/server.js', {
      SIGNAL_SALT: 'a-boot-salt',
      DB_PATH: file,
      STORAGE_ROOT: path.join(dir, 'storage'),
      PORT: '0',
      NODE_ENV: 'test'
    }, { until: 'Server running', cwd: dir });

    expect(output).toContain('Server running');
  }, 20000);

  it('is what init-db runs, ahead of the admin seed', async () => {
    const { dir, file } = oldestOnDisk();

    const { code, output } = await runScript('src/utils/initDb.js', {
      DB_PATH: file,
      STORAGE_ROOT: path.join(dir, 'storage'),
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD: 'a-real-password-for-tests',
      ADMIN_EMAIL: 'owner@example.com'
    });

    expect(code, output).toBe(0);
    const migrated = openDatabase(file);
    expect(columnNames(migrated, 'users')).toContain('token_version');
    expect(migrated.prepare("SELECT account_type FROM users WHERE username = 'owner'").get().account_type).toBe('admin');
    migrated.close();
  }, 20000);
});
