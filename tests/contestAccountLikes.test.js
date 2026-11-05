import { describe, it, expect } from 'vitest';
import { app, request, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, seedLikes } from './helpers.js';

/**
 * The account likes a judge ranks contest entries by: staff read them on the catalog, nobody else gets
 * the field, and `likes` stays the sum of both kinds.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const rnd = () => Math.random().toString(36).slice(2, 8);

const contest = () => Event.create({
  type: 'contest',
  title: 'Sedge Landing Contest',
  bannerText: 'Build on Sedge Landing.',
  body: 'Build something on Sedge Landing.',
  startsAt: at(-60),
  endsAt: at(60)
});

const publish = async (author, body = {}) => {
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(body));
  expect(res.status).toBe(201);
  return res.body.data.id;
};

const anonymousLikes = (worldId, count) => {
  const insert = db.prepare(`
    INSERT INTO anonymous_likes (world_id, install_id, address_hash, browser_family, created_at)
    VALUES (?, ?, 'hash', 'firefox', ?)
  `);
  for (let i = 0; i < count; i += 1) insert.run(worldId, `install-${rnd()}`, at(-1));
};

const accountLikes = (worldId, count) => seedLikes(worldId, Array.from({ length: count }, () => createUser()));

const rowOf = async (user, id) => {
  const req = request(app).get('/api/worlds?limit=1000&kind=all');
  const res = await (user ? req.set(authHeader(user)) : req);
  return res.body.data.find((row) => row.id === id);
};

const staff = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });

const entered = async (accounts, anonymous, event = contest()) => {
  const author = createUser({ username: `author-${rnd()}` });
  const id = await publish(author, { contestEventId: event.id });
  accountLikes(id, accounts);
  anonymousLikes(id, anonymous);
  return { id, author };
};

describe('account likes on a contest entry', () => {
  it('gives staff the account count beside the summed count', async () => {
    const { id } = await entered(2, 5);

    const row = await rowOf(staff(), id);

    expect(row.account_likes).toBe(2);
    expect(row.likes).toBe(7);
  });

  it('counts an entry with only Anonymous Likes as zero, not as absent', async () => {
    const { id } = await entered(0, 3);

    const row = await rowOf(staff(), id);

    expect(row.account_likes).toBe(0);
    expect(row.likes).toBe(3);
  });

  it('keeps each entry to its own count', async () => {
    const event = contest();
    const first = await entered(1, 0, event);
    const second = await entered(4, 0, event);
    const reader = staff();

    expect((await rowOf(reader, first.id)).account_likes).toBe(1);
    expect((await rowOf(reader, second.id)).account_likes).toBe(4);
  });

  it.each([
    ['a guest', () => null],
    ['another player', () => createUser({ username: `player-${rnd()}` })]
  ])('sends %s no account count', async (_name, reader) => {
    const { id } = await entered(2, 5);

    expect(await rowOf(reader(), id)).not.toHaveProperty('account_likes');
  });

  it('sends the author no account count on their own entry', async () => {
    const { id, author } = await entered(2, 5);

    const row = await rowOf(author, id);

    expect(row.likes).toBe(7);
    expect(row).not.toHaveProperty('account_likes');
  });

  it('leaves a listing outside any contest without the field, even for staff', async () => {
    const id = await publish(createUser({ username: `author-${rnd()}` }));
    accountLikes(id, 2);

    expect(await rowOf(staff(), id)).not.toHaveProperty('account_likes');
  });
});
