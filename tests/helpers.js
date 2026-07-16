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
export function createUser({ username = `user-${uuidv4().slice(0, 8)}`, password = 'password123', accountType = 'normal' } = {}) {
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, password, account_type) VALUES (?, ?, ?, ?)')
    .run(id, username, bcrypt.hashSync(password, 10), accountType);
  return { id, username, password, accountType };
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
