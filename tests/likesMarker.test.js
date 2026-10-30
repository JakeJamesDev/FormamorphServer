import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload, fromAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const { MINUTE_MS, DAY_MS } = require('../src/config/time');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME } = require('../src/config/anonymousLikes');
const { NETWORK_KIND } = require('../src/config/networkKind');
const { MIN_FLAGGED, FLAGGED_SHARE, BURST_SIZE, BURST_WINDOW_MINUTES } = require('../src/config/likesMarker');
const { networkClassifier } = require('../src/utils/networkClassifier');

/**
 * The likes audit's summary: the flagged share and the Bursts behind the staff-only Likes Marker.
 *
 * Every like here is a real one, given through the like routes from a fixture address. Only its instant
 * moves afterwards, because fifteen minutes and ninety days cannot be waited for.
 */

const LISTS = {
  tor: '192.0.2.10\n',
  'vpn-ipv4': '192.0.2.0/25\n',
  'vpn-ipv6': '2001:db8:1::/48\n',
  'hosting-ipv4': '198.51.100.0/24\n',
  'hosting-ipv6': '2001:db8::/32\n'
};

/** A different listed address per call, skipping the Tor exit. */
let vpnHost = 20;
const vpnAddress = () => `192.0.2.${(vpnHost = vpnHost >= 126 ? 20 : vpnHost + 1)}`;

let plainHost = 0;
const plainAddress = () => `203.0.113.${(plainHost = (plainHost % 250) + 1)}`;

beforeAll(() => {
  for (const [name, text] of Object.entries(LISTS)) networkClassifier.load(name, text);
});

// `setup.js` empties the settings after every test, thresholds included.
beforeEach(() => {
  Setting.set(NETWORK_KIND, true);
  Setting.set(ANONYMOUS_LIKES, true);
});

const rnd = () => Math.random().toString(36).slice(2, 8);
const mod = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });

const seed = async () => {
  const author = createUser({ username: `author-${rnd()}` });
  const res = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload({ name: 'Sedge Landing' }));

  return res.body.data.id;
};

/** The instant `minutes` after a fixed point a day ago, well inside retention. */
const base = Date.now() - DAY_MS;
const at = (minutes) => new Date(base + minutes * MINUTE_MS).toISOString();

/** An account like from `address`, moved to `when`. */
const accountLike = async (id, address, when) => {
  const liker = createUser({ username: `liker-${rnd()}` });
  const res = await fromAddress(address, request(app).put(`/api/worlds/${id}/like`).set(authHeader(liker)))
    .send({ liked: true });
  expect(res.status).toBe(200);
  db.prepare('UPDATE world_likes SET created_at = ? WHERE world_id = ? AND user_id = ?').run(when, id, liker.id);
};

/** An Anonymous Like from a fresh Install at `address`, moved to `when`. */
const anonymousLike = async (id, address, when) => {
  const installId = crypto.randomUUID();
  const res = await fromAddress(address, request(app).put(`/api/worlds/${id}/anonymous-like`)
    .set(INSTALL_HEADER_NAME, installId)).send({ liked: true });
  expect(res.status).toBe(200);
  db.prepare('UPDATE anonymous_likes SET created_at = ? WHERE world_id = ? AND install_id = ?').run(when, id, installId);

  return installId;
};

/** `count` account likes from unlisted addresses, `gap` minutes apart from `start`. */
const spread = async (id, count, gap, start = 0) => {
  for (let i = 0; i < count; i += 1) await accountLike(id, plainAddress(), at(start + i * gap));
};

const audit = async (id) => {
  const res = await request(app).get(`/api/worlds/${id}/likes/audit`).set(authHeader(mod()));
  expect(res.status).toBe(200);

  return res.body.data;
};

const summaryOf = async (id) => (await audit(id)).summary;

describe('the Network Kind on each audit row', () => {
  it('carries the kind on a flagged row and null on a plain one, account and anonymous', async () => {
    const id = await seed();
    await accountLike(id, vpnAddress(), at(0));
    await accountLike(id, plainAddress(), at(1));
    await anonymousLike(id, '198.51.100.9', at(2));
    await anonymousLike(id, plainAddress(), at(3));

    const data = await audit(id);

    expect(data.rows.map((row) => row.networkKind)).toEqual([null, 'vpn']);
    expect(data.anonymousRows.map((row) => row.networkKind)).toEqual([null, 'hosting']);
  });
});

