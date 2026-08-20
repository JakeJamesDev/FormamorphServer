import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The server, loaded the way the server loads itself.
 *
 * Everything under `src/` is CommonJS and reaches its dependencies through `require`. Importing those files
 * with ESM `import` instead builds a *second* copy of each in vitest's transformed module graph — and since
 * `DB_PATH=:memory:` gives every connection its own database, a second `config/db` means a second database.
 * Tests would then inspect one database while the app wrote to another. So load them through Node's own
 * require, and always take the app and the db from here.
 */

// Must be set before anything reads `config/paths`, which resolves once at load. `||=` so a worker that
// already has one (or a caller overriding it) keeps it.
process.env.STORAGE_ROOT ||= fs.mkdtempSync(path.join(os.tmpdir(), 'fms-test-'));

const require = createRequire(import.meta.url);

export const paths = require('../src/config/paths');
export const db = require('../src/config/db');
export const app = require('../src/app');
export const { createTables, createIndexes } = require('../src/utils/initDb');
export const { initStorage } = require('../src/utils/fileStorage');
export const Event = require('../src/models/Event');
export const { sweepEvents, cancelEvent } = require('../src/utils/sweepEvents');
