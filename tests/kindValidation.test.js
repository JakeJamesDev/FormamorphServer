import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const { KIND_RULES, rulesFor, DEFAULT_KIND } = require('../src/config/kinds');
const { placeholderFor } = require('../src/config/placeholderThumbnails');

const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);

/** A payload with the named fields removed, mimicking a client that has nothing to put in them. */
const without = (overrides, ...omit) => {
  const body = worldPayload(overrides);
  for (const key of omit) delete body[key];
  return body;
};

describe('per-kind required fields', () => {
  it('still requires a description and thumbnail for a world', async () => {
    const user = createUser();
    const noDesc = await post(user, without({ name: 'W' }, 'description'));
    const noThumb = await post(user, without({ name: 'W' }, 'thumbnail'));

    // Assert *why* it failed, not just that it did: without the rule, a thumbnail-less world still 400s —
    // it just fails further downstream in saveThumbnail with 'Invalid base64 image string'. Checking only
    // the status can't tell a working rule from a lucky accident.
    expect(noDesc.status).toBe(400);
    expect(noDesc.body.errors.map((e) => e.msg)).toContain('Description is required');
    expect(noThumb.status).toBe(400);
    expect(noThumb.body.errors.map((e) => e.msg)).toContain('Thumbnail is required');
  });

  it('accepts a character with neither description nor thumbnail', async () => {
    const user = createUser();
    const res = await post(user, without({ name: 'Mara', kind: 'entity' }, 'description', 'thumbnail'));

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT kind, description FROM worlds WHERE id = ?').get(res.body.data.id);
    expect(row.kind).toBe('entity');
    expect(row.description).toBe(''); // NOT NULL satisfied without a table rebuild
  });

  it('accepts a dictionary with neither description nor thumbnail', async () => {
    const user = createUser();
    const res = await post(user, without({ name: 'Lore', kind: 'dictionary' }, 'description', 'thumbnail'));

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT kind, description FROM worlds WHERE id = ?').get(res.body.data.id);
    expect(row.kind).toBe('dictionary');
    expect(row.description).toBe('');
  });

  it('keeps a description and thumbnail when a character does supply them', async () => {
    const user = createUser();
    const res = await post(user, worldPayload({ name: 'Portrayed', kind: 'entity', description: 'a knight' }));

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT description FROM worlds WHERE id = ?').get(res.body.data.id);
    expect(row.description).toBe('a knight');
  });

  it('still enforces the name on every kind', async () => {
    const user = createUser();
    for (const kind of ['world', 'entity', 'dictionary']) {
      const res = await post(user, without({ kind }, 'name'));
      expect(res.status, kind).toBe(400);
    }
  });
});

