import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const { KIND_RULES } = require('../src/config/kinds');
const { decodedImageBytes } = require('../src/utils/decodedImageBytes');

/**
 * Mascot publishing: the sixth listing kind. Its content is a mascot card, its thumbnail is required, and
 * its 10MB cap counts decoded image bytes. Route-test style follows `modelKind.test.js`.
 */

const MB = 1024 * 1024;

/** A data URL whose decoded payload is exactly `bytes` long. */
const imageOfBytes = (bytes) => `data:image/webp;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

function mascotPayload(overrides = {}) {
  return {
    name: 'Test Mascot',
    kind: 'mascot',
    thumbnail: TINY_PNG,
    contentData: {
      rig: { parts: ['head', 'body'] },
      picks: { eyes: 'open' },
      mask: null,
      voice: { pitch: 1 },
      transition: 'fade',
      layers: { head: imageOfBytes(64), body: imageOfBytes(64) },
    },
    ...overrides,
  };
}

const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);
const put = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const reviewSetting = (value) => {
  const admin = createUser({ username: `admin-${Math.random().toString(16).slice(2, 8)}`, accountType: 'admin' });
  return request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
};

describe('publishing a Mascot', () => {
  it('creates, then returns the card content verbatim', async () => {
    const user = createUser();
    const payload = mascotPayload();
    const created = await post(user, payload);

    expect(created.status).toBe(201);
    expect(created.body.data.kind).toBe('mascot');

    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.contentData).toEqual(payload.contentData);
  });

  it('replaces the content on update', async () => {
    const user = createUser();
    const created = await post(user, mascotPayload());
    const contentData = { ...mascotPayload().contentData, transition: 'slide' };

    const res = await put(user, created.body.data.id, { contentData });

    expect(res.status).toBe(200);
    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.contentData.transition).toBe('slide');
  });

  it('refuses a missing thumbnail', async () => {
    const user = createUser();
    const res = await post(user, mascotPayload({ thumbnail: undefined }));

    expect(res.status).toBe(400);
  });

  it('refuses to turn a Mascot into another kind', async () => {
    const user = createUser();
    const created = await post(user, mascotPayload());

    const res = await put(user, created.body.data.id, { kind: 'world' });
    expect(res.status).toBe(400);
  });

  it('refuses a contest entry', async () => {
    const user = createUser();
    const res = await post(user, mascotPayload({ contestEventId: 'any-event' }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTEST_KIND_REFUSED');
  });
});

describe('the Mascot size cap', () => {
  const overCap = () => ({
    ...mascotPayload().contentData,
    layers: { big: imageOfBytes(KIND_RULES.mascot.maxContentBytes + 1) },
  });

  it('refuses a create over 10MB of decoded images, stating the size and the limit', async () => {
    const user = createUser();
    const res = await post(user, mascotPayload({ contentData: overCap() }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Mascot content is 10.0MB, over the 10MB limit');
  });

  it('refuses an update over the cap', async () => {
    const user = createUser();
    const created = await post(user, mascotPayload());

    const res = await put(user, created.body.data.id, { contentData: overCap() });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Mascot');
  });

  it('counts every layer together, not each alone', async () => {
    const user = createUser();
    const half = KIND_RULES.mascot.maxContentBytes / 2 + 1;
    const res = await post(user, mascotPayload({
      contentData: { layers: { a: imageOfBytes(half), b: imageOfBytes(half) } },
    }));

    expect(res.status).toBe(400);
  });

  it('accepts content just under the cap', async () => {
    const user = createUser();
    const res = await post(user, mascotPayload({
      contentData: { layers: { big: imageOfBytes(KIND_RULES.mascot.maxContentBytes - 1) } },
    }));

    expect(res.status).toBe(201);
  });

  it('counts decoded bytes, so base64 text over 10MB but under 10MB decoded still fits', async () => {
    const user = createUser();
    const decoded = 8 * MB; // about 10.7MB once serialized as base64
    const res = await post(user, mascotPayload({ contentData: { layers: { big: imageOfBytes(decoded) } } }));

    expect(res.status).toBe(201);
  });
});

describe('decodedImageBytes', () => {
  it('sums nested data URLs and ignores other text', () => {
    const value = { a: [imageOfBytes(10), { b: imageOfBytes(5) }], note: 'x'.repeat(1000), n: 3, z: null };
    expect(decodedImageBytes(value)).toBe(15);
  });

  it('accounts for base64 padding', () => {
    for (const bytes of [1, 2, 3, 4]) expect(decodedImageBytes(imageOfBytes(bytes))).toBe(bytes);
  });
});

describe('Listing Review for a Mascot', () => {
  it('holds a new Mascot for review while review is on', async () => {
    expect((await reviewSetting(true)).status).toBe(200);
    const author = createUser();

    const created = await post(author, mascotPayload());
    const own = await request(app).get(`/api/worlds/${created.body.data.id}`).set(authHeader(author));

    expect(own.body.data.moderation_state).toBe('pending');
    expect(own.body.data.listed_at).toBeNull();
  });

  it('lists a new Mascot at once while review is off', async () => {
    const author = createUser();
    const created = await post(author, mascotPayload());

    const own = await request(app).get(`/api/worlds/${created.body.data.id}`).set(authHeader(author));
    expect(own.body.data.moderation_state).toBe('approved');
    expect(own.body.data.listed_at).toBeTruthy();
  });
});

describe('listing and reading', () => {
  it('returns only Mascots when asked for the mascot kind', async () => {
    const user = createUser();
    const mascot = await post(user, mascotPayload());
    await request(app).post('/api/worlds').set(authHeader(user)).send({
      name: 'A World',
      description: 'A marsh',
      thumbnail: TINY_PNG,
      contentData: { worldOverview: { name: 'A World' } },
    });

    const res = await request(app).get('/api/worlds?kind=mascot');
    expect(res.body.data.map((w) => w.id)).toEqual([mascot.body.data.id]);
    expect(res.body.total).toBe(1);
  });

  it('is invisible to a client that asks for no kind', async () => {
    await post(createUser(), mascotPayload());

    const res = await request(app).get('/api/worlds');
    expect(res.body.data).toEqual([]);
  });
});

describe('kind-agnostic rules apply unchanged', () => {
  it('keeps ownership rules', async () => {
    const owner = createUser({ username: 'mascot-owner' });
    const stranger = createUser({ username: 'mascot-stranger' });
    const created = await post(owner, mascotPayload());

    expect((await put(stranger, created.body.data.id, { name: 'Hijacked' })).status).toBe(403);
  });

  it('lets a Mascot be commented on', async () => {
    const user = createUser({ username: 'mascot-commenter' });
    const created = await post(user, mascotPayload());

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .set(authHeader(user))
      .send({ content: 'nice mascot' });
    expect(res.status).toBe(201);
  });

  it('lets a Mascot be liked', async () => {
    const owner = createUser({ username: 'mascot-liked-owner' });
    const liker = createUser({ username: 'mascot-liker' });
    const created = await post(owner, mascotPayload());

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/like`)
      .set(authHeader(liker))
      .send({ liked: true });
    expect(res.status).toBe(200);
    expect(res.body.data.likes).toBe(1);
  });

  it('accepts a Listing Changelog entry', async () => {
    const user = createUser({ username: 'mascot-changelog' });
    const created = await post(user, mascotPayload());

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/changelog`)
      .set(authHeader(user))
      .send({ title: 'New eyes', body: 'Redrew the eyes.', date: '2026-10-27' });
    expect(res.status).toBe(201);
  });

  it('quarantines a Mascot out of the catalog', async () => {
    const owner = createUser({ username: 'mascot-quarantined' });
    const admin = createUser({ username: 'mascot-admin', accountType: 'admin' });
    const created = await post(owner, mascotPayload());

    const res = await request(app).put(`/api/worlds/${created.body.data.id}/quarantine`).set(authHeader(admin)).send({});
    expect(res.status).toBe(200);

    const listed = await request(app).get('/api/worlds?kind=mascot');
    expect(listed.body.data).toEqual([]);
  });

  it('can be reported', async () => {
    const author = createUser({ username: 'mascot-reported' });
    const reporter = createUser({ username: 'mascot-reporter' });
    const created = await post(author, mascotPayload());

    const res = await request(app)
      .post('/api/reports')
      .set(authHeader(reporter))
      .send({ targetKind: 'listing', targetId: created.body.data.id, category: 'stolen' });
    expect(res.status).toBe(201);
  });

  it('deletes with its author and takes its row away', async () => {
    const author = createUser({ username: 'mascot-cascade' });
    const created = await post(author, mascotPayload());

    const del = await request(app).delete(`/api/worlds/${created.body.data.id}`).set(authHeader(author));
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT id FROM worlds WHERE id = ?').get(created.body.data.id)).toBeUndefined();
  });
});
