import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { app, request } from './context.js';

const require = createRequire(import.meta.url);
const { setPatreonClient, resetPatreonClient, httpClient } = require('../src/utils/patreon');
const { reconcilePatreon } = require('../src/utils/reconcilePatreon');
const Setting = require('../src/models/Setting');
const { PATREON_TIER_NAMES, PATREON_TIER_PRICES } =require('../src/config/settings');

/**
 * The Patreon title of each tier, stored by tier key and served on a public route.
 *
 * The Patreon client is a fake. `titleCalls` counts reads, so a request that reaches Patreon shows up.
 */

let titles;
let tierPrices;
let titlesFail;
let titleCalls;

beforeEach(() => {
  titles = {};
  tierPrices = {};
  titlesFail = false;
  titleCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Setting.set(PATREON_TIER_NAMES, { supporter: null, supporter_plus: null, supporter_top: null });
  setPatreonClient({
    identify: async () => { throw new Error('not used'); },
    members: async () => [],
    tierTitles: async () => {
      titleCalls += 1;
      if (titlesFail) throw new Error('Patreon is down');
      return { via: 'campaign', titles, prices: tierPrices };
    }
  });
  Setting.set(PATREON_TIER_PRICES, { supporter: null, supporter_plus: null, supporter_top: null });
});

afterEach(() => {
  resetPatreonClient();
  vi.restoreAllMocks();
});

const reply = async () => {
  const res = await request(app).get('/api/patreon/tier-names');
  expect(res.status).toBe(200);
  return res.body.data;
};

// The titles as a client that reads only the title keys sees them.
const names = async () => {
  const { supporter, supporter_plus, supporter_top } = await reply();
  return { supporter, supporter_plus, supporter_top };
};

const prices = async () => (await reply()).prices;

describe('the prices', () => {
  const ALL_NULL = { supporter: null, supporter_plus: null, supporter_top: null };

  it('are null before any price is known', async () => {
    expect(await prices()).toEqual(ALL_NULL);
  });

  it('serve the stored cents beside the titles', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    tierPrices = { 'tier-5': 500, 'tier-10': 1000 };
    await reconcilePatreon();

    expect(await reply()).toEqual({
      supporter: 'Friend', supporter_plus: 'Patron', supporter_top: null,
      prices: { supporter: 500, supporter_plus: 1000, supporter_top: null }
    });
  });

  it('keep the title keys as plain strings for a client that reads only titles', async () => {
    titles = { 'tier-5': 'Friend' };
    tierPrices = { 'tier-5': 500 };
    await reconcilePatreon();

    expect((await reply()).supporter).toBe('Friend');
  });

  it('ignore an unmapped tier, a non-integer amount and a negative amount', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron', 'tier-top': 'Champion' };
    tierPrices = { 'tier-other': 700, 'tier-5': '500', 'tier-10': -1, 'tier-top': 2500 };
    await reconcilePatreon();

    expect(await prices()).toEqual({ supporter: null, supporter_plus: null, supporter_top: 2500 });
  });

  it('keep the old prices when Patreon fails', async () => {
    titles = { 'tier-5': 'Friend' };
    tierPrices = { 'tier-5': 500 };
    await reconcilePatreon();
    titlesFail = true;

    await reconcilePatreon();

    expect(await prices()).toEqual({ supporter: 500, supporter_plus: null, supporter_top: null });
  });

  it('drop the price of a tier a full answer no longer lists', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    tierPrices = { 'tier-5': 500, 'tier-10': 1000 };
    await reconcilePatreon();
    titles = { 'tier-5': 'Friend' };
    tierPrices = { 'tier-5': 600 };
    await reconcilePatreon();

    expect(await prices()).toEqual({ supporter: 600, supporter_plus: null, supporter_top: null });
  });

  it('keep the prices of tiers the members fallback does not list', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    tierPrices = { 'tier-5': 500, 'tier-10': 1000 };
    await reconcilePatreon();
    setPatreonClient({
      members: async () => [],
      tierTitles: async () => ({ via: 'members', titles: { 'tier-5': 'Friend' }, prices: { 'tier-5': 600 } })
    });

    await reconcilePatreon();

    expect(await prices()).toEqual({ supporter: 600, supporter_plus: 1000, supporter_top: null });
  });

  it('are made without a Patreon call on a request', async () => {
    titles = { 'tier-5': 'Friend' };
    tierPrices = { 'tier-5': 500 };
    await reconcilePatreon();
    titleCalls = 0;

    await prices();

    expect(titleCalls).toBe(0);
  });
});

describe('the route', () => {
  it('is empty before any title is known', async () => {
    expect(await names()).toEqual({ supporter: null, supporter_plus: null, supporter_top: null });
  });

  it('serves the stored titles by tier key', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron', 'tier-top': 'Champion' };
    await reconcilePatreon();

    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: 'Patron', supporter_top: 'Champion' });
  });

  it('makes no Patreon call on a request', async () => {
    titles = { 'tier-5': 'Friend' };
    await reconcilePatreon();
    titleCalls = 0;

    await names();
    await names();

    expect(titleCalls).toBe(0);
  });
});

