import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { app, db, paths } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';
import { makeVrm1 } from './glbFixture.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { saveThumbnail } = require('../src/utils/fileStorage');
const { placeholderFor } = require('../src/config/placeholderThumbnails');
const { apply: addPlaceholderColumn } = require('../src/schema/steps/placeholderFlag');
const { backfillPlaceholders } = require('../src/utils/backfillPlaceholders');

const create = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

const update = (user, id, body) =>
  request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

const storedFlag = (id) => db.prepare('SELECT placeholder FROM worlds WHERE id = ?').get(id).placeholder;

/** An entity published before the flag existed: the stand-in copy on disk, the flag at its default. */
const publishedWithoutArt = async (user, overrides = {}) => {
  const res = await create(user, { kind: 'entity', thumbnail: undefined, ...overrides });
  db.prepare('UPDATE worlds SET placeholder = 0 WHERE id = ?').run(res.body.data.id);
  return res.body.data.id;
};

/** A row written straight into the table, for a kind whose publish gate needs a real file (avatars). */
const insertRow = async (author, kind, thumbnail) => {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file, kind)
    VALUES (?, ?, '', ?, ?, ?, ?)
  `).run(id, `${kind} row`, author.id, await saveThumbnail(thumbnail), `${id}.json`, kind);
  return id;
};

describe('placeholder column step', () => {
  const legacyDb = () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE worlds (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'world');
      INSERT INTO worlds (id, kind) VALUES ('old', 'entity');
    `);
    return legacy;
  };

  it('adds the column with every existing row unflagged', () => {
    const legacy = legacyDb();

    expect(addPlaceholderColumn(legacy)).toBe(true);
    expect(legacy.prepare("SELECT placeholder FROM worlds WHERE id = 'old'").get().placeholder).toBe(0);
    legacy.close();
  });

  it('does nothing on a second run', () => {
    const legacy = legacyDb();
    addPlaceholderColumn(legacy);

    expect(addPlaceholderColumn(legacy)).toBe(false);
    legacy.close();
  });
});

