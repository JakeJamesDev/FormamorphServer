import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, seedLikes } from './helpers.js';

/**
 * A contest entry's like count while its contest runs: kept from the room, shown to its author and staff,
 * and shown to everyone once the results are announced or the entry leaves the contest.
 *
 * Every read that carries a count runs the same table of reader × contest state, so a path that forgets
 * the rule fails here rather than leaking one number to a curious reader.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const as = (req, user) => (user ? req.set(authHeader(user)) : req);

const publish = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(body));

const update = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

const LIKES = 3;

/**
 * A character entered in a contest, with three likes, one from `other`; a world by another author that
 * requires it and that it is offered for; the contest moved into `state`.
 */
const seed = async (state) => {
  const author = createUser({ username: 'reedwright' });
  const other = createUser({ username: 'fenlark' });
  const staff = createUser({ username: 'a-mod', accountType: 'mod' });
  const admin = createUser({ username: 'an-admin', accountType: 'admin' });
  const hostAuthor = createUser({ username: 'sedgekeeper' });

  const event = Event.create({
    type: 'contest',
    title: 'Sedge Landing Contest',
    bannerText: 'Build on Sedge Landing.',
    body: 'Build something on Sedge Landing.',
    startsAt: at(-60),
    endsAt: at(60)
  });

  const entry = (await publish(author, { name: 'Marsh Warden', kind: 'entity', contestEventId: event.id })).body.data;
  const host = (await publish(hostAuthor, { name: 'Sedge Landing', requiredDependencies: [entry.id] })).body.data;
  await request(app).put(`/api/worlds/${entry.id}/compatibility`).set(authHeader(author)).send({ worldIds: [host.id] });

  seedLikes(entry.id, [other, createUser(), createUser()]);

  if (state === 'judging' || state === 'announced') {
    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
  }
  if (state === 'announced') Event.announceResults(event.id);
  if (state === 'withdrawn') {
    expect((await request(app).delete(`/api/worlds/${entry.id}/contest`).set(authHeader(author))).status).toBe(200);
  }
  if (state === 'canceled') {
    expect((await request(app).post(`/api/events/${event.id}/cancel`).set(authHeader(admin))).status).toBe(200);
  }

  return { entry, host, readers: { guest: null, other, author, staff } };
};

/** Every read that carries the entry's count, each returning the entry as that read spells it. */
const PATHS = {
  catalog: async ({ entry }, user) => {
    const res = await as(request(app).get('/api/worlds?kind=entity&limit=100'), user);
    return res.body.data.find((row) => row.id === entry.id);
  },
  listing: async ({ entry }, user) => (await as(request(app).get(`/api/worlds/${entry.id}`), user)).body.data,
  content: async ({ entry }, user) => (await as(request(app).get(`/api/worlds/${entry.id}/content`), user)).body.data,
  dependencies: async ({ host }, user) =>
    (await as(request(app).get(`/api/worlds/${host.id}/dependencies`), user)).body.data.dependencies[0].listing,
  hostListing: async ({ host }, user) =>
    (await as(request(app).get(`/api/worlds/${host.id}`), user)).body.data.requiredDependencies[0].listing,
  dependencyContent: async ({ host, entry }, user) =>
    (await as(request(app).get(`/api/worlds/${host.id}/dependencies/${entry.id}/content`), user)).body.data,
  addons: async ({ host }, user) => (await as(request(app).get(`/api/worlds/${host.id}/addons`), user)).body.data[0]
};

/** The paths that carry the reader's own heart. The downloads never have. */
const CARRIES_LIKED = new Set(['catalog', 'listing', 'dependencies', 'hostListing', 'addons']);

const HIDING_STATES = ['live', 'judging'];
const OPEN_STATES = ['announced', 'withdrawn', 'canceled'];
const READERS = ['guest', 'other', 'author', 'staff'];

const expected = (state, reader) => {
  if (OPEN_STATES.includes(state)) return 'public';
  return reader === 'author' || reader === 'staff' ? 'private' : 'hidden';
};

const expectContract = (listing, visibility) => {
  if (visibility === 'hidden') {
    expect(listing).not.toHaveProperty('likes');
    expect(listing.likesHidden).toBe(true);
    expect(listing).not.toHaveProperty('likesPrivate');
  } else if (visibility === 'private') {
    expect(listing.likes).toBe(LIKES);
    expect(listing.likesPrivate).toBe(true);
    expect(listing).not.toHaveProperty('likesHidden');
  } else {
    expect(listing.likes).toBe(LIKES);
    expect(listing).not.toHaveProperty('likesHidden');
    expect(listing).not.toHaveProperty('likesPrivate');
  }
};