describe('the refresh', () => {
  it('ignores a tier ID this server does not map', async () => {
    titles = { 'tier-5': 'Friend', 'tier-other': 'Stranger' };
    await reconcilePatreon();

    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: null, supporter_top: null });
  });

  it('stores an empty or blank title as null', async () => {
    titles = { 'tier-5': '   ', 'tier-10': '', 'tier-top': ' Champion ' };
    await reconcilePatreon();

    expect(await names()).toEqual({ supporter: null, supporter_plus: null, supporter_top: 'Champion' });
  });

  it('drops the name of a tier a full answer no longer lists', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    await reconcilePatreon();
    titles = { 'tier-5': 'Friend' };
    await reconcilePatreon();

    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: null, supporter_top: null });
  });

  it('keeps the names of tiers the members fallback does not list', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    await reconcilePatreon();
    setPatreonClient({
      members: async () => [],
      tierTitles: async () => ({ via: 'members', titles: { 'tier-5': 'Friend Renamed' } })
    });

    await reconcilePatreon();

    expect(await names()).toEqual({ supporter: 'Friend Renamed', supporter_plus: 'Patron', supporter_top: null });
  });

  it('keeps the old names when Patreon fails', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    await reconcilePatreon();
    titlesFail = true;

    await reconcilePatreon();

    expect(titleCalls).toBe(2);
    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: 'Patron', supporter_top: null });
  });
});

describe('the webhook', () => {
  const deliver = (body) => request(app)
    .post('/api/patreon/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Patreon-Event', 'members:update')
    .set('X-Patreon-Signature', crypto.createHmac('md5', 'test-webhook-secret').update(body).digest('hex'))
    .send(body);

  const payload = (included) => JSON.stringify({
    data: {
      id: 'member-p1',
      type: 'member',
      attributes: { pledge_relationship_start: null },
      relationships: { user: { data: { id: 'p1', type: 'user' } }, currently_entitled_tiers: { data: [] } }
    },
    included
  });

  it('updates the price of only the tiers it carries', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    tierPrices = { 'tier-5': 500, 'tier-10': 1000 };
    await reconcilePatreon();

    await deliver(payload([{ id: 'tier-10', type: 'tier', attributes: { title: 'Patron', amount_cents: 1200 } }]));

    expect(await prices()).toEqual({ supporter: 500, supporter_plus: 1200, supporter_top: null });
  });

  it('renames only the tiers it carries', async () => {
    titles = { 'tier-5': 'Friend', 'tier-10': 'Patron' };
    await reconcilePatreon();

    const res = await deliver(payload([{ id: 'tier-10', type: 'tier', attributes: { title: 'Patron Plus' } }]));

    expect(res.status).toBe(200);
    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: 'Patron Plus', supporter_top: null });
  });

  it('still answers when the names cannot be written', async () => {
    const set = Setting.set;
    vi.spyOn(Setting, 'set').mockImplementation((key, value) => {
      if (key === PATREON_TIER_NAMES) throw new Error('disk full');
      return set(key, value);
    });

    const res = await deliver(payload([{ id: 'tier-5', type: 'tier', attributes: { title: 'Friend' } }]));

    expect(res.status).toBe(200);
  });

  it('leaves the names alone when it carries no tier', async () => {
    titles = { 'tier-5': 'Friend' };
    await reconcilePatreon();

    await deliver(payload([]));

    expect(await names()).toEqual({ supporter: 'Friend', supporter_plus: null, supporter_top: null });
  });
});

describe('the Patreon calls', () => {
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

  afterEach(() => vi.unstubAllGlobals());

  it('reads titles from the campaign call first', async () => {
    const fetchMock = vi.fn(async () => reply({
      included: [{ id: 'tier-5', type: 'tier', attributes: { title: 'Friend', amount_cents: 500 } }]
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await httpClient.tierTitles('token')).toEqual({
      via: 'campaign', titles: { 'tier-5': 'Friend' }, prices: { 'tier-5': 500 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(fetchMock.mock.calls[0][0])).toContain('campaigns/test-campaign?include=tiers&fields[tier]=title,amount_cents');
  });

  it('falls back to the members call when the campaign call refuses', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).includes('/members')
      ? reply({ data: [], included: [{ id: 'tier-10', type: 'tier', attributes: { title: 'Patron', amount_cents: 1000 } }] })
      : reply({}, 400)));
    vi.stubGlobal('fetch', fetchMock);

    expect(await httpClient.tierTitles('token')).toEqual({
      via: 'members', titles: { 'tier-10': 'Patron' }, prices: { 'tier-10': 1000 }
    });
    expect(decodeURIComponent(fetchMock.mock.calls[1][0])).toContain('fields[tier]=title,amount_cents');
  });

  it('falls back when the campaign reply carries no title', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).includes('/members')
      ? reply({ data: [], included: [{ id: 'tier-5', type: 'tier', attributes: { title: 'Friend' } }] })
      : reply({ data: {}, included: [{ id: 'tier-5', type: 'tier', attributes: {} }] })));
    vi.stubGlobal('fetch', fetchMock);

    expect((await httpClient.tierTitles('token')).via).toBe('members');
  });
});
