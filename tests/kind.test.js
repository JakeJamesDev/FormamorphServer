import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: addKindColumn } = require('../src/schema/steps/kind');
const { KINDS, DEFAULT_KIND } = require('../src/config/kinds');

const create = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

/** A database on the pre-`kind` schema, as the live server's is before the migration runs. */
function legacyDb() {
  const legacy = new Database(':memory:');
  legacy.exec(`
    CREATE TABLE worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      author_id TEXT NOT NULL,
      thumbnail_file TEXT NOT NULL,
      content_file TEXT NOT NULL,
      downloads INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      tags TEXT,
      spoiler INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacy
    .prepare(
      `INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file)
       VALUES ('w-old', 'Existing World', 'published before kind existed', 'u1', 't.png', 'w-old.json')`,
    )
    .run();
  return legacy;
}

describe('addKindColumn migration', () => {
  it('classifies every pre-existing row as a world, with no backfill pass', () => {
    const legacy = legacyDb();
    expect(addKindColumn(legacy)).toBe(true);

    const row = legacy.prepare("SELECT kind FROM worlds WHERE id = 'w-old'").get();
    expect(row.kind).toBe('world');
    legacy.close();
  });

  it('is idempotent — a second run is a no-op', () => {
    const legacy = legacyDb();
    addKindColumn(legacy);
    expect(addKindColumn(legacy)).toBe(false); // already migrated, nothing to do

    const cols = legacy.prepare('PRAGMA table_info(worlds)').all().filter((c) => c.name === 'kind');
    expect(cols).toHaveLength(1);
    legacy.close();
  });

  it('leaves existing row data untouched', () => {
    const legacy = legacyDb();
    addKindColumn(legacy);

    const row = legacy.prepare("SELECT * FROM worlds WHERE id = 'w-old'").get();
    expect(row.name).toBe('Existing World');
    expect(row.content_file).toBe('w-old.json');
    legacy.close();
  });

  it('is a no-op on a database with no schema yet, rather than crashing the boot', () => {
    // server.js runs this at startup. A fresh deploy (empty DATA_DIR, `npm start` before `npm run init-db`)
    // has a database file with no tables — `PRAGMA table_info` returns [] there rather than throwing, so
    // without an explicit table check this reached ALTER TABLE and killed the process on boot.
    const empty = new Database(':memory:');

    expect(() => addKindColumn(empty)).not.toThrow();
    expect(addKindColumn(empty)).toBe(false);

    empty.close();
  });

  it('leaves a pre-kind database queryable, so a deploy cannot outrun the migration', () => {
    // The hazard this guards: every list query filters on `worlds.kind`. Booting the new code against a
    // database that predates the column 500s the whole catalog ("no such column: w.kind"), for everyone,
    // until someone runs the migration by hand. server.js runs this at startup so the order can't bite.
    const legacy = legacyDb();
    expect(() => legacy.prepare('SELECT kind FROM worlds').all()).toThrow(/no such column/);

    addKindColumn(legacy);

    expect(legacy.prepare('SELECT kind FROM worlds').all()).toEqual([{ kind: 'world' }]);
    legacy.close();
  });
});

describe('kind defaults', () => {
  it('stores a create with no kind as a world', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Implicit World' });

    const row = db.prepare('SELECT kind FROM worlds WHERE id = ?').get(created.body.data.id);
    expect(row.kind).toBe('world');
  });

  it('exposes the allowed kinds and a world default', () => {
    expect(KINDS).toEqual(['world', 'entity', 'dictionary']);
    expect(DEFAULT_KIND).toBe('world');
  });
});

describe('kind filtering — the contract with already-deployed clients', () => {
  it('never hands a character to a client that asks for no kind', async () => {
    const user = createUser();
    await create(user, { name: 'A World' });
    await create(user, { name: 'A Character', kind: 'entity' });
    await create(user, { name: 'A Lorebook', kind: 'dictionary' });

    // Exactly what a pre-`kind` client sends.
    const res = await request(app).get('/api/worlds');

    expect(res.body.data.map((w) => w.name)).toEqual(['A World']);
    expect(res.body.total).toBe(1);
  });

  it('returns only the kind asked for', async () => {
    const user = createUser();
    await create(user, { name: 'A World' });
    await create(user, { name: 'A Character', kind: 'entity' });
    await create(user, { name: 'Another Character', kind: 'entity' });

    const entities = await request(app).get('/api/worlds?kind=entity');
    expect(entities.body.data.map((w) => w.name).sort()).toEqual(['A Character', 'Another Character']);
    expect(entities.body.total).toBe(2);

    const dicts = await request(app).get('/api/worlds?kind=dictionary');
    expect(dicts.body.data).toEqual([]);
    expect(dicts.body.total).toBe(0);
  });

  it('scopes the total, not just the page, so pagination is per kind', async () => {
    const user = createUser();
    for (const name of ['W1', 'W2', 'W3']) await create(user, { name });
    for (const name of ['E1', 'E2']) await create(user, { name, kind: 'entity' });

    const worlds = await request(app).get('/api/worlds?limit=2');
    expect(worlds.body.total).toBe(3);

    const entities = await request(app).get('/api/worlds?kind=entity&limit=2');
    expect(entities.body.total).toBe(2);
  });

  it('scopes search to the kind', async () => {
    const user = createUser();
    await create(user, { name: 'Shared Name' });
    await create(user, { name: 'Shared Name', kind: 'entity' });

    const res = await request(app).get('/api/worlds?search=Shared&kind=entity');
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].kind).toBe('entity');
  });

  it('rejects an unknown kind rather than silently returning nothing', async () => {
    const res = await request(app).get('/api/worlds?kind=banana');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('banana');
  });
});

describe('kind=all — opt-in, for a client that fetches the catalog whole', () => {
  it('returns every kind when asked for by name', async () => {
    const user = createUser();
    await create(user, { name: 'A World' });
    await create(user, { name: 'A Character', kind: 'entity' });
    await create(user, { name: 'A Lorebook', kind: 'dictionary' });

    const res = await request(app).get('/api/worlds?kind=all');

    expect(res.body.total).toBe(3);
    expect(res.body.data.map((w) => w.kind).sort()).toEqual(['dictionary', 'entity', 'world']);
  });

  it('tags each row with its kind so the client can split them', async () => {
    const user = createUser();
    await create(user, { name: 'W' });
    await create(user, { name: 'E', kind: 'entity' });

    const res = await request(app).get('/api/worlds?kind=all');
    const byName = Object.fromEntries(res.body.data.map((w) => [w.name, w.kind]));
    expect(byName).toEqual({ W: 'world', E: 'entity' });
  });

  it('still gives a client that sends nothing worlds only', async () => {
    const user = createUser();
    await create(user, { name: 'A World' });
    await create(user, { name: 'A Character', kind: 'entity' });

    // `all` must be opt-in: adding it cannot change what a pre-`kind` client sees.
    const res = await request(app).get('/api/worlds');
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].kind).toBe('world');
  });

  it('refuses to store `all` as a row kind — it is a query, not a value', async () => {
    const user = createUser();
    const res = await create(user, { name: 'Bad', kind: 'all' });

    expect(res.status).toBe(400);
    // Assert the rule that rejected it, not just that something did.
    expect(res.body.errors.map((e) => e.msg)).toContain(`Kind must be one of: ${KINDS.join(', ')}`);
  });
});

describe('creating non-world kinds', () => {
  it('creates a character', async () => {
    const user = createUser();
    const res = await create(user, { name: 'Mara', kind: 'entity' });

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT kind FROM worlds WHERE id = ?').get(res.body.data.id);
    expect(row.kind).toBe('entity');
  });

  it('rejects an unknown kind on create', async () => {
    const user = createUser();
    const res = await create(user, { name: 'Bad', kind: 'banana' });
    expect(res.status).toBe(400);
  });

  it('still requires authentication', async () => {
    const res = await request(app).post('/api/worlds').send(worldPayload({ kind: 'entity' }));
    expect(res.status).toBe(401);
  });

  it('gives characters the same ownership rules as worlds', async () => {
    const owner = createUser({ username: 'char-owner' });
    const stranger = createUser({ username: 'char-stranger' });
    const created = await create(owner, { name: 'Not Yours', kind: 'entity' });

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(stranger))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
  });

  it('lets characters be commented on, like worlds', async () => {
    const user = createUser({ username: 'char-commenter' });
    const created = await create(user, { name: 'Commentable Character', kind: 'entity' });

    const post = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .set(authHeader(user))
      .send({ content: 'great character' });

    expect(post.status).toBe(201);
  });

  it('serves a character’s content and detail like a world’s', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Fetchable', kind: 'entity' });

    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.kind).toBe('entity');

    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.status).toBe(200);
  });
});
