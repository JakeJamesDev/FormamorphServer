import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const World = createRequire(import.meta.url)('../src/models/World');

/**
 * The author listing endpoints (`/users/me/worlds`, `/users/:id/worlds`) had no coverage at all, and they
 * reach the same `getAll` the catalog does — so they inherit the kind filter and need the same contract.
 */
const create = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

/** One of each kind, published by `user`. */
async function publishOneOfEach(user) {
  await create(user, { name: 'My World' });
  await create(user, { name: 'My Character', kind: 'entity' });
  await create(user, { name: 'My Lorebook', kind: 'dictionary' });
}

describe('GET /api/users/me/worlds', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/users/me/worlds');
    expect(res.status).toBe(401);
  });

  it('returns worlds only when no kind is named', async () => {
    const user = createUser();
    await publishOneOfEach(user);

    // What a client written before kinds sends.
    const res = await request(app).get('/api/users/me/worlds').set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.map((w) => w.name)).toEqual(['My World']);
  });

  it('returns the author’s characters when asked', async () => {
    const user = createUser();
    await publishOneOfEach(user);

    const res = await request(app).get('/api/users/me/worlds?kind=entity').set(authHeader(user));

    expect(res.body.data.map((w) => w.name)).toEqual(['My Character']);
  });

  it('returns everything the author published with kind=all', async () => {
    const user = createUser();
    await publishOneOfEach(user);

    const res = await request(app).get('/api/users/me/worlds?kind=all').set(authHeader(user));

    expect(res.body.data.map((w) => w.name).sort()).toEqual(['My Character', 'My Lorebook', 'My World']);
    expect(res.body.count).toBe(3);
  });

  it('lists only your own rows, not another author’s', async () => {
    const mine = createUser({ username: 'mine' });
    const theirs = createUser({ username: 'theirs' });
    await create(mine, { name: 'Mine', kind: 'entity' });
    await create(theirs, { name: 'Theirs', kind: 'entity' });

    const res = await request(app).get('/api/users/me/worlds?kind=entity').set(authHeader(mine));

    expect(res.body.data.map((w) => w.name)).toEqual(['Mine']);
  });

  it('rejects an unknown kind', async () => {
    const user = createUser();
    const res = await request(app).get('/api/users/me/worlds?kind=banana').set(authHeader(user));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('banana');
  });

  it('returns more than a page of listings', async () => {
    // `getAll` defaults to 10 rows. An author listing that silently stopped at 10 meant an 11th world
    // could never be offered as an overwrite target — invisible, with nothing in the response to hint at it.
    const user = createUser();
    for (let i = 0; i < 12; i++) await create(user, { name: `World ${i}` });

    const res = await request(app).get('/api/users/me/worlds').set(authHeader(user));

    expect(res.body.data).toHaveLength(12);
    expect(res.body.count).toBe(12);
  });

  it('reports a total alongside the rows', async () => {
    const user = createUser();
    for (let i = 0; i < 3; i++) await create(user, { name: `World ${i}` });

    const res = await request(app).get('/api/users/me/worlds').set(authHeader(user));

    expect(res.body.total).toBe(3);
    expect(res.body.count).toBe(3);
  });
});

describe('World.getByAuthor row ceiling', () => {
  // Proven here rather than over HTTP: the endpoint exposes no `limit`, so making the ceiling bite through
  // it would take 1001 rows. The model takes a limit, so the same property is reachable in milliseconds.
  it('reports the true match count even when the ceiling truncates the rows', async () => {
    const user = createUser();
    for (let i = 0; i < 5; i++) await create(user, { name: `World ${i}` });

    const result = World.getByAuthor(user.id, 'world', 2);

    expect(result.worlds).toHaveLength(2); // ceiling applied
    expect(result.total).toBe(5); // …and the caller can still tell what it missed
  });

  it('defaults to a ceiling far above a page', async () => {
    const user = createUser();
    for (let i = 0; i < 12; i++) await create(user, { name: `World ${i}` });

    expect(World.getByAuthor(user.id).worlds).toHaveLength(12);
  });
});

describe('GET /api/users/:id/worlds', () => {
  it('404s an unknown user', async () => {
    const res = await request(app).get('/api/users/no-such-user/worlds');
    expect(res.status).toBe(404);
  });

  it('returns worlds only when no kind is named', async () => {
    const user = createUser();
    await publishOneOfEach(user);

    const res = await request(app).get(`/api/users/${user.id}/worlds`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((w) => w.name)).toEqual(['My World']);
  });

  it('returns a named kind, publicly', async () => {
    const user = createUser();
    await publishOneOfEach(user);

    const res = await request(app).get(`/api/users/${user.id}/worlds?kind=dictionary`);

    expect(res.body.data.map((w) => w.name)).toEqual(['My Lorebook']);
  });

  it('rejects an unknown kind', async () => {
    const user = createUser();
    const res = await request(app).get(`/api/users/${user.id}/worlds?kind=banana`);
    expect(res.status).toBe(400);
  });
});

/**
 * A profile lists what somebody has published, and quarantine decides how much of that each reader sees.
 *
 * The endpoint is public but reads its caller when there is one: without that, a listing taken out of
 * circulation vanished from its own author's profile with nothing to say why.
 */
describe('quarantine on a public author listing', () => {
  const admin = () => createUser({ username: `root-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });

  /** Publish one world and take it out of circulation. */
  async function seedQuarantined() {
    const root = admin();
    const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
    const id = (await create(author, { name: 'Sedge Landing' })).body.data.id;
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(root)).send({});

    return { root, author, id };
  }

  it('hides it from the room', async () => {
    const { author } = await seedQuarantined();

    const res = await request(app).get(`/api/users/${author.id}/worlds`);

    expect(res.body.data).toEqual([]);
  });

  it('hides it from another signed-in reader', async () => {
    const { author } = await seedQuarantined();
    const stranger = createUser({ username: `stranger-${Math.random().toString(36).slice(2, 8)}` });

    const res = await request(app).get(`/api/users/${author.id}/worlds`).set(authHeader(stranger));

    expect(res.body.data).toEqual([]);
  });

  it('still shows it to its own author', async () => {
    const { author } = await seedQuarantined();

    const res = await request(app).get(`/api/users/${author.id}/worlds`).set(authHeader(author));

    expect(res.body.data.map((w) => w.name)).toEqual(['Sedge Landing']);
    // The marker the profile badges it with; without it the row reads as ordinary and published.
    expect(res.body.data[0].quarantined_at).toBeTruthy();
  });

  it('shows it to the staff on anybody’s profile', async () => {
    const { root, author } = await seedQuarantined();

    const res = await request(app).get(`/api/users/${author.id}/worlds`).set(authHeader(root));

    expect(res.body.data.map((w) => w.name)).toEqual(['Sedge Landing']);
  });
});
