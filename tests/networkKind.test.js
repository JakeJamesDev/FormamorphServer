import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload, fromAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const World = require('../src/models/World');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME } = require('../src/config/anonymousLikes');
const { NETWORK_KIND, NETWORK_LISTS } = require('../src/config/networkKind');
const { networkClassifier, createNetworkClassifier } = require('../src/utils/networkClassifier');
const { loadNetworkLists, refreshNetworkLists } = require('../src/utils/networkLists');
const { addressHash } = require('../src/utils/recordSignal');
const { sweepRetention } = require('../src/utils/sweepRetention');
const { DAY_MS } = require('../src/config/time');

/**
 * Network Kind: what kind of network each like came from, for staff.
 *
 * The lists are fixtures built from documentation ranges, loaded into the classifier the routes read.
 * They overlap on purpose, the way the real data-center list holds the VPN ranges.
 */

const LISTS = {
  tor: '192.0.2.10\n',
  'vpn-ipv4': '# a comment\n192.0.2.0/25\n198.51.100.0/26\n',
  'vpn-ipv6': '2001:db8:1::/48\n',
  'hosting-ipv4': '198.51.100.0/24\n',
  'hosting-ipv6': '2001:db8::/32\n'
};

const TOR = '192.0.2.10';
const VPN = '192.0.2.20';
const HOSTING = '198.51.100.200';
const UNLISTED = '203.0.113.9';

const urlFor = (name) => NETWORK_LISTS.find((list) => list.name === name).url;
const nameFor = (url) => NETWORK_LISTS.find((list) => list.url === url).name;

beforeAll(() => {
  for (const [name, text] of Object.entries(LISTS)) networkClassifier.load(name, text);
});

afterEach(() => { vi.restoreAllMocks(); });

const rnd = () => Math.random().toString(36).slice(2, 8);
const install = () => crypto.randomUUID();

const collect = () => Setting.set(NETWORK_KIND, true);
const enableAnonymous = () => Setting.set(ANONYMOUS_LIKES, true);

const seed = async () => {
  const author = createUser({ username: `author-${rnd()}` });
  const reader = createUser({ username: `reader-${rnd()}` });
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload({ name: 'Sedge Landing' }));

  return { author, reader, id: res.body.data.id };
};

const accountLike = (user, id, address, liked = true) =>
  fromAddress(address, request(app).put(`/api/worlds/${id}/like`).set(authHeader(user))).send({ liked });

const anonLike = (id, installId, address, liked = true) =>
  fromAddress(address, request(app).put(`/api/worlds/${id}/anonymous-like`).set(INSTALL_HEADER_NAME, installId))
    .send({ liked });

const accountKind = (worldId, userId) =>
  db.prepare('SELECT network_kind FROM world_likes WHERE world_id = ? AND user_id = ?').get(worldId, userId)?.network_kind;

const mark = (worldId, installId) =>
  db.prepare('SELECT * FROM anonymous_likes WHERE world_id = ? AND install_id = ?').get(worldId, installId);

describe('storing the kind beside a like', () => {
  it.each([[TOR, 'tor'], [VPN, 'vpn'], [HOSTING, 'hosting']])(
    'stores the kind of an account like from %s', async (address, kind) => {
      collect();
      const { reader, id } = await seed();

      const res = await accountLike(reader, id, address);

      expect(res.status).toBe(200);
      expect(accountKind(id, reader.id)).toBe(kind);
    }
  );

  it.each([[TOR, 'tor'], [VPN, 'vpn'], [HOSTING, 'hosting']])(
    'stores the kind of an Anonymous Like from %s', async (address, kind) => {
      collect();
      enableAnonymous();
      const { id } = await seed();
      const me = install();

      const res = await anonLike(id, me, address);

      expect(res.status).toBe(200);
      expect(mark(id, me).network_kind).toBe(kind);
    }
  );

  it.each([
    // On the Tor list and inside a VPN range.
    [TOR, 'tor'],
    // Inside a VPN range and the hosting range around it.
    ['198.51.100.5', 'vpn'],
    ['2001:db8:1::5', 'vpn'],
    ['2001:db8:2::5', 'hosting']
  ])('stores the higher kind for %s, which is on two lists', async (address, kind) => {
    collect();
    const { reader, id } = await seed();

    await accountLike(reader, id, address);

    expect(accountKind(id, reader.id)).toBe(kind);
  });

  it('stores none for an address on no list', async () => {
    collect();
    enableAnonymous();
    const { reader, id } = await seed();
    const me = install();

    await accountLike(reader, id, UNLISTED);
    await anonLike(id, me, UNLISTED);

    expect(accountKind(id, reader.id)).toBeNull();
    expect(mark(id, me).network_kind).toBeNull();
  });

  it('stores none while collection is off', async () => {
    enableAnonymous();
    const { reader, id } = await seed();
    const me = install();

    await accountLike(reader, id, TOR);
    await anonLike(id, me, TOR);

    expect(accountKind(id, reader.id)).toBeNull();
    expect(mark(id, me).network_kind).toBeNull();
  });

  it('keeps the kind of the first press when the same account presses again from elsewhere', async () => {
    collect();
    const { reader, id } = await seed();

    await accountLike(reader, id, VPN);
    await accountLike(reader, id, UNLISTED);

    expect(accountKind(id, reader.id)).toBe('vpn');
  });
});

