import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, fromItsOwnAddress, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: addUsernameKey } = require('../src/schema/steps/usernameKey');
const { accountsFor } = require('../src/utils/feedbackMentions');
const { foldedUsernameSql } = require('../src/config/username');

/**
 * The folded key: ASCII lowercase, a space read as `_`. Uniqueness, mention resolution, profile lookup and
 * the username search compare it; sign-in does not. Spaced names are seeded, since the rule refuses them.
 */

const keyOf = (id) => db.prepare('SELECT username_key FROM users WHERE id = ?').get(id).username_key;

const register = (username) => fromItsOwnAddress(
  request(app).post('/api/auth/register').send({ username, password: 'password123' })
);

const login = (username, password) => fromItsOwnAddress(
  request(app).post('/api/auth/login').send({ username, password })
);

const profile = (path) => request(app).get(`/api/users/by-username/${path}/profile`);

const names = (res) => res.body.data.map((entry) => entry.username);

describe('the schema step', () => {
  const legacyDb = () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL);
      INSERT INTO users (id, username) VALUES
        ('spaced', 'Jake James'),
        ('mixed', 'Wren-Hallow_9'),
        ('runs', 'a  B'),
        ('accent', 'Zoë Ö');
    `);
    return legacy;
  };

  const keys = (database) => database.prepare('SELECT id, username_key FROM users ORDER BY id').all();

  it('gives every row the fold of its name', () => {
    const legacy = legacyDb();

    expect(addUsernameKey(legacy)).toBe(true);
    // ASCII only: `ë` and `Ö` keep their case.
    expect(keys(legacy)).toEqual([
      { id: 'accent', username_key: 'zoë_Ö' },
      { id: 'mixed', username_key: 'wren-hallow_9' },
      { id: 'runs', username_key: 'a__b' },
      { id: 'spaced', username_key: 'jake_james' }
    ]);
    legacy.close();
  });

  it('changes nothing on a second run', () => {
    const legacy = legacyDb();
    addUsernameKey(legacy);
    const before = keys(legacy);

    expect(addUsernameKey(legacy)).toBe(false);
    expect(keys(legacy)).toEqual(before);
    legacy.close();
  });

  it('serves the folded lookup from an index', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM users WHERE username_key = ${foldedUsernameSql('?')}`)
      .all('Jake James')
      .map((row) => row.detail)
      .join('\n');

    expect(plan).toContain('idx_users_username_key');
  });
});

describe('writes carry the key', () => {
  it('at registration', async () => {
    const res = await register('Mixed_Case');

    expect(res.status).toBe(201);
    expect(keyOf(res.body.user.id)).toBe('mixed_case');
  });

  it('at rename', async () => {
    const user = createUser({ username: 'old name' });
    db.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?').run(user.id);

    const res = await fromItsOwnAddress(
      request(app).post('/api/auth/username').set(authHeader(user)).send({ username: 'New_Name' })
    );

    expect(res.status).toBe(200);
    expect(keyOf(user.id)).toBe('new_name');
  });
});

describe('a spaced account, found by its underscore form', () => {
  it('through mention resolution', () => {
    const jake = createUser({ username: 'Jake James' });
    const text = 'Thanks @jake_james and @Jake_James';

    const mentioned = accountsFor([text])(text);

    expect(mentioned.get('jake_james').id).toBe(jake.id);
  });

  it('through profile lookup, by the underscore and the encoded-space link', async () => {
    const jake = createUser({ username: 'Jake James' });

    for (const path of ['Jake_James', 'jake_james', 'Jake%20James']) {
      const res = await profile(path);
      expect(res.status, path).toBe(200);
      expect(res.body.data).toMatchObject({ id: jake.id, username: 'Jake James' });
    }
  });

  it('through the users list filter', async () => {
    const root = createUser({ username: 'root-admin', accountType: 'admin' });
    createUser({ username: 'Jake James' });
    createUser({ username: 'jakeXjames' });

    for (const search of ['jake_james', 'KE JA']) {
      const res = await request(app).get('/api/users').query({ search }).set(authHeader(root));
      expect(names(res), search).toEqual(['Jake James']);
    }
  });

  it('through the feedback mention suggestions', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'Jake James' });
    createUser({ username: 'jakeXjames' });

    for (const q of ['jake_j', 'Jake J']) {
      const res = await request(app).get('/api/feedback/search/users').query({ q }).set(authHeader(caller));
      expect(names(res), q).toEqual(['Jake James']);
    }
  });

  it('through the world search by author', async () => {
    const jake = createUser({ username: 'Jake James' });
    const other = createUser({ username: 'jakeXjames' });
    for (const [user, name] of [[jake, 'Jake World'], [other, 'Other World']]) {
      const res = await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload({ name }));
      expect(res.status, name).toBe(201);
    }

    for (const search of ['jake_james', 'KE JA']) {
      const res = await request(app).get('/api/worlds').query({ search, searchByAuthor: 'true' });
      expect(res.body.data.map((world) => world.name), search).toEqual(['Jake World']);
    }
  });

  it('but not while it is flagged', async () => {
    const caller = createUser({ username: 'caller' });
    const jake = createUser({ username: 'Jake James' });
    db.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?').run(jake.id);
    const text = '@jake_james';

    expect(accountsFor([text])(text).get('jake_james')).toBeNull();
    const res = await request(app).get('/api/feedback/search/users').query({ q: 'jake' }).set(authHeader(caller));
    expect(names(res)).toEqual([]);
  });
});

describe('uniqueness and sign-in', () => {
  it('refuses "jake_james" with USERNAME_TAKEN when "Jake James" exists', async () => {
    createUser({ username: 'Jake James' });

    const res = await register('jake_james');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'USERNAME_TAKEN' });
  });

  it('signs in by the stored name only, never its underscore form', async () => {
    const jake = createUser({ username: 'Jake James' });

    expect((await login('Jake James', jake.password)).status).toBe(200);
    expect((await login('Jake_James', jake.password)).status).toBe(401);
  });
});
