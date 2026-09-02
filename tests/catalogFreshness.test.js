import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

/**
 * Catalog freshness — asking again without downloading again.
 *
 * The catalog is every Listing of every Kind in one request, and most opens fetch a list that has not
 * changed. These tests pin the two halves of that: a browser can reach the freshness check at all (the
 * tag is readable across origins and the conditional header gets through), and the tag really does move
 * whenever anything a list row carries moves. Nothing here inspects how the tag is computed.
 */

const CATALOG = '/api/worlds?kind=all&limit=1000';

let seq = 0;
const rnd = () => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

const withAuth = (req, who) => (who ? req.set(authHeader(who)) : req);

const catalog = (who) => withAuth(request(app).get(CATALOG), who);

/** The catalog asked for again with a tag already held. */
const revalidate = (tag, who) => withAuth(request(app).get(CATALOG).set('If-None-Match', tag), who);

const tagOf = async (who) => (await catalog(who)).headers.etag;

const publish = (author, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(over));

const rename = (author, id, name) =>
  request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ name });

const unpublish = (author, id) => request(app).delete(`/api/worlds/${id}`).set(authHeader(author));

const like = (who, id, liked) =>
  request(app).put(`/api/worlds/${id}/like`).set(authHeader(who)).send({ liked });

const unlike = (staffer, id, userId) =>
  request(app).delete(`/api/worlds/${id}/likes/${userId}`).set(authHeader(staffer));

const comment = (who, id, content) =>
  request(app).post(`/api/worlds/${id}/comments`).set(authHeader(who)).send({ content });

const uncomment = (who, commentId) =>
  request(app).delete(`/api/comments/${commentId}`).set(authHeader(who));

const download = (id) => request(app).get(`/api/worlds/${id}/content`);

const quarantine = (staffer, id) =>
  request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(staffer)).send({ days: 7 });

const release = (staffer, id) =>
  request(app).delete(`/api/worlds/${id}/quarantine`).set(authHeader(staffer));

const setAvatar = (who) =>
  request(app).put('/api/users/me/avatar').set(authHeader(who)).send({ image: TINY_PNG });

/** One published Listing, its Author, somebody to read it, and staff to moderate it. */
const seed = async () => {
  const author = createUser({ username: `author-${rnd()}` });
  const reader = createUser({ username: `reader-${rnd()}` });
  const admin = createUser({ username: `admin-${rnd()}`, accountType: 'admin' });
  const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;
  return { author, reader, admin, id };
};

