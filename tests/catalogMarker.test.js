import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, Event } from './context.js';
import { createUser, authHeader, worldPayload, fromAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const { NETWORK_KIND } = require('../src/config/networkKind');
const { networkClassifier } = require('../src/utils/networkClassifier');

/**
 * The Likes Marker on the catalog and on a listing read on its own: staff get the reasons, nobody else
 * gets the field, and a contest entry keeps its count from the room while staff still see its marker.
 *
 * Every like is a real one, given through the like route from a fixture VPN address.
 */

beforeAll(() => {
  networkClassifier.load('vpn-ipv4', '192.0.2.0/24\n');
});

beforeEach(() => {
  Setting.set(NETWORK_KIND, true);
});

const rnd = () => Math.random().toString(36).slice(2, 8);
const mod = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });
const player = () => createUser({ username: `player-${rnd()}` });

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const publish = async (body = {}) => {
  const author = createUser({ username: `author-${rnd()}` });
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(body));
  expect(res.status).toBe(201);

  return res.body.data.id;
};

let host = 0;
const vpnAddress = () => `192.0.2.${(host = (host % 250) + 1)}`;
const plainAddress = () => `203.0.113.${(host = (host % 250) + 1)}`;

/** `count` account likes, each from a new player at the address `addressOf` hands out. */
const likeFrom = async (id, count, addressOf) => {
  for (let i = 0; i < count; i += 1) {
    const res = await fromAddress(addressOf(), request(app).put(`/api/worlds/${id}/like`)
      .set(authHeader(player()))).send({ liked: true });
    expect(res.status).toBe(200);
  }
};

/** Five likes from VPN addresses: enough to fire the flagged-share reason on their own. */
const flagFive = (id) => likeFrom(id, 5, vpnAddress);

const as = (req, user) => (user ? req.set(authHeader(user)) : req);

const catalog = (user) => as(request(app).get('/api/worlds?limit=1000&kind=all'), user);
const listing = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);

const rowOf = (res, id) => res.body.data.find((world) => world.id === id);

/** One marked listing and one plain one. */
const seed = async () => {
  const marked = await publish({ name: 'Sedge Landing' });
  const plain = await publish({ name: 'The Long Tally' });
  await flagFive(marked);

  return { marked, plain };
};

describe('the marker on catalog rows', () => {
  it.each(['mod', 'dev', 'admin'])('gives a %s the reasons on a marked row and an empty list on a plain one', async (role) => {
    const { marked, plain } = await seed();

    const res = await catalog(createUser({ username: `${role}-${rnd()}`, accountType: role }));

    expect(rowOf(res, marked).likes_marker).toEqual(['flagged_share']);
    expect(rowOf(res, plain).likes_marker).toEqual([]);
  });

  it('names a Burst when eight plain likers arrive inside the window', async () => {
    const id = await publish({ name: 'Sedge Landing' });
    await likeFrom(id, 8, plainAddress);

    expect(rowOf(await catalog(mod()), id).likes_marker).toEqual(['burst']);
  });

  it.each([['a guest', () => null], ['a player', player]])('never gives %s the field', async (_, reader) => {
    const { marked, plain } = await seed();

    const res = await catalog(reader());

    expect(rowOf(res, marked)).toBeDefined();
    expect(rowOf(res, marked)).not.toHaveProperty('likes_marker');
    expect(rowOf(res, plain)).not.toHaveProperty('likes_marker');
  });
});

describe('the marker on a listing read on its own', () => {
  it('gives staff the reasons', async () => {
    const { marked, plain } = await seed();
    const staff = mod();

    expect((await listing(marked, staff)).body.data.likes_marker).toEqual(['flagged_share']);
    expect((await listing(plain, staff)).body.data.likes_marker).toEqual([]);
  });

  it.each([['a guest', () => null], ['a player', player]])('never gives %s the field', async (_, reader) => {
    const { marked } = await seed();

    const res = await listing(marked, reader());

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('likes_marker');
  });
});

describe('a contest entry before its results', () => {
  const enter = async () => {
    const event = Event.create({
      type: 'contest',
      title: 'Sedge Landing Contest',
      bannerText: 'Build on Sedge Landing.',
      body: 'Build something on Sedge Landing.',
      startsAt: at(-60),
      endsAt: at(60)
    });
    const id = await publish({ name: 'Marsh Warden', contestEventId: event.id });
    await flagFive(id);

    return id;
  };

  it('shows staff the marker beside the private count', async () => {
    const id = await enter();
    const staff = mod();

    for (const data of [rowOf(await catalog(staff), id), (await listing(id, staff)).body.data]) {
      expect(data.likes_marker).toEqual(['flagged_share']);
      expect(data.likes).toBe(5);
      expect(data.likesPrivate).toBe(true);
    }
  });

  it.each([['a guest', () => null], ['a player', player]])('keeps both the count and the marker from %s', async (_, reader) => {
    const id = await enter();
    const user = reader();

    for (const data of [rowOf(await catalog(user), id), (await listing(id, user)).body.data]) {
      expect(data.likesHidden).toBe(true);
      expect(data).not.toHaveProperty('likes');
      expect(data).not.toHaveProperty('likes_marker');
    }
  });
});

describe('caching a response that carries the marker', () => {
  it('marks the catalog and a single listing as one reader’s, keyed by the credential', async () => {
    const { marked } = await seed();
    const staff = mod();

    const fromCatalog = await catalog(staff);
    const fromListing = await listing(marked, staff);
    expect(rowOf(fromCatalog, marked).likes_marker).toEqual(['flagged_share']);
    expect(fromListing.body.data.likes_marker).toEqual(['flagged_share']);

    for (const res of [fromCatalog, fromListing]) {
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers.vary).toMatch(/Authorization/);
    }
  });
});