describe('the address the kind is read from', () => {
  it('ignores a forwarded header the proxy did not set', async () => {
    // Caddy sets X-Forwarded-For; anything else a client sends is its own claim.
    collect();
    const { reader, id } = await seed();

    await fromAddress(UNLISTED, request(app).put(`/api/worlds/${id}/like`).set(authHeader(reader)))
      .set('CF-Connecting-IP', TOR)
      .set('X-Real-IP', TOR)
      .send({ liked: true });

    expect(accountKind(id, reader.id)).toBeNull();
  });

  it('reads the hop the proxy saw, not one the client put ahead of it', async () => {
    collect();
    const { reader, id } = await seed();

    await accountLike(reader, id, `${TOR}, ${UNLISTED}`);

    expect(accountKind(id, reader.id)).toBeNull();
  });

  it('classifies the same address the hash is taken from', async () => {
    collect();
    enableAnonymous();
    const { id } = await seed();
    const me = install();

    await anonLike(id, me, TOR);

    expect(mark(id, me)).toMatchObject({ address_hash: addressHash(TOR), network_kind: 'tor' });
  });
});

describe('claiming an Anonymous Like', () => {
  it('carries the kind onto the account like', async () => {
    collect();
    enableAnonymous();
    const { reader, id } = await seed();
    const me = install();
    await anonLike(id, me, VPN);

    const res = await request(app).post('/api/users/me/anonymous-likes/claim')
      .set(authHeader(reader)).set(INSTALL_HEADER_NAME, me).send();

    expect(res.status).toBe(200);
    expect(accountKind(id, reader.id)).toBe('vpn');
  });
});

describe('letting go of the kind after ninety days', () => {
  const NOW = '2026-11-03T12:00:00.000Z';

  const age = (table, worldId, days) => db.prepare(`UPDATE ${table} SET created_at = ? WHERE world_id = ?`)
    .run(new Date(new Date(NOW).getTime() - days * DAY_MS).toISOString(), worldId);

  const seedBoth = async () => {
    collect();
    enableAnonymous();
    const { reader, id } = await seed();
    const me = install();
    await accountLike(reader, id, HOSTING);
    await anonLike(id, me, VPN);

    return { reader, id, me };
  };

  it('blanks hash, browser family and kind at ninety days and keeps both likes', async () => {
    const { reader, id, me } = await seedBoth();
    age('world_likes', id, 91);
    age('anonymous_likes', id, 91);

    const swept = sweepRetention(NOW);

    expect(swept).toMatchObject({ marks: 1, kinds: 1 });
    expect(mark(id, me)).toMatchObject({ address_hash: '', browser_family: '', network_kind: null });
    expect(accountKind(id, reader.id)).toBeNull();
    expect(World.likeCount(id)).toBe(2);
  });

  it('keeps all three on a younger like', async () => {
    const { reader, id, me } = await seedBoth();
    age('world_likes', id, 89);
    age('anonymous_likes', id, 89);

    const swept = sweepRetention(NOW);

    expect(swept).toMatchObject({ marks: 0, kinds: 0 });
    expect(mark(id, me)).toMatchObject({ address_hash: addressHash(VPN), network_kind: 'vpn' });
    expect(mark(id, me).browser_family).not.toBe('');
    expect(accountKind(id, reader.id)).toBe('hosting');
  });

  it('catches up a mark whose hash an earlier sweep blanked alone', async () => {
    // A mark can reach the sweep with its hash empty and its family and kind still set.
    const { id, me } = await seedBoth();
    age('anonymous_likes', id, 91);
    db.prepare("UPDATE anonymous_likes SET address_hash = '' WHERE world_id = ?").run(id);

    const swept = sweepRetention(NOW);

    expect(swept.marks).toBe(1);
    expect(mark(id, me)).toMatchObject({ browser_family: '', network_kind: null });
  });

  it('blanks the account kinds even when the anonymous step throws', async () => {
    const { reader, id } = await seedBoth();
    age('world_likes', id, 91);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(require('../src/models/AnonymousLike'), 'blankOriginsBefore')
      .mockImplementation(() => { throw new Error('the table is locked'); });

    const swept = sweepRetention(NOW);

    expect(swept.kinds).toBe(1);
    expect(accountKind(id, reader.id)).toBeNull();
  });
});

