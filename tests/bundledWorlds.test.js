import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import request from 'supertest';
import { app, db, paths } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
// The test list (vitest.config) holds this world's fingerprint and nothing else.
const bundled = require('./fixtures/bundled-world.json');

const REFUSAL = 'This is a bundled world. Edit it to make it your own, then publish.';

const publish = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

const update = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

const edited = () => {
  const world = structuredClone(bundled);
  world.entities[0].aiDescription = 'Mara runs the ferry and takes anyone across who can pay her in songs.';
  return world;
};

const storedFiles = () => [paths.WORLDS_DIR, paths.THUMBNAILS_DIR].flatMap((dir) => fs.readdirSync(dir));
const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;

describe('publishing a bundled world', () => {
  it('refuses it and stores nothing', async () => {
    const user = createUser();
    const filesBefore = storedFiles();

    const res = await publish(user, { contentData: bundled });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REFUSAL });
    expect(rowCount()).toBe(0);
    expect(storedFiles()).toEqual(filesBefore);
  });

  it('refuses a copy whose whitespace, short values, and stat code differ', async () => {
    const copy = structuredClone(bundled);
    copy.worldOverview.name = 'Fixture Harbor (copy)';
    copy.stats[0].code = 'return self.value + 2;';
    copy.entities[0].aiDescription = `  ${copy.entities[0].aiDescription.replace(/ /g, '   ')}\n`;

    const res = await publish(createUser(), { contentData: copy });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REFUSAL);
  });

  it('accepts it after one long text value changes', async () => {
    const res = await publish(createUser(), { contentData: edited() });

    expect(res.status).toBe(201);
    expect(rowCount()).toBe(1);
  });

  it('accepts an ordinary world', async () => {
    const res = await publish(createUser());

    expect(res.status).toBe(201);
  });

  it('leaves other kinds alone', async () => {
    const res = await publish(createUser(), { kind: 'entity', contentData: bundled, thumbnail: undefined });

    expect(res.status).toBe(201);
  });
});

describe('updating a listing to a bundled world', () => {
  it('refuses it and keeps the stored content', async () => {
    const user = createUser();
    const created = await publish(user, { contentData: edited() });
    const id = created.body.data.id;

    const res = await update(user, id, { contentData: bundled });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REFUSAL });
    const content = await request(app).get(`/api/worlds/${id}/content`);
    expect(content.body.data.contentData).toEqual(edited());
  });

  it('accepts edited content', async () => {
    const user = createUser();
    const created = await publish(user);

    const res = await update(user, created.body.data.id, { contentData: edited() });

    expect(res.status).toBe(200);
  });

  it('accepts an update that sends no content', async () => {
    const user = createUser();
    const created = await publish(user, { contentData: edited() });

    const res = await update(user, created.body.data.id, { name: 'Renamed Harbor' });

    expect(res.status).toBe(200);
  });
});