describe.each([...HIDING_STATES, ...OPEN_STATES])('an entry whose contest is %s', (state) => {
  it.each(Object.keys(PATHS))('follows the count contract for every reader on the %s read', async (path) => {
    const seeded = await seed(state);

    for (const reader of READERS) {
      const listing = await PATHS[path](seeded, seeded.readers[reader]);
      expect(listing, reader).toBeDefined();
      expectContract(listing, expected(state, reader));

      if (!CARRIES_LIKED.has(path)) {
        expect(listing).not.toHaveProperty('liked');
      } else if (reader === 'guest') {
        expect(listing).not.toHaveProperty('liked');
      } else {
        expect(listing.liked).toBe(reader === 'other');
      }
    }
  });
});

describe('publishing and updating an entry', () => {
  it('answers the author with the count, marked private', async () => {
    const author = createUser({ username: 'reedwright' });
    const event = Event.create({
      type: 'contest', title: 'Sedge Landing Contest', bannerText: 'Build.', body: 'Build.',
      startsAt: at(-60), endsAt: at(60)
    });

    const published = await publish(author, { name: 'Marsh Warden', kind: 'entity', contestEventId: event.id });
    expect(published.status).toBe(201);
    expect(published.body.data.likes).toBe(0);
    expect(published.body.data.likesPrivate).toBe(true);

    seedLikes(published.body.data.id, [createUser(), createUser()]);

    const updated = await update(author, published.body.data.id, { description: 'Reworded' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.likes).toBe(2);
    expect(updated.body.data.likesPrivate).toBe(true);
  });

  it('answers a listing outside any contest with the plain count', async () => {
    const author = createUser({ username: 'reedwright' });

    const published = await publish(author, { name: 'Sedge Landing' });
    expect(published.body.data.likes).toBe(0);
    expect(published.body.data).not.toHaveProperty('likesPrivate');
    expect(published.body.data).not.toHaveProperty('likesHidden');
  });
});

describe('sorting the catalog by likes', () => {
  const seedRanking = async () => {
    const author = createUser({ username: 'reedwright' });
    const staff = createUser({ username: 'a-mod', accountType: 'mod' });
    const event = Event.create({
      type: 'contest', title: 'Sedge Landing Contest', bannerText: 'Build.', body: 'Build.',
      startsAt: at(-60), endsAt: at(60)
    });

    const entry = (await publish(author, { name: 'Entry', contestEventId: event.id })).body.data;
    const likers = Array.from({ length: 6 }, () => createUser());
    seedLikes(entry.id, likers);

    const other = createUser({ username: 'fenlark' });
    const two = (await publish(other, { name: 'Two' })).body.data;
    const one = (await publish(other, { name: 'One' })).body.data;
    await publish(other, { name: 'Zero A' });
    await publish(other, { name: 'Zero B' });
    seedLikes(two.id, likers.slice(0, 2));
    seedLikes(one.id, likers.slice(0, 1));

    return { entry, author, staff, event };
  };

  const order = async (user, direction = 'desc') => {
    const res = await as(request(app).get(`/api/worlds?sort=likes&order=${direction}&limit=100`), user);
    return res.body.data.map((row) => row.name);
  };

  it('ranks a hidden count with the zero-like listings for a public reader', async () => {
    await seedRanking();

    const desc = await order(null);
    expect(desc.slice(0, 2)).toEqual(['Two', 'One']);
    expect(desc.slice(2).sort()).toEqual(['Entry', 'Zero A', 'Zero B']);

    const asc = await order(createUser({ username: 'a-reader' }), 'asc');
    expect(asc.slice(0, 3).sort()).toEqual(['Entry', 'Zero A', 'Zero B']);
  });

  it('ranks by the real count for the author and staff, and for everyone once results are announced', async () => {
    const { author, staff, event } = await seedRanking();

    expect((await order(author))[0]).toBe('Entry');
    expect((await order(staff))[0]).toBe('Entry');

    Event.announceResults(event.id);
    expect((await order(null))[0]).toBe('Entry');
  });
});

describe('what the single listing tells a cache', () => {
  it('marks it private, always revalidated, and keyed by the credential and the Install', async () => {
    const author = createUser({ username: 'reedwright' });
    const listing = (await publish(author, { name: 'Sedge Landing' })).body.data;

    const res = await request(app).get(`/api/worlds/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toContain('Authorization');
    expect(res.headers.vary).toContain('X-Formamorph-Install');
  });

  it('marks both content reads private and keyed by the credential', async () => {
    const { entry, host } = await seed('live');

    for (const url of [`/api/worlds/${entry.id}/content`, `/api/worlds/${host.id}/dependencies/${entry.id}/content`]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('private, no-cache');
      expect(res.headers.vary, url).toContain('Authorization');
    }
  });
});