describe('placeholder flag on publish and update', () => {
  it('flags an entity published without a thumbnail, and still stores its stand-in copy', async () => {
    const author = createUser();

    const res = await create(author, { kind: 'entity', thumbnail: undefined });

    expect(res.status).toBe(201);
    expect(res.body.data.placeholder).toBe(true);
    expect(storedFlag(res.body.data.id)).toBe(1);
    expect(res.body.data.thumbnail).toBe(placeholderFor('entity'));
  });

  it('leaves an entity published with a thumbnail unflagged', async () => {
    const author = createUser();

    const res = await create(author, { kind: 'entity', thumbnail: TINY_PNG });

    expect(res.status).toBe(201);
    expect(res.body.data.placeholder).toBe(false);
  });

  it('never flags a dictionary, whose stand-in stays its art', async () => {
    const author = createUser();

    const res = await create(author, { kind: 'dictionary', thumbnail: undefined });

    expect(res.status).toBe(201);
    expect(res.body.data.placeholder).toBe(false);
  });

  it('never flags an avatar, though its stand-in is the entity picture', async () => {
    const author = createUser();
    const meta = {
      avatarPermission: 'everyone',
      allowRedistribution: true,
      modification: 'allowModificationRedistribution',
      commercialUsage: 'corporation',
    };

    const res = await request(app).post('/api/worlds').set(authHeader(author)).send({
      name: 'Avatar',
      kind: 'model',
      contentData: {
        vrm: `data:model/vnd.vrm;base64,${makeVrm1(meta).toString('base64')}`,
        license: { metaVersion: '1', ...meta },
        hash: 'test-hash',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.thumbnail).toBe(placeholderFor('model'));
    expect(res.body.data.placeholder).toBe(false);
  });

  it('clears the flag when an update sends art', async () => {
    const author = createUser();
    const { body } = await create(author, { kind: 'entity', thumbnail: undefined });

    const res = await update(author, body.data.id, { thumbnail: TINY_PNG });

    expect(res.status).toBe(200);
    expect(res.body.data.placeholder).toBe(false);
    expect(storedFlag(body.data.id)).toBe(0);
  });

  it('keeps the flag through an update that sends no art', async () => {
    const author = createUser();
    const { body } = await create(author, { kind: 'entity', thumbnail: undefined });

    const res = await update(author, body.data.id, { name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.placeholder).toBe(true);
  });
});

describe('placeholder in listing responses', () => {
  it('is a boolean on the catalog, the author lists and a listing opened on its own', async () => {
    const author = createUser();
    const blank = (await create(author, { kind: 'entity', thumbnail: undefined, name: 'Blank' })).body.data.id;
    const drawn = (await create(author, { kind: 'entity', thumbnail: TINY_PNG, name: 'Drawn' })).body.data.id;
    const flagOf = (rows, id) => rows.find((row) => row.id === id).placeholder;

    const catalog = await request(app).get('/api/worlds?kind=entity');
    const profile = await request(app).get(`/api/users/${author.id}/worlds?kind=entity`);
    const mine = await request(app).get('/api/users/me/worlds?kind=entity').set(authHeader(author));
    const detail = await request(app).get(`/api/worlds/${blank}`);

    for (const rows of [catalog.body.data, profile.body.data, mine.body.data]) {
      expect(flagOf(rows, blank)).toBe(true);
      expect(flagOf(rows, drawn)).toBe(false);
    }
    expect(detail.body.data.placeholder).toBe(true);
  });

  it('is a boolean on the staff list of what an account liked', async () => {
    const author = createUser();
    const reader = createUser();
    const staff = createUser({ accountType: 'mod' });
    const blank = (await create(author, { kind: 'entity', thumbnail: undefined })).body.data.id;
    await request(app).put(`/api/worlds/${blank}/like`).set(authHeader(reader)).send({ liked: true });

    const res = await request(app).get(`/api/users/${reader.id}/likes`).set(authHeader(staff));

    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].placeholder).toBe(true);
  });
});

describe('backfillPlaceholders', () => {
  it('flags an entity carrying the stand-in, and not one with its own art', async () => {
    const author = createUser();
    const blank = await publishedWithoutArt(author);
    const drawn = (await create(author, { kind: 'entity', thumbnail: TINY_PNG })).body.data.id;

    const result = backfillPlaceholders({ write: true });

    expect(result).toEqual({ found: 1, flagged: 1 });
    expect(storedFlag(blank)).toBe(1);
    expect(storedFlag(drawn)).toBe(0);
  });

  it('never flags an avatar, though its stand-in is the same picture', async () => {
    const author = createUser();
    const avatar = await insertRow(author, 'model', placeholderFor('model'));

    expect(backfillPlaceholders({ write: true })).toEqual({ found: 0, flagged: 0 });
    expect(storedFlag(avatar)).toBe(0);
  });

  it('only reports what it would flag until asked to write', async () => {
    const author = createUser();
    const blank = await publishedWithoutArt(author);

    expect(backfillPlaceholders()).toEqual({ found: 1, flagged: 0 });
    expect(storedFlag(blank)).toBe(0);
  });

  it('flags nothing on a second run', async () => {
    const author = createUser();
    await publishedWithoutArt(author);
    backfillPlaceholders({ write: true });

    expect(backfillPlaceholders({ write: true })).toEqual({ found: 0, flagged: 0 });
  });

  it('skips a row whose thumbnail file is gone', async () => {
    const author = createUser();
    const blank = await publishedWithoutArt(author);
    const { thumbnail_file: file } = db.prepare('SELECT thumbnail_file FROM worlds WHERE id = ?').get(blank);
    fs.unlinkSync(path.join(paths.THUMBNAILS_DIR, file));

    expect(backfillPlaceholders({ write: true })).toEqual({ found: 0, flagged: 0 });
  });

  it('leaves the date and revision alone, since nothing a downloader receives changed', async () => {
    const author = createUser();
    const blank = await publishedWithoutArt(author);
    const before = db.prepare('SELECT updated_at, revision FROM worlds WHERE id = ?').get(blank);

    backfillPlaceholders({ write: true });

    expect(db.prepare('SELECT updated_at, revision FROM worlds WHERE id = ?').get(blank)).toEqual(before);
  });
});