describe('a catalog that has not changed', () => {
  it('carries a tag, and answers the same tag back with no body', async () => {
    await seed();

    const first = await catalog();
    expect(first.status).toBe(200);
    expect(first.headers.etag).toEqual(expect.any(String));

    const again = await revalidate(first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBeFalsy();
    // The 304 repeats the tag, so a stored one is confirmed rather than replaced.
    expect(again.headers.etag).toBe(first.headers.etag);
  });
});

/**
 * Every write that moves something a list row carries. Each case takes a fresh fixture: `prepare` runs
 * before the tag is taken and returns whatever it adds to that fixture, `change` is the one write under
 * test.
 */
const changes = [
  {
    name: 'a Listing published',
    change: ({ author }) => publish(author, { name: 'Second Landing' }),
  },
  {
    name: 'a Listing edited',
    change: ({ author, id }) => rename(author, id, 'Renamed'),
  },
  {
    name: 'a Listing deleted',
    change: ({ author, id }) => unpublish(author, id),
  },
  {
    name: 'a Like added',
    change: ({ reader, id }) => like(reader, id, true),
  },
  {
    name: 'a Like taken back by its owner',
    prepare: async ({ reader, id }) => { await like(reader, id, true); },
    change: ({ reader, id }) => like(reader, id, false),
  },
  {
    name: 'a Like removed by staff',
    prepare: async ({ reader, id }) => { await like(reader, id, true); },
    change: ({ admin, reader, id }) => unlike(admin, id, reader.id),
  },
  {
    name: 'a Comment added',
    change: ({ reader, id }) => comment(reader, id, 'First!'),
  },
  {
    name: 'a Comment deleted',
    prepare: async ({ reader, id }) => ({ commentId: (await comment(reader, id, 'First!')).body.data.id }),
    change: ({ reader, commentId }) => uncomment(reader, commentId),
  },
  {
    name: 'a download counted',
    change: ({ id }) => download(id),
  },
  {
    name: 'a Listing quarantined',
    change: ({ admin, id }) => quarantine(admin, id),
  },
  {
    name: 'a quarantined Listing released',
    prepare: async ({ admin, id }) => { await quarantine(admin, id); },
    change: ({ admin, id }) => release(admin, id),
  },
  {
    // No route renames an account, so this one write goes straight to the table. What it stands for is a
    // list row's author name changing, which is what the catalog joins and shows.
    name: 'the Author username changed',
    change: ({ author }) =>
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(`renamed-${rnd()}`, author.id),
  },
  {
    name: 'the Author avatar changed',
    change: ({ author }) => setAvatar(author),
  },
];

describe('a catalog that has changed', () => {
  it.each(changes)('answers a new tag after $name', async ({ prepare, change }) => {
    const ctx = await seed();
    if (prepare) Object.assign(ctx, await prepare(ctx));

    const before = await tagOf();
    await change(ctx);

    const res = await revalidate(before);
    expect(res.status).toBe(200);
    // A new tag, not a missing one: without this, losing the tag altogether would read as a change.
    expect(res.headers.etag).toEqual(expect.any(String));
    expect(res.headers.etag).not.toBe(before);
  });

  // The control for the table above: the same shape with no write in the middle must revalidate. Without
  // it, a tag that changed on every request would pass every case.
  it('answers 304 when nothing happened in between', async () => {
    await seed();

    const before = await tagOf();
    const res = await revalidate(before);
    expect(res.status).toBe(304);
  });
});

describe('one reader is never served another reader catalog', () => {
  it('tags a signed-in reader apart from a signed-out visitor', async () => {
    const { reader } = await seed();

    const anonymous = await tagOf();
    const signedIn = await tagOf(reader);
    expect(signedIn).not.toBe(anonymous);

    // Each tag confirms only its own catalog.
    expect((await revalidate(anonymous)).status).toBe(304);
    expect((await revalidate(signedIn, reader)).status).toBe(304);
    expect((await revalidate(anonymous, reader)).status).toBe(200);
    expect((await revalidate(signedIn)).status).toBe(200);
  });

  it('tags an Author holding a quarantined Listing apart from the room that cannot see it', async () => {
    // That the room's catalog omits it is quarantine.test.js's to say; what matters here is that the two
    // catalogs cannot share a tag, so no cache can hand one of them to the other.
    const { author, admin, id } = await seed();
    await quarantine(admin, id);

    expect((await catalog(author)).headers.etag).not.toBe((await catalog()).headers.etag);
  });
});

describe('what the list tells a cache', () => {
  it('marks it private, always revalidated, and keyed by the credential', async () => {
    await seed();

    const res = await catalog();
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toContain('Authorization');
  });

  it('repeats those headers on the 304', async () => {
    await seed();

    const before = await tagOf();
    const res = await revalidate(before);
    expect(res.status).toBe(304);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toContain('Authorization');
  });

  it('leaves the Listing detail and the auth endpoints as they were', async () => {
    const { reader, id } = await seed();

    const detail = await request(app).get(`/api/worlds/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBeUndefined();

    const me = await request(app).get('/api/auth/me').set(authHeader(reader));
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBeUndefined();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: reader.username, password: reader.password });
    expect(login.status).toBe(200);
    expect(login.headers['cache-control']).toBeUndefined();
  });
});

describe('reaching the freshness check from a browser', () => {
  it('lets the preflight through with If-None-Match', async () => {
    const res = await request(app)
      .options(CATALOG)
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'if-none-match');

    const allowed = res.headers['access-control-allow-headers'].toLowerCase();
    expect(allowed).toContain('if-none-match');
    // The headers the app already allowed keep working.
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
  });

  it('exposes the tag to a cross-origin reader', async () => {
    await seed();

    const res = await catalog();
    expect(res.headers['access-control-expose-headers'].toLowerCase()).toContain('etag');
  });

  /**
   * The client has to bypass the browser's own cache to see a 304 at all, and which bypass it picks
   * decides whether it ever gets one. A request `Cache-Control: no-cache` is an end-to-end reload, and
   * the framework answers the whole body to one however well the tag matches — so `fetch` must bypass
   * with `no-store`, never `reload`. Pinned here because nothing on the server would otherwise say so.
   */
  it('answers the whole catalog to a reload, and the tag to a bypass', async () => {
    await seed();
    const tag = await tagOf();

    const reload = await request(app).get(CATALOG).set('If-None-Match', tag).set('Cache-Control', 'no-cache');
    expect(reload.status).toBe(200);

    const bypass = await request(app).get(CATALOG).set('If-None-Match', tag).set('Cache-Control', 'no-store');
    expect(bypass.status).toBe(304);
  });
});
