import { afterEach } from 'vitest';
import { createRequire } from 'module';
import { db, migrate, initStorage } from './context.js';

const { PLACEHOLDER_ID } = createRequire(import.meta.url)('../src/config/accountDeletion');

// Built at module top level, not in `beforeAll`: this file's imports resolve after the test file is
// collected, so a `beforeAll` registered here runs *after* the tests. DB_PATH=:memory: (vitest.config)
// gives each worker a fresh, empty database; STORAGE_ROOT (context.js) gives it a scratch upload dir.
migrate(db);
initStorage();

afterEach(() => {
  // Order matters: events reference messages and worlds, message states reference messages, comments
  // reference worlds, everything references users. Feedback is cleared by name rather than left to cascade — its `reporter_id` is SET NULL, so a
  // thread deliberately outlives the account that filed it and would survive into the next test.
  //
  // The reserved `[deleted user]` row stays, as it does on a real server: the schema seeds it once and
  // erasure reassigns to it, so a test that ran second would otherwise find it gone.
  db.exec('DELETE FROM settings; DELETE FROM reports; DELETE FROM events; DELETE FROM audit_log; DELETE FROM follows; DELETE FROM feedback; DELETE FROM policy_acceptances; DELETE FROM policies; DELETE FROM message_states; DELETE FROM messages; DELETE FROM comments; DELETE FROM worlds;');
  db.prepare('DELETE FROM users WHERE id <> ?').run(PLACEHOLDER_ID);
});
