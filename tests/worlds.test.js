import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app, paths } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const { getThumbnailBase64 } = require('../src/utils/fileStorage');

/**
 * Characterization tests: these pin how worlds behave *today*, before `kind` exists. Their job is to fail
 * if adding entity/dictionary support changes anything about worlds — which is the guarantee the live
 * server's operator needs.
 */

const create = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

describe('GET /api/worlds', () => {
  it('returns an empty, well-formed page when nothing is published', async () => {
    const res = await request(app).get('/api/worlds');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('lists published worlds with their author', async () => {
    const user = createUser({ username: 'author-1' });
    await create(user, { name: 'Sedge Landing' });

    const res = await request(app).get('/api/worlds');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].name).toBe('Sedge Landing');
    // getAll reshapes the joined `author_username` into a nested author and drops the flat column.
    expect(res.body.data[0].author.username).toBe('author-1');
    expect(res.body.data[0].author_username).toBeUndefined();
  });

  it('paginates', async () => {
    const user = createUser();
    for (const name of ['A', 'B', 'C']) await create(user, { name });

    const res = await request(app).get('/api/worlds?page=1&limit=2');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(res.body.total).toBe(3);

    const page2 = await request(app).get('/api/worlds?page=2&limit=2');
    expect(page2.body.data).toHaveLength(1);
  });

  it('searches by name', async () => {
    const user = createUser();
    await create(user, { name: 'Goblin Caves' });
    await create(user, { name: 'Sedge Landing' });

    const res = await request(app).get('/api/worlds?search=goblin');
    expect(res.body.data.map((w) => w.name)).toEqual(['Goblin Caves']);
  });

  it('searches by author when asked', async () => {
    const mine = createUser({ username: 'alice' });
    const theirs = createUser({ username: 'bob' });
    await create(mine, { name: 'Alice World' });
    await create(theirs, { name: 'Bob World' });

    const res = await request(app).get('/api/worlds?search=alice&searchByAuthor=true');
    expect(res.body.data.map((w) => w.name)).toEqual(['Alice World']);
  });

  it('never exposes preview_data in the list (it carries the megabyte thumbnail)', async () => {
    const user = createUser();
    await create(user, { name: 'Heavy' });

    const res = await request(app).get('/api/worlds');
    expect(res.body.data[0].preview_data).toBeUndefined();
  });
});

