import { afterEach } from 'vitest';
import { db, createTables, createIndexes, initStorage } from './context.js';

// Built at module top level, not in `beforeAll`: this file's imports resolve after the test file is
// collected, so a `beforeAll` registered here runs *after* the tests. DB_PATH=:memory: (vitest.config)
// gives each worker a fresh, empty database; STORAGE_ROOT (context.js) gives it a scratch upload dir.
createTables();
createIndexes();
initStorage();

afterEach(() => {
  // Order matters: comments reference worlds, worlds reference users.
  db.exec('DELETE FROM comments; DELETE FROM worlds; DELETE FROM users;');
});
