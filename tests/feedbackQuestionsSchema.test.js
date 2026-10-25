import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { migrate } from './context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * The `feedbackQuestions` rebuild. `feedback` has three child tables that cascade on it, so a rebuild with
 * enforcement on would delete every comment, vote and read marker. What has to hold: every thread and
 * every child row comes out the other side, and the table then takes a question and still refuses a status
 * from the wrong branch. The boot-schema drift test compares columns only, so it cannot see a CHECK.
 */

/** The schema as a live server holds it before questions: two branches, every column step applied. */
const LEGACY_SQL = `
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
  CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'suggestion')),
    reporter_id TEXT,
    reporter_role TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    diagnostics TEXT NOT NULL DEFAULT '{}',
    locked_at TEXT,
    edited_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (type = 'bug' AND status IN ('open', 'need_info', 'confirmed', 'resolved', 'wontfix')
                    AND category IN ('crash', 'ai', 'editor', 'community', 'visuals', 'other'))
      OR
      (type = 'suggestion' AND status IN ('open', 'considering', 'planned', 'declined', 'done')
                           AND category IN ('gameplay', 'writing', 'editor', 'community', 'interface', 'other'))
    ),
    FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE TABLE feedback_comments (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL,
    author_id TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    author_role TEXT,
    FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE TABLE feedback_reads (
    feedback_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (feedback_id, user_id),
    FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );
  CREATE TABLE feedback_votes (
    feedback_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (feedback_id, user_id),
    FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );
`;

/** Every status of both old branches, one thread each. */
const STATES = [
  ...['open', 'need_info', 'confirmed', 'resolved', 'wontfix'].map((status) => ['bug', 'crash', status]),
  ...['open', 'considering', 'planned', 'declined', 'done'].map((status) => ['suggestion', 'gameplay', status])
];

const open = () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  return database;
};

/** A legacy database with every thread carrying a comment, a vote and a read marker. */
const legacyDatabase = () => {
  const database = open();
  database.exec(LEGACY_SQL);
  database.prepare("INSERT INTO users (id, username, password) VALUES ('u-1', 'filer', 'x'), ('u-2', 'helper', 'x')").run();

  const thread = database.prepare(`
    INSERT INTO feedback (id, type, reporter_id, reporter_role, title, category, body, status, diagnostics,
                          locked_at, edited_at, created_at, updated_at)
    VALUES (@id, @type, @reporterId, @reporterRole, @title, @category, 'body', @status, '{"v":"3.0.1"}',
            @lockedAt, @editedAt, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
  `);
  const comment = database.prepare(`
    INSERT INTO feedback_comments (id, feedback_id, author_id, body, created_at, author_role)
    VALUES (@id, @feedbackId, 'u-2', 'a reply', '2026-01-02T00:00:00.000Z', 'normal')
  `);
  const vote = database.prepare("INSERT INTO feedback_votes VALUES (?, 'u-2', '2026-01-02T00:00:00.000Z')");
  const read = database.prepare("INSERT INTO feedback_reads VALUES (?, 'u-1', '2026-01-02T00:00:00.000Z')");

  STATES.forEach(([type, category, status], index) => {
    const id = `f-${index}`;
    // Odd rows stand for threads written before the column steps, or whose reporter has left.
    const old = index % 2 === 1;
    thread.run({
      id, type, title: `${type} ${status}`, category, status,
      reporterId: old ? null : 'u-1',
      reporterRole: old ? null : 'normal',
      editedAt: old ? null : '2026-01-03T00:00:00.000Z',
      lockedAt: old ? '2026-01-04T00:00:00.000Z' : null
    });
    comment.run({ id: `c-${index}`, feedbackId: id });
    vote.run(id);
    read.run(id);
  });

  return database;
};

const insertThread = (database, { id, type, category, status }) => database.prepare(`
  INSERT INTO feedback (id, type, title, category, body, status, created_at, updated_at)
  VALUES (?, ?, 'title', ?, 'body', ?, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
`).run(id, type, category, status);

/** What a question-aware table must take and refuse, on either path. */
const expectQuestionChecks = (database) => {
  for (const status of ['open', 'answered', 'closed']) {
    expect(() => insertThread(database, { id: `q-${status}`, type: 'question', category: 'setup', status })).not.toThrow();
  }
  expect(() => insertThread(database, { id: 'q-bad-status', type: 'question', category: 'setup', status: 'planned' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => insertThread(database, { id: 'q-bad-category', type: 'question', category: 'crash', status: 'open' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => insertThread(database, { id: 's-answered', type: 'suggestion', category: 'gameplay', status: 'answered' }))
    .toThrow(/CHECK constraint failed/);
  expect(() => insertThread(database, { id: 'x-type', type: 'poll', category: 'other', status: 'open' }))
    .toThrow(/CHECK constraint failed/);
};

describe('the feedbackQuestions step', () => {
  it('keeps every thread, comment, vote and read marker on a legacy database', () => {
    const database = legacyDatabase();
    const before = {
      feedback: database.prepare('SELECT * FROM feedback ORDER BY id').all(),
      comments: database.prepare('SELECT * FROM feedback_comments ORDER BY id').all(),
      votes: database.prepare('SELECT * FROM feedback_votes ORDER BY feedback_id').all(),
      reads: database.prepare('SELECT * FROM feedback_reads ORDER BY feedback_id').all()
    };

    expect(migrate(database)).toContain('feedbackQuestions');

    // Later steps may add columns; every column the thread had keeps its value.
    const after = database.prepare('SELECT * FROM feedback ORDER BY id').all();
    expect(after).toHaveLength(STATES.length);
    after.forEach((row, index) => expect(row).toMatchObject(before.feedback[index]));
    expect(database.prepare('SELECT * FROM feedback_comments ORDER BY id').all())
      .toEqual(before.comments.map((row) => expect.objectContaining(row)));
    expect(database.prepare('SELECT * FROM feedback_votes ORDER BY feedback_id').all()).toEqual(before.votes);
    expect(database.prepare('SELECT * FROM feedback_reads ORDER BY feedback_id').all()).toEqual(before.reads);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    // The drop takes the table's indexes with it; the indexes step must bring them back.
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='feedback'").all()
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_feedback_reporter', 'idx_feedback_type_status']));

    expectQuestionChecks(database);
    database.close();
  });

  it('runs once, and then never again', () => {
    const database = legacyDatabase();
    migrate(database);

    expect(migrate(database)).not.toContain('feedbackQuestions');
    database.close();
  });

  it('has nothing to do on a fresh database, which already takes questions', () => {
    const database = open();

    expect(migrate(database)).not.toContain('feedbackQuestions');

    expectQuestionChecks(database);
    database.close();
  });

  it('still cascades a thread delete to its children after the rebuild', () => {
    const database = legacyDatabase();
    migrate(database);

    database.prepare("DELETE FROM feedback WHERE id = 'f-0'").run();

    expect(database.prepare("SELECT COUNT(*) AS n FROM feedback_comments WHERE feedback_id = 'f-0'").get().n).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS n FROM feedback_comments').get().n).toBe(STATES.length - 1);
    database.close();
  });
});