describe('POST /api/worlds', () => {
  it('rejects an unauthenticated create', async () => {
    const res = await request(app).post('/api/worlds').send(worldPayload());
    expect(res.status).toBe(401);
  });

  it('creates a world for an authenticated author', async () => {
    const user = createUser();
    const res = await create(user, { name: 'Fresh World' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('Fresh World');
    expect(res.body.data.id).toEqual(expect.any(String));
  });

  it('stores content retrievable via the content endpoint', async () => {
    const user = createUser();
    const created = await create(user, { name: 'With Content' });

    const res = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(res.status).toBe(200);
    // The endpoint returns the world record with the file's payload nested under `contentData`.
    expect(res.body.data.contentData.worldOverview.name).toBe('With Content');
  });

  it('serves the uploaded thumbnail', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Thumbed' });

    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);
    const res = await request(app).get(detail.body.data.thumbnailUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image');
  });

  it.each([
    ['name', { name: '' }],
    ['description', { description: '' }],
    ['thumbnail', { thumbnail: '' }],
    ['contentData', { contentData: '' }],
  ])('rejects a create missing %s', async (_field, override) => {
    const user = createUser();
    const res = await create(user, override);
    expect(res.status).toBe(400);
  });

  it('rejects a name over 100 characters', async () => {
    const user = createUser();
    const res = await create(user, { name: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('rejects a thumbnail that is not a real image data-URI', async () => {
    const user = createUser();
    const res = await create(user, { thumbnail: 'not-an-image' });
    expect(res.status).toBe(400);
  });

  it('refuses a subtype that only names something every object inherits', async () => {
    // The allowlist is looked up by the subtype the caller sent, so `constructor` would otherwise find
    // `Object` on the prototype, read as an allowed type, and be written under its stringified form —
    // a filename the thumbnails route can never hand back.
    const user = createUser();
    const res = await create(user, { thumbnail: 'data:image/constructor;base64,AAAA' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported thumbnail type/);
    expect(fs.readdirSync(paths.THUMBNAILS_DIR).some((f) => f.includes('native code'))).toBe(false);
  });
});

describe('GET /api/worlds/:id', () => {
  it('404s an unknown id', async () => {
    const res = await request(app).get('/api/worlds/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns the world with its author', async () => {
    const user = createUser({ username: 'carol' });
    const created = await create(user, { name: 'Detailed' });

    const res = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Detailed');
    expect(res.body.data.author.username).toBe('carol');
  });
});

describe('ownership', () => {
  it('lets the author update their own world', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Mine' });

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Mine, renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Mine, renamed');
  });

  it("refuses to let one user update another's world", async () => {
    const owner = createUser({ username: 'owner' });
    const stranger = createUser({ username: 'stranger' });
    const created = await create(owner, { name: 'Not Yours' });

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(stranger))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
  });

  it("refuses to let one user delete another's world", async () => {
    const owner = createUser({ username: 'owner2' });
    const stranger = createUser({ username: 'stranger2' });
    const created = await create(owner, { name: 'Also Not Yours' });

    const res = await request(app)
      .delete(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(stranger));

    expect(res.status).toBe(403);
  });

  it('lets an admin update anyone’s world', async () => {
    const owner = createUser({ username: 'owner3' });
    const admin = createUser({ username: 'admin1', accountType: 'admin' });
    const created = await create(owner, { name: 'Moderated' });

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(admin))
      .send({ name: 'Moderated by admin' });

    expect(res.status).toBe(200);
  });

  it('lets the author delete their own world', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Doomed' });

    const del = await request(app).delete(`/api/worlds/${created.body.data.id}`).set(authHeader(user));
    expect(del.status).toBe(200);

    const gone = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(gone.status).toBe(404);
  });
});

describe('comments', () => {
  it('rejects an unauthenticated comment', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Commentable' });

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .send({ content: 'nice' });

    expect(res.status).toBe(401);
  });

  it('accepts a comment and lists it back', async () => {
    const user = createUser({ username: 'commenter' });
    const created = await create(user, { name: 'Commentable 2' });

    const post = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .set(authHeader(user))
      .send({ content: 'nice world' });
    expect(post.status).toBe(201);

    const list = await request(app).get(`/api/worlds/${created.body.data.id}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].content).toBe('nice world');
  });

  it('rejects a comment over 1000 characters', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Commentable 3' });

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .set(authHeader(user))
      .send({ content: 'x'.repeat(1001) });

    expect(res.status).toBe(400);
  });
});

describe('spoiler flag', () => {
  it('defaults to false and can be set by the author', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Spoilery' });
    expect(created.body.data.spoiler).toBeFalsy();

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/spoiler`)
      .set(authHeader(user))
      .send({ spoiler: true });
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(detail.body.data.spoiler).toBe(true);
  });

  it('rejects a non-boolean spoiler value', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Spoilery 2' });

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/spoiler`)
      .set(authHeader(user))
      .send({ spoiler: 'yes' });

    expect(res.status).toBe(400);
  });
});

describe('thumbnails route', () => {
  it('404s a missing thumbnail', async () => {
    const res = await request(app).get('/api/thumbnails/nope.png');
    expect(res.status).toBe(404);
  });

  it('refuses to traverse out of the thumbnails directory', async () => {
    const res = await request(app).get('/api/thumbnails/..%2F..%2Fpackage.json');
    expect(res.status).toBe(404);
  });

  it('accepts every allowed image type', async () => {
    const user = createUser();
    const webp = TINY_PNG.replace('image/png', 'image/webp');
    const res = await create(user, { name: 'Webp', thumbnail: webp });
    expect(res.status).toBe(201);
  });

  it('refuses an extension nothing is ever written as', async () => {
    // The files are real, so this isolates the extension allowlist from the existence check: a name the
    // route would have to guess a type for is a miss even when something sits at it. Every stored row is
    // a uuid under one of the four written extensions, so nothing existing turns into a miss.
    for (const name of ['planted.svg', 'planted-no-extension']) {
      fs.writeFileSync(path.join(paths.THUMBNAILS_DIR, name), '<svg/>');
    }

    try {
      expect((await request(app).get('/api/thumbnails/planted.svg')).status).toBe(404);
      expect((await request(app).get('/api/thumbnails/planted-no-extension')).status).toBe(404);
    } finally {
      for (const name of ['planted.svg', 'planted-no-extension']) {
        fs.unlinkSync(path.join(paths.THUMBNAILS_DIR, name));
      }
    }
  });

  it('will not label a file it cannot name a type for as jpeg', async () => {
    // The base64 path answers for the same files the route does, so it owes the same answer: an extension
    // nothing is stored under is a failure, not a type to guess. Guessing hands the client a data-URI
    // whose declared type is not what the bytes are, which no decoder can read.
    const good = path.join(paths.THUMBNAILS_DIR, 'planted-b64.jpeg');
    const bad = path.join(paths.THUMBNAILS_DIR, 'planted-b64.svg');
    fs.writeFileSync(good, 'jpeg-bytes');
    fs.writeFileSync(bad, '<svg/>');

    try {
      await expect(getThumbnailBase64('planted-b64.jpeg')).resolves.toMatch(/^data:image\/jpeg;base64,/);
      await expect(getThumbnailBase64('planted-b64.svg')).rejects.toThrow(/Failed to read thumbnail/);
    } finally {
      fs.unlinkSync(good);
      fs.unlinkSync(bad);
    }
  });

  it('is cacheable forever, because the name never gets reused', async () => {
    const user = createUser();
    const created = await create(user, { name: 'Cached' });
    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);

    const res = await request(app).get(detail.body.data.thumbnailUrl);

    expect(res.headers['cache-control']).toMatch(/immutable/);
    // The client and the server are different origins, so Helmet's default would block the image.
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
