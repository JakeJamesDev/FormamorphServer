import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Likes — what a download counter cannot say.
 *
 * Downloads count how many people tried something; likes count how many were glad they did. That is what
 * makes a like per account and revocable where a download is an anonymous tally that only goes up, and it
 * is the whole reason the two numbers sit beside each other.
 */

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const like = (user, id, liked) =>
  request(app).put(`/api/worlds/${id}/like`).set(authHeader(user)).send({ liked });

const list = (user) => {
  const r = request(app).get('/api/worlds');
  return user ? r.set(authHeader(user)) : r;
};

const readOne = (id, user) => {
  const r = request(app).get(`/api/worlds/${id}`);
  return user ? r.set(authHeader(user)) : r;
};

/** One published listing, its author, and somebody else to do the liking. */
const seed = async (over = {}) => {
  const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
  const reader = createUser({ username: `reader-${Math.random().toString(36).slice(2, 8)}` });
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;

  return { author, reader, id };
};

const rowFor = (body, id) => body.data.find((w) => w.id === id);

describe('liking a listing', () => {
  it('needs an account', async () => {
    const { id } = await seed();

    const res = await request(app).put(`/api/worlds/${id}/like`).send({ liked: true });

    expect(res.status).toBe(401);
  });

  it('answers with the state and the new count together', async () => {
    // So the heart and the number beside it can never disagree about what just happened.
    const { reader, id } = await seed();

    const res = await like(reader, id, true);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });

  it('takes the like back', async () => {
    const { reader, id } = await seed();
    await like(reader, id, true);

    const res = await like(reader, id, false);

    expect(res.body.data).toEqual({ liked: false, likes: 0 });
  });

  it('counts one account once, however many times they press it', async () => {
    const { reader, id } = await seed();

    await like(reader, id, true);
    const res = await like(reader, id, true);

    expect(res.body.data.likes).toBe(1);
  });

  it('unliking something never liked is not an error', async () => {
    const { reader, id } = await seed();

    const res = await like(reader, id, false);

    expect(res.status).toBe(200);
    expect(res.body.data.likes).toBe(0);
  });

  it('counts each account separately', async () => {
    const { reader, id } = await seed();
    const other = createUser({ username: `other-${Math.random().toString(36).slice(2, 8)}` });

    await like(reader, id, true);
    const res = await like(other, id, true);

    expect(res.body.data.likes).toBe(2);
  });

  it('refuses your own listing', async () => {
    // Otherwise the count says how many listings somebody has rather than how many people liked them.
    const { author, id } = await seed();

    const res = await like(author, id, true);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/your own/i);
  });

  it('rejects a body that does not say which way', async () => {
    const { reader, id } = await seed();

    const res = await request(app).put(`/api/worlds/${id}/like`).set(authHeader(reader)).send({});

    expect(res.status).toBe(400);
  });

  it('404s a listing that is not there', async () => {
    const reader = createUser({ username: `reader-${Math.random().toString(36).slice(2, 8)}` });

    expect((await like(reader, 'no-such-world', true)).status).toBe(404);
  });

  it('404s a quarantined listing rather than letting the room like it', async () => {
    const root = createUser({ username: `root-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });
    const { reader, id } = await seed();
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(root)).send({});

    expect((await like(reader, id, true)).status).toBe(404);
  });
});

describe('what the catalog says about likes', () => {
  it('carries the count on every row', async () => {
    const { reader, id } = await seed();
    await like(reader, id, true);

    const res = await list(null);

    expect(rowFor(res.body, id).likes).toBe(1);
  });

  it('says zero for something nobody has liked', async () => {
    const { id } = await seed();

    expect(rowFor((await list(null)).body, id).likes).toBe(0);
  });

  it('tells a signed-in reader which ones are theirs', async () => {
    const { reader, id } = await seed();
    const { id: untouched } = await seed({ name: 'Ash Verge' });
    await like(reader, id, true);

    const body = (await list(reader)).body;

    expect(rowFor(body, id).liked).toBe(true);
    expect(rowFor(body, untouched).liked).toBe(false);
  });

  it('leaves `liked` off entirely for a signed-out visitor', async () => {
    // Absent rather than false: somebody with no account has not decided against liking anything, and the
    // heart should read as a number rather than a control they cannot press.
    const { reader, id } = await seed();
    await like(reader, id, true);

    const row = rowFor((await list(null)).body, id);

    expect(row.likes).toBe(1);
    expect(row).not.toHaveProperty('liked');
  });

  it('says the same thing when a listing is read on its own', async () => {
    const { reader, id } = await seed();
    await like(reader, id, true);

    const res = await readOne(id, reader);

    expect(res.body.data.likes).toBe(1);
    expect(res.body.data.liked).toBe(true);
  });

  it('leaves `liked` off a lone listing read signed out too', async () => {
    const { id } = await seed();

    expect((await readOne(id, null)).body.data).not.toHaveProperty('liked');
  });
});

describe('sorting by likes', () => {
  // The liked one is published *first* in both cases on purpose: a `likes` sort that quietly fell back to
  // a date would then give the opposite order, so these fail rather than agree by coincidence.
  it('puts the most liked first', async () => {
    const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
    const a = createUser({ username: `a-${Math.random().toString(36).slice(2, 8)}` });
    const b = createUser({ username: `b-${Math.random().toString(36).slice(2, 8)}` });
    const loved = (await publish(author, { name: 'Loved' })).body.data.id;
    const quiet = (await publish(author, { name: 'Quiet' })).body.data.id;
    await like(a, loved, true);
    await like(b, loved, true);
    await like(a, quiet, true);

    const names = (await request(app).get('/api/worlds?sort=likes&order=desc')).body.data.map((w) => w.name);

    expect(names.indexOf('Loved')).toBeLessThan(names.indexOf('Quiet'));
  });

  it('reverses when asked', async () => {
    const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
    const a = createUser({ username: `a-${Math.random().toString(36).slice(2, 8)}` });
    const loved = (await publish(author, { name: 'Loved' })).body.data.id;
    await publish(author, { name: 'Quiet' });
    await like(a, loved, true);

    const names = (await request(app).get('/api/worlds?sort=likes&order=asc')).body.data.map((w) => w.name);

    expect(names.indexOf('Quiet')).toBeLessThan(names.indexOf('Loved'));
  });

  it('still falls back to newest for a sort nobody recognizes', async () => {
    const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
    await publish(author, { name: 'Older' });
    await publish(author, { name: 'Newer' });

    const res = await request(app).get('/api/worlds?sort=banana&order=desc');

    expect(res.status).toBe(200);
    expect(res.body.data.map((w) => w.name).indexOf('Newer'))
      .toBeLessThan(res.body.data.map((w) => w.name).indexOf('Older'));
  });
});

describe('a listing that goes away', () => {
  it('takes its likes with it', async () => {
    // The row is gone; a like pointing at nothing would keep counting toward a listing nobody can open.
    const { author, reader, id } = await seed();
    await like(reader, id, true);

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author));
    const republished = (await publish(author, { name: 'Sedge Landing' })).body.data.id;

    expect(rowFor((await list(null)).body, republished).likes).toBe(0);
  });
});