describe('what the summary reports', () => {
  it('reports the flagged count, the window total, the share, the Bursts and the reasons', async () => {
    const id = await seed();
    for (let i = 0; i < 5; i += 1) await accountLike(id, vpnAddress(), at(i * 30));
    for (let i = 0; i < 5; i += 1) await accountLike(id, plainAddress(), at(300 + i * 30));

    expect(await summaryOf(id)).toEqual({
      windowDays: 90, flagged: 5, total: 10, share: 0.5, bursts: [], reasons: ['flagged_share']
    });
  });

  it('reports a null share and no reasons for a listing with no recent likes', async () => {
    const id = await seed();

    expect(await summaryOf(id)).toEqual({ windowDays: 90, flagged: 0, total: 0, share: null, bursts: [], reasons: [] });
  });

  it('lists both reasons, Burst first, when both fire', async () => {
    const id = await seed();
    for (let i = 0; i < 8; i += 1) await accountLike(id, vpnAddress(), at(i));

    expect((await summaryOf(id)).reasons).toEqual(['burst', 'flagged_share']);
  });

  it('still carries no hash and no Install id anywhere in the response', async () => {
    const id = await seed();
    const installId = await anonymousLike(id, vpnAddress(), at(0));
    const { address_hash: hash } = db.prepare('SELECT address_hash FROM anonymous_likes WHERE install_id = ?').get(installId);

    const body = JSON.stringify(await audit(id));

    expect(hash).not.toBe('');
    expect(body).not.toContain(hash);
    expect(body).not.toContain(installId);
  });
});

describe('finding a Burst', () => {
  it('finds 8 different likers inside 15 minutes, starting at the first', async () => {
    const id = await seed();
    await spread(id, 8, 2);

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 8 }]);
  });

  it('finds no Burst in 7 likers inside 15 minutes', async () => {
    const id = await seed();
    await spread(id, 7, 2);

    const summary = await summaryOf(id);
    expect(summary.bursts).toEqual([]);
    expect(summary.reasons).toEqual([]);
  });

  it('finds no Burst in 8 likers spread past 15 minutes', async () => {
    const id = await seed();
    // 7 gaps of 2:10 span 15:10, so no window holds all eight.
    await spread(id, 8, 13 / 6);

    expect((await summaryOf(id)).bursts).toEqual([]);
  });

  it('counts a last like at exactly 15:00 inside the window', async () => {
    const id = await seed();
    await spread(id, 7, 2);
    await accountLike(id, plainAddress(), at(15));

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 8 }]);
  });

  it('merges overlapping windows into one Burst and keeps separate runs apart', async () => {
    const id = await seed();
    await spread(id, 20, 1);
    await spread(id, 8, 1, 120);

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 20 }, { startedAt: at(120), size: 8 }]);
  });
});

describe('who counts as a different liker', () => {
  it('counts three Anonymous Likes from one address as one liker', async () => {
    const id = await seed();
    await spread(id, 7, 1);
    const household = plainAddress();
    for (let i = 0; i < 3; i += 1) await anonymousLike(id, household, at(8 + i));

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 8 }]);
  });

  it('finds no Burst when the only eighth liker is one address behind three marks', async () => {
    const id = await seed();
    await spread(id, 6, 1);
    const household = plainAddress();
    for (let i = 0; i < 3; i += 1) await anonymousLike(id, household, at(7 + i));

    expect((await summaryOf(id)).bursts).toEqual([]);
  });

  it('never counts a mark whose hash is blank', async () => {
    const id = await seed();
    await spread(id, 7, 1);
    const installId = await anonymousLike(id, plainAddress(), at(8));
    db.prepare("UPDATE anonymous_likes SET address_hash = '' WHERE install_id = ?").run(installId);

    const summary = await summaryOf(id);
    expect(summary.bursts).toEqual([]);
    expect(summary.total).toBe(8);
  });
});