describe('placeholder thumbnails', () => {
  it('gives a thumbnail-less character servable stand-in art', async () => {
    const user = createUser();
    const created = await post(user, without({ name: 'Faceless', kind: 'entity' }, 'thumbnail'));

    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(detail.body.data.thumbnailUrl).toMatch(/^\/api\/thumbnails\//);

    const img = await request(app).get(detail.body.data.thumbnailUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image');
  });

  it('gives each row its own copy, so deleting one keeps the others', async () => {
    const user = createUser();
    const a = await post(user, without({ name: 'A', kind: 'dictionary' }, 'thumbnail'));
    const b = await post(user, without({ name: 'B', kind: 'dictionary' }, 'thumbnail'));

    const fileA = db.prepare('SELECT thumbnail_file FROM worlds WHERE id = ?').get(a.body.data.id).thumbnail_file;
    const fileB = db.prepare('SELECT thumbnail_file FROM worlds WHERE id = ?').get(b.body.data.id).thumbnail_file;
    expect(fileA).not.toBe(fileB); // a shared file would be deleted out from under B

    await request(app).delete(`/api/worlds/${a.body.data.id}`).set(authHeader(user));

    const detailB = await request(app).get(`/api/worlds/${b.body.data.id}`);
    const imgB = await request(app).get(detailB.body.data.thumbnailUrl);
    expect(imgB.status).toBe(200);
  });

  it('prefers the author’s own image over the placeholder', async () => {
    const user = createUser();
    const created = await post(user, worldPayload({ name: 'Has Portrait', kind: 'entity', thumbnail: TINY_PNG }));

    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.thumbnail).toBe(TINY_PNG); // round-trips the uploaded image, not the stand-in
  });

  it('has stand-in art for the kinds that need it, and none for worlds', () => {
    expect(placeholderFor('entity')).toMatch(/^data:image\/png;base64,/);
    expect(placeholderFor('dictionary')).toMatch(/^data:image\/png;base64,/);
    expect(placeholderFor('model')).toMatch(/^data:image\/png;base64,/);
    expect(placeholderFor('world')).toBeNull(); // worlds must bring their own
  });
});

describe('per-kind size caps', () => {
  it('rejects a dictionary larger than its cap', async () => {
    const user = createUser();
    const fat = { entries: ['x'.repeat(KIND_RULES.dictionary.maxContentBytes + 100)] };
    const res = await post(user, without({ name: 'Fat Book', kind: 'dictionary', contentData: fat }, 'thumbnail'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Dictionary');
  });

  it('accepts content that a world may carry but a dictionary may not', async () => {
    const user = createUser();
    const payload = { blob: 'x'.repeat(KIND_RULES.dictionary.maxContentBytes + 100) };

    const asDict = await post(user, without({ name: 'D', kind: 'dictionary', contentData: payload }, 'thumbnail'));
    expect(asDict.status).toBe(400);

    const asWorld = await post(user, worldPayload({ name: 'W', contentData: payload }));
    expect(asWorld.status).toBe(201); // same bytes, allowed for the kind that may need them
  });

  it('caps each kind below the one before it', () => {
    expect(KIND_RULES.dictionary.maxContentBytes).toBeLessThan(KIND_RULES.entity.maxContentBytes);
    expect(KIND_RULES.entity.maxContentBytes).toBeLessThan(KIND_RULES.world.maxContentBytes);
  });

  it('falls back to the default kind’s rules for an unknown one', () => {
    expect(rulesFor('banana')).toBe(KIND_RULES[DEFAULT_KIND]);
  });
});

describe('updating a listing', () => {
  it('refuses to turn one kind into another', async () => {
    // The stored row's kind is authoritative. Without this a PUT naming your world writes character
    // content into it while the row still reads kind='world' — the catalog lists it as a world and the
    // client migrates a character as one. The UI only offers same-kind targets, but that's a convention.
    const user = createUser();
    const world = await post(user, worldPayload({ name: 'My World' }));

    const res = await request(app)
      .put(`/api/worlds/${world.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Hijacked', kind: 'entity', contentData: { id: 'e1', name: 'Mara' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot change a world listing into a entity/);
  });

  it('keeps the row’s kind when the body names it correctly', async () => {
    const user = createUser();
    const created = await post(user, without({ name: 'Mara', kind: 'entity' }, 'thumbnail'));

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Mara the Bold', kind: 'entity' });

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT kind FROM worlds WHERE id = ?').get(created.body.data.id).kind).toBe('entity');
  });

  it('enforces the kind’s size cap on update, not just on create', async () => {
    // The bypass this closes: publish a 1KB dictionary (accepted), then PUT the oversized body onto it.
    const user = createUser();
    const small = await post(user, without({ name: 'Small Book', kind: 'dictionary' }, 'thumbnail'));

    const fat = { entries: ['x'.repeat(KIND_RULES.dictionary.maxContentBytes + 100)] };
    const res = await request(app)
      .put(`/api/worlds/${small.body.data.id}`)
      .set(authHeader(user))
      .send({ contentData: fat });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Dictionary');
  });

  it('still allows a world the content a world may carry', async () => {
    const user = createUser();
    const world = await post(user, worldPayload({ name: 'Big World' }));
    const payload = { blob: 'x'.repeat(KIND_RULES.dictionary.maxContentBytes + 100) };

    const res = await request(app)
      .put(`/api/worlds/${world.body.data.id}`)
      .set(authHeader(user))
      .send({ contentData: payload });

    expect(res.status).toBe(200); // same bytes a dictionary is refused
  });
});
