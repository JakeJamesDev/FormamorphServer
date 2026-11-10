import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
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

const scratchDirs = [];

/** A fresh folder under the OS temp dir, removed once the file's tests are done (setup.js). */
export function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Removes every scratch folder, then throws once if any could not be removed. */
export function removeScratchDirs() {
  const errors = [];
  for (const dir of scratchDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `Could not remove ${errors.length} scratch folder(s)`);
}

// Must be set before anything reads `config/paths`, which resolves once at load. A caller's own root is
// kept, and is never removed.
process.env.STORAGE_ROOT ||= scratchDir('fms-test-');
// Routine request lines go to files; keep a test run's lines out of the checkout.
process.env.REQUEST_LOGS_DIR ||= scratchDir('fms-test-logs-');

const require = createRequire(import.meta.url);

export const paths = require('../src/config/paths');
export const db = require('../src/config/db');
export const app = require('../src/app');
export const { migrate } = require('../src/schema');
export const { initStorage } = require('../src/utils/fileStorage');
export const Event = require('../src/models/Event');
export const Changelog = require('../src/models/Changelog');
export const { sweepEvents, cancelEvent } = require('../src/utils/sweepEvents');

/**
 * One listening server per worker, reached over kept-alive connections.
 *
 * Handed the bare app, supertest binds a fresh port and opens an unpooled connection for every request.
 * A full run then leaves thousands of sockets in TIME_WAIT, and two or three runs in a row exhaust the
 * ephemeral port range. `keepAliveTimeout = 0` stops the server closing an idle socket the agent is
 * about to reuse; `closeServer` (setup.js) ends both once the file is done.
 */
const supertest = require('supertest');
const server = http.createServer(app);
server.keepAliveTimeout = 0;
const keepAlive = new http.Agent({ keepAlive: true });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

/** supertest's `request(app)`, sent to this worker's server. */
export function request(target) {
  if (target !== app) throw new Error('request() drives the shared app only');
  const client = supertest(server);
  return Object.fromEntries(Object.entries(client).map(([method, start]) => [method, (url) => start(url).agent(keepAlive)]));
}

export function closeServer() {
  keepAlive.destroy();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}