describe('the flagged-share reason', () => {
  const flaggedOf = async (flagged, plain) => {
    const id = await seed();
    for (let i = 0; i < flagged; i += 1) await accountLike(id, vpnAddress(), at(i * 30));
    for (let i = 0; i < plain; i += 1) await anonymousLike(id, plainAddress(), at(600 + i * 30));

    return summaryOf(id);
  };

  it('fires on 5 flagged of 10', async () => {
    expect((await flaggedOf(5, 5)).reasons).toEqual(['flagged_share']);
  });

  it('does not fire on 4 flagged of 4', async () => {
    const summary = await flaggedOf(4, 0);
    expect(summary.share).toBe(1);
    expect(summary.reasons).toEqual([]);
  });

  it('does not fire on 5 flagged of 11', async () => {
    expect((await flaggedOf(5, 6)).reasons).toEqual([]);
  });

  it('counts a flagged Anonymous Like as well as a flagged account like', async () => {
    const id = await seed();
    for (let i = 0; i < 5; i += 1) await anonymousLike(id, vpnAddress(), at(i * 30));

    expect(await summaryOf(id)).toMatchObject({ flagged: 5, total: 5, reasons: ['flagged_share'] });
  });
});

describe('the ninety-day window', () => {
  const old = (minutes) => new Date(Date.now() - 91 * DAY_MS + minutes * MINUTE_MS).toISOString();

  it('counts likes older than 90 days toward neither reason', async () => {
    const id = await seed();
    for (let i = 0; i < 8; i += 1) await accountLike(id, vpnAddress(), old(i));
    await accountLike(id, plainAddress(), at(0));

    expect(await summaryOf(id)).toEqual({
      windowDays: 90, flagged: 0, total: 1, share: 0, bursts: [], reasons: []
    });
  });
});

describe('the threshold settings', () => {
  const put = (key, value) =>
    request(app).put(`/api/settings/${key}`).set(authHeader(mod())).send({ value });

  it('applies a changed Burst size on the next read', async () => {
    const id = await seed();
    await spread(id, 7, 1);
    expect((await summaryOf(id)).bursts).toEqual([]);

    expect((await put(BURST_SIZE, 7)).status).toBe(200);

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 7 }]);
  });

  it('applies a changed Burst window on the next read', async () => {
    const id = await seed();
    await spread(id, 8, 3);
    expect((await summaryOf(id)).bursts).toEqual([]);

    expect((await put(BURST_WINDOW_MINUTES, 21)).status).toBe(200);

    expect((await summaryOf(id)).bursts).toEqual([{ startedAt: at(0), size: 8 }]);
  });

  it('applies a changed minimum and share on the next read', async () => {
    const id = await seed();
    for (let i = 0; i < 4; i += 1) await accountLike(id, vpnAddress(), at(i * 30));
    for (let i = 0; i < 5; i += 1) await accountLike(id, plainAddress(), at(600 + i * 30));
    expect((await summaryOf(id)).reasons).toEqual([]);

    expect((await put(MIN_FLAGGED, 4)).status).toBe(200);
    expect((await summaryOf(id)).reasons).toEqual([]);

    expect((await put(FLAGGED_SHARE, 0.4)).status).toBe(200);
    expect((await summaryOf(id)).reasons).toEqual(['flagged_share']);
  });

  it('reads each default before anyone writes one', async () => {
    const moderator = mod();
    const read = async (key) => (await request(app).get(`/api/settings/${key}`).set(authHeader(moderator))).body.data;

    expect(await read(MIN_FLAGGED)).toBe(5);
    expect(await read(FLAGGED_SHARE)).toBe(0.5);
    expect(await read(BURST_SIZE)).toBe(8);
    expect(await read(BURST_WINDOW_MINUTES)).toBe(15);
  });

  it.each([
    [MIN_FLAGGED, [0, 2.5, '5', null]],
    [FLAGGED_SHARE, [0, 1.5, -0.1, '0.5']],
    [BURST_SIZE, [1, 7.5, '8']],
    [BURST_WINDOW_MINUTES, [0, 1441, 2.5, '15']]
  ])('refuses a bad value for %s and keeps the old one', async (key, values) => {
    const before = Setting.get(key);
    for (const value of values) expect((await put(key, value)).status).toBe(400);
    expect(Setting.get(key)).toBe(before);
  });

  it.each([[MIN_FLAGGED, 1], [FLAGGED_SHARE, 1], [BURST_SIZE, 2], [BURST_WINDOW_MINUTES, 1440]])(
    'takes the edge value for %s', async (key, value) => {
      expect((await put(key, value)).status).toBe(200);
    }
  );
});
