import { createRequire } from 'module';
import { db } from './context.js';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

/**
 * Seed a user straight into the database rather than through `POST /auth/register`: that route is rate
 * limited to 20 attempts per window and supertest sends every request from one IP, so registering per
 * test would eventually 429 and make the suite flaky. Register/login are covered directly in auth.test.js.
 */
export function createUser({ username = `user-${uuidv4().slice(0, 8)}`, password = 'password123', accountType = 'normal', email = null, status = 'normal', createdAt = null } = {}) {
  const id = uuidv4();
  // `created_at` is left to CURRENT_TIMESTAMP unless a test needs to place the signup relative to
  // something else — broadcast visibility turns on whether the account predates the message.
  if (createdAt) {
    db.prepare('INSERT INTO users (id, username, password, account_type, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, bcrypt.hashSync(password, 10), accountType, email, status, createdAt);
  } else {
    db.prepare('INSERT INTO users (id, username, password, account_type, email, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, username, bcrypt.hashSync(password, 10), accountType, email, status);
  }
  return { id, username, password, accountType, email, status };
}

/**
 * Seed `count` users in one transaction, sharing a pre-computed hash. `createUser` runs bcrypt at cost 10
 * (~40ms each), so seeding enough rows to push past a page ceiling times the test out. These users exist to
 * be listed, never to log in — use `createUser` for anyone who authenticates.
 *
 * @param {number} count - How many users to insert
 * @param {string} [prefix] - Username prefix; names are zero-padded so listing order is readable
 * @returns {Array<Object>} The seeded `{ id, username }` rows
 */
export function seedUsers(count, prefix = 'seeded') {
  const hash = bcrypt.hashSync('password123', 10);
  const insert = db.prepare('INSERT INTO users (id, username, password, account_type) VALUES (?, ?, ?, ?)');
  const rows = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = uuidv4();
      const username = `${prefix}-${String(i).padStart(3, '0')}`;
      insert.run(id, username, hash, 'normal');
      rows.push({ id, username });
    }
  })();
  return rows;
}

/** A bearer header for a seeded user, signed with the same secret `protect` verifies against. */
export function authHeader(user) {
  return { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` };
}

/** Smallest valid PNG data-URI: `saveThumbnail` requires a real base64 image of an allowed type. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A valid `POST /api/worlds` body; override any field per test. */
export function worldPayload(overrides = {}) {
  const name = overrides.name ?? 'Test World';
  return {
    name,
    description: 'A world for testing',
    thumbnail: TINY_PNG,
    previewData: { name, description: 'A world for testing', thumbnail: TINY_PNG },
    contentData: { worldOverview: { name }, stats: [], locations: [], entities: [], traits: [], statUpdates: [] },
    ...overrides,
  };
}
