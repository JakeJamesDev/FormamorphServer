import { describe, it, expect } from 'vitest';
import request from 'supertest';
import path from 'path';
import { db, app, paths } from './context.js';

// Proves the harness itself before anything relies on it: the native better-sqlite3 addon loads under
// vitest, the database is in-memory and schema'd, storage points at scratch, and supertest can drive the
// real Express app without binding a port.
describe('harness', () => {
  it('runs against an in-memory database, not the real file', () => {
    expect(paths.DB_PATH).toBe(':memory:');
  });

  it('points storage at a scratch directory, not the source tree', () => {
    expect(paths.WORLDS_DIR).not.toContain(`src${path.sep}storage`);
  });

  it('loads the native better-sqlite3 addon and has the schema', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      'audit_log', 'comments', 'event_placements', 'events', 'feedback', 'feedback_comments', 'feedback_reads',
      'feedback_votes', 'follows', 'message_states', 'messages', 'policies', 'policy_acceptances',
      'users', 'world_changelog', 'world_likes', 'worlds'
    ]);
  });

  it('gives tests the same database the app writes to', () => {
    // The bug this guards: an ESM import of `config/db` yields a second connection, so the app's writes
    // land in a database the assertions never see.
    db.prepare("INSERT INTO users (id, username, password) VALUES ('u-probe','probe','x')").run();
    const viaApp = require('module')
      .createRequire(import.meta.url)('../src/config/db')
      .prepare('SELECT username FROM users WHERE id = ?')
      .get('u-probe');
    expect(viaApp?.username).toBe('probe');
  });

  it('serves the real Express app through supertest', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});