describe('the classifier', () => {
  it('refuses a list with a line that is not an address, and keeps the copy before it', () => {
    const classifier = createNetworkClassifier();
    classifier.load('tor', LISTS.tor);

    expect(() => classifier.load('tor', '192.0.2.99\n<html>Not Found</html>\n')).toThrow(/Not an address/);
    expect(classifier.classify(TOR)).toBe('tor');
    expect(classifier.classify('192.0.2.99')).toBeNull();
  });

  it.each([
    ['an empty list', '\n# nothing\n'],
    ['a prefix out of range', '192.0.2.0/33\n'],
    ['a second slash', '192.0.2.0/24/8\n']
  ])('refuses %s', (_, text) => {
    expect(() => createNetworkClassifier().load('tor', text)).toThrow();
  });

  it('classifies everything as none before a list is loaded', () => {
    const classifier = createNetworkClassifier();

    expect(classifier.classify(TOR)).toBeNull();
    expect(classifier.loadedAt()).toEqual({});
  });

  it('reads an IPv4 address a dual-stack socket reports as IPv6', () => {
    expect(networkClassifier.classify(`::ffff:${TOR}`)).toBe('tor');
  });
});

describe('refreshing the lists', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fms-lists-'));
  const serve = (lists) => async (url) => {
    const text = lists[nameFor(url)];
    if (text instanceof Error) throw text;
    return text;
  };

  it('saves each list that parses and loads it back on the next start', async () => {
    const dir = scratch();

    const result = await refreshNetworkLists({ classifier: createNetworkClassifier(), dir, fetchList: serve(LISTS) });
    const restarted = createNetworkClassifier();
    const loaded = loadNetworkLists({ classifier: restarted, dir });

    expect(result).toEqual({ loaded: NETWORK_LISTS.map((list) => list.name), refused: [] });
    expect(loaded).toHaveLength(NETWORK_LISTS.length);
    expect(restarted.classify(HOSTING)).toBe('hosting');
  });

  it.each([
    ['a failed download', new Error('HTTP 503')],
    ['an invalid download', '192.0.2.99\n<html>Not Found</html>\n']
  ])('keeps the previous copy on disk and in memory after %s, and says so', async (_, broken) => {
    const dir = scratch();
    const classifier = createNetworkClassifier();
    await refreshNetworkLists({ classifier, dir, fetchList: serve(LISTS) });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await refreshNetworkLists({ classifier, dir, fetchList: serve({ ...LISTS, tor: broken }) });

    expect(result.refused).toEqual(['tor']);
    expect(classifier.classify(TOR)).toBe('tor');
    expect(fs.readFileSync(path.join(dir, 'tor.txt'), 'utf8')).toBe(LISTS.tor);
    expect(logged.mock.calls.some(([line]) => line.includes('tor was refused'))).toBe(true);
  });

  it('skips a copy on disk that does not parse', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'tor.txt'), 'not a list\n');
    fs.writeFileSync(path.join(dir, 'vpn-ipv4.txt'), LISTS['vpn-ipv4']);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const classifier = createNetworkClassifier();

    expect(loadNetworkLists({ classifier, dir })).toEqual(['vpn-ipv4']);
    expect(classifier.classify(TOR)).toBe('vpn');
  });

  it('asks for each list at its own address', async () => {
    const asked = [];
    await refreshNetworkLists({
      classifier: createNetworkClassifier(),
      dir: scratch(),
      fetchList: async (url) => { asked.push(url); return LISTS[nameFor(url)]; }
    });

    expect([...asked].sort()).toEqual(Object.keys(LISTS).map(urlFor).sort());
  });
});
