import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { app, request } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { setPatreonClient, resetPatreonClient } = require('../src/utils/patreon');
const { reconcilePatreon, READ_DEBOUNCE_MS } = require('../src/utils/reconcilePatreon');
const PatreonLink = require('../src/models/PatreonLink');
const Setting = require('../src/models/Setting');
const { PATREON_RECONCILE_FAILURES } = require('../src/config/settings');

/**
 * Patreon telling the server a membership changed.
 *
 * Each test signs its own payload with the suite's webhook secret, the way Patreon signs a delivery. Accounts
 * link through the real flow against a fake Patreon client. A delivery asks for a read of the member list, which
 * runs behind a fake debounce timer, so `settle` is what lets the read happen.
 */

const SECRET = 'test-webhook-secret';
const SINCE = '2026-03-01T00:00:00.000+00:00';

let identities;
let members;
let reads;
let readFails;
let nextRead;

beforeEach(() => {
  identities = {};
  members = [];
  reads = 0;
  readFails = false;
  nextRead = null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setPatreonClient({
    identify: async (code) => identities[code],
    members: async () => {
      reads += 1;
      if (nextRead) {
        const held = nextRead;
        nextRead = null;
        await held;
      }
      if (readFails) throw new Error('Patreon is down');
      return members;
    },
    tierTitles: async () => ({ via: 'campaign', titles: {} })
  });
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPatreonClient();
  vi.unstubAllEnvs();
});

/** Run the pending debounce and whatever read it starts. */
const settle = () => vi.runAllTimersAsync();

/** Make the member list show `patreonUserId` with these tiers, and keep the other members. */
const listShows = (patreonUserId, tierIds, pledgeStart = SINCE) => {
  members = [...members.filter((m) => m.patreonUserId !== patreonUserId), { patreonUserId, tierIds, pledgeStart }];
};

/** Make the member list no longer show `patreonUserId`. */
const listDrops = (patreonUserId) => {
  members = members.filter((m) => m.patreonUserId !== patreonUserId);
};

/** Hold the next read at the moment it asks Patreon, until the returned function is called. */
const holdNextRead = () => {
  let release;
  nextRead = new Promise((resolve) => { release = resolve; });
  return release;
};

/** Link `user` to `patreonUserId` through start, approve, and confirm, with the tier the member list gives. */
const link = async (user, patreonUserId, tierIds = []) => {
  listShows(patreonUserId, tierIds, '2025-01-01T00:00:00.000+00:00');
  const started = await request(app).post('/api/users/me/patreon/link').set(authHeader(user));
  const state = new URL(started.body.data.url).searchParams.get('state');
  const code = `code-${patreonUserId}`;
  identities[code] = patreonUserId;
  const back = await request(app).get('/api/patreon/callback').query({ code, state });
  const token = new URL(back.headers.location).searchParams.get('token');
  const confirmed = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send({ token });
  expect(confirmed.status).toBe(200);
  reads = 0;
};

const status = async (user) => {
  const res = await request(app).get('/api/users/me/patreon').set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data;
};

/** A member resource as Patreon sends it, in the shape of its documented webhook body. */
const memberBody = (patreonUserId, tierIds, pledgeStart = SINCE) => JSON.stringify({
  data: {
    attributes: { patron_status: 'active_patron', pledge_relationship_start: pledgeStart },
    id: `member-${patreonUserId}`,
    relationships: {
      campaign: { data: { id: 'test-campaign', type: 'campaign' } },
      currently_entitled_tiers: { data: tierIds.map((id) => ({ id, type: 'tier' })) },
      user: { data: { id: patreonUserId, type: 'user' } }
    },
    type: 'member'
  },
  included: []
});

const sign = (body, secret = SECRET) => crypto.createHmac('md5', secret).update(body).digest('hex');

/** Deliver `body` as trigger `event`. A null `signature` sends no header. */
const deliver = (event, body, signature = sign(body)) => {
  const call = request(app).post('/api/patreon/webhook').set('Content-Type', 'application/json');
  if (event) call.set('X-Patreon-Event', event);
  if (signature !== null) call.set('X-Patreon-Signature', signature);
  return call.send(body);
};

describe('the signature', () => {
  it('accepts a good one and moves the tier', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listShows('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']));
    await settle();

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual({ linked: true, tier: 'supporter_plus', since: SINCE, showFlair: true });
  });

  it('accepts a signature made outside this suite, so the signer cannot mirror the check', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listShows('p1', ['tier-10']);
    const body = '{"data":{"type":"member","attributes":{"pledge_relationship_start":null},"relationships":'
      + '{"user":{"data":{"id":"p1","type":"user"}},"currently_entitled_tiers":{"data":[{"id":"tier-10","type":"tier"}]}}}}';

    // Hex HMAC-MD5 of `body` under the suite's secret, computed with Python's hmac module.
    const res = await deliver('members:update', body, 'f8558d37922779613b9ae5df999bba2e');
    await settle();

    expect(res.status).toBe(200);
    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('refuses a signed body that is not JSON', async () => {
    const res = await deliver('members:update', 'not json');
    await settle();

    expect(res.status).toBe(400);
    expect(reads).toBe(0);
  });

  // In each refusal the list shows a new tier, so a read that should not happen would move the account.
  it('refuses a bad one, and nothing changes', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listShows('p1', ['tier-10']);
    const body = memberBody('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', body, sign(body, 'not-the-secret'));
    await settle();

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('refuses a signature over a different body', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listShows('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']), sign(memberBody('p1', ['tier-5'])));
    await settle();

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('refuses one of the wrong length', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listShows('p1', ['tier-10']);
    const body = memberBody('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', body, sign(body).slice(1));
    await settle();

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('refuses a missing one, and nothing changes', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listShows('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']), null);
    await settle();

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('checks the bytes Patreon sent, not a re-serialized copy', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listShows('p1', ['tier-10']);
    // Spacing and key order that JSON.stringify would not reproduce.
    const body = `{ "included": [],\n  "data": ${JSON.stringify(JSON.parse(memberBody('p1', ['tier-10'])).data, null, 3)} }`;

    const res = await deliver('members:update', body);
    await settle();

    expect(res.status).toBe(200);
    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('refuses a form-encoded body, which the server would parse before the check', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listDrops('p1');
    const body = 'data=x';

    const res = await request(app).post('/api/patreon/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Patreon-Event', 'members:delete')
      .set('X-Patreon-Signature', sign(body))
      .send(body);
    await settle();

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('refuses everything when the server has no webhook secret', async () => {
    vi.stubEnv('PATREON_WEBHOOK_SECRET', '');
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listDrops('p1');
    const body = memberBody('p1', []);

    const res = await deliver('members:delete', body, sign(body, ''));
    await settle();

    expect(res.status).toBe(503);
    expect((await status(user)).tier).toBe('supporter');
    expect(reads).toBe(0);
  });

  it('needs no account sign-in', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);

    const res = await deliver('members:update', memberBody('p1', ['tier-10']));

    expect(res.status).toBe(200);
  });
});

describe('each trigger', () => {
  it.each([
    'members:create',
    'members:update',
    'members:pledge:create',
    'members:pledge:update'
  ])('%s sets the tier and pledge start from the member list, not the payload', async (event) => {
    const user = createUser();
    await link(user, 'p1');
    listShows('p1', ['tier-5'], '2026-05-05T00:00:00.000+00:00');

    const res = await deliver(event, memberBody('p1', ['tier-10'], '2020-01-01T00:00:00.000+00:00'));
    await settle();

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual({
      linked: true, tier: 'supporter', since: '2026-05-05T00:00:00.000+00:00', showFlair: true
    });
  });

  it.each(['members:delete', 'members:pledge:delete'])(
    '%s clears the tier and keeps the link, whatever tiers the payload still lists',
    async (event) => {
      const user = createUser();
      await link(user, 'p1', ['tier-10']);
      listDrops('p1');

      const res = await deliver(event, memberBody('p1', ['tier-10']));
      await settle();

      expect(res.status).toBe(200);
      expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
    }
  );

  it('takes the highest mapped tier', async () => {
    const user = createUser();
    await link(user, 'p1');
    listShows('p1', ['tier-5', 'tier-other', 'tier-10']);

    await deliver('members:update', memberBody('p1', ['tier-5']));
    await settle();

    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('clears the tier when the list shows no mapped tier, and keeps the link', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listShows('p1', ['tier-other']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-other']));
    await settle();

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
  });

  it('keeps a null pledge start as null', async () => {
    const user = createUser();
    await link(user, 'p1');
    listShows('p1', ['tier-5'], null);

    await deliver('members:update', memberBody('p1', ['tier-5'], null));
    await settle();

    expect(await status(user)).toEqual({ linked: true, tier: 'supporter', since: null, showFlair: true });
  });

  it('accepts and ignores a trigger it does not handle', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    listShows('p1', ['tier-10']);

    const res = await deliver('posts:publish', memberBody('p1', []));
    await settle();

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual(before);
    expect(reads).toBe(0);
  });

  it('keeps the flair toggle as the member set it', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const toggled = await request(app).patch('/api/users/me/patreon').set(authHeader(user)).send({ showFlair: false });
    expect(toggled.status).toBe(200);
    listShows('p1', ['tier-10']);

    await deliver('members:pledge:update', memberBody('p1', ['tier-10']));
    await settle();

    expect((await status(user)).showFlair).toBe(false);
  });
});

describe('who it reaches', () => {
  it('accepts and ignores a Patreon user with no link, and links nobody', async () => {
    const linked = createUser();
    const bystander = createUser();
    await link(linked, 'p1', ['tier-5']);
    listShows('p-unlinked', ['tier-10']);

    const res = await deliver('members:create', memberBody('p-unlinked', ['tier-10']));
    await settle();

    expect(res.status).toBe(200);
    expect(await status(linked)).toEqual({ linked: true, tier: 'supporter', since: '2025-01-01T00:00:00.000+00:00', showFlair: true });
    expect(await status(bystander)).toEqual({ linked: false });
  });

  it('an ending clears only the account linked to that Patreon user', async () => {
    const first = createUser();
    const second = createUser();
    await link(first, 'p1', ['tier-5']);
    await link(second, 'p2', ['tier-5']);

    await deliver('members:delete', memberBody('p2', ['tier-5']));

    expect((await status(first)).tier).toBe('supporter');
    expect((await status(second)).tier).toBeNull();
  });

  it('gives each account what the list shows for it', async () => {
    const first = createUser();
    const second = createUser();
    await link(first, 'p1', ['tier-5']);
    await link(second, 'p2', ['tier-5']);
    listShows('p2', ['tier-10']);

    await deliver('members:pledge:update', memberBody('p2', ['tier-10']));
    await settle();

    expect((await status(first)).tier).toBe('supporter');
    expect((await status(second)).tier).toBe('supporter_plus');
  });
});

describe('a repeat', () => {
  it.each([
    ['members:pledge:update', ['tier-10']],
    ['members:pledge:delete', ['tier-10']]
  ])('of %s gives the same state', async (event, tierIds) => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const body = memberBody('p1', tierIds);
    if (event.endsWith('delete')) listDrops('p1');
    else listShows('p1', tierIds);

    await deliver(event, body);
    await settle();
    const once = await status(user);
    const res = await deliver(event, body);
    await settle();

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual(once);
  });
});

describe('the member list decides', () => {
  const OLD_CHECK = '2026-01-01T00:00:00.000Z';

  /** A linked supporter whose last confirmed read is old, so a stamp from a delivery would show. */
  const staleLink = async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    PatreonLink.setTier({ patreonUserId: 'p1', tier: 'supporter', pledgeStart: SINCE, checkedAt: OLD_CHECK });
    return user;
  };

  const checkedAt = (user) => PatreonLink.findByUser(user.id).checked_at;

  it('a repeated create after an ending does not restore the tier when the list shows none', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    listDrops('p1');
    const body = memberBody('p1', ['tier-5']);

    await deliver('members:pledge:delete', body);
    await settle();
    await deliver('members:pledge:create', body);
    await settle();

    expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
  });

  it('a non-ending delivery changes no tier and no checked_at until the read succeeds', async () => {
    const user = await staleLink();
    listShows('p1', ['tier-10']);

    await deliver('members:pledge:update', memberBody('p1', ['tier-10']));

    expect((await status(user)).tier).toBe('supporter');
    expect(checkedAt(user)).toBe(OLD_CHECK);

    await settle();

    expect((await status(user)).tier).toBe('supporter_plus');
    expect(checkedAt(user)).not.toBe(OLD_CHECK);
  });

  it('a non-ending delivery changes nothing when the read fails, so a replay cannot extend the cutoff', async () => {
    const user = await staleLink();
    const before = await status(user);
    listShows('p1', ['tier-10']);
    readFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await deliver('members:create', memberBody('p1', ['tier-10']));
    await settle();

    expect(res.status).toBe(200);
    expect(reads).toBe(1);
    expect(await status(user)).toEqual(before);
    expect(checkedAt(user)).toBe(OLD_CHECK);
  });

  it('an ending applies at once, before any read', async () => {
    const user = await staleLink();

    await deliver('members:delete', memberBody('p1', ['tier-5']));

    expect(reads).toBe(0);
    expect((await status(user)).tier).toBeNull();
  });

  it('an ending stays applied when the read fails', async () => {
    const user = await staleLink();
    readFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await deliver('members:pledge:delete', memberBody('p1', ['tier-5']));
    await settle();

    expect(reads).toBe(1);
    expect((await status(user)).tier).toBeNull();
  });

  it('a later delivery reads again after a failed read', async () => {
    const user = await staleLink();
    listShows('p1', ['tier-10']);
    readFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver('members:update', memberBody('p1', ['tier-10']));
    await settle();

    readFails = false;
    await deliver('members:update', memberBody('p1', ['tier-10']));
    await settle();

    expect(reads).toBe(2);
    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('asks for a read when the payload names no member', async () => {
    const user = await staleLink();
    listShows('p1', ['tier-10']);

    await deliver('members:update', '{}');
    await settle();

    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('a failed delivery read does not count toward the alert', async () => {
    await staleLink();
    readFails = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let run = 0; run < 4; run += 1) {
      await deliver('members:update', memberBody('p1', ['tier-5']));
      await settle();
    }

    expect(reads).toBe(4);
    const readLogs = logged.mock.calls.filter(([message]) => message === 'Patreon webhook member read failed:');
    expect(readLogs).toHaveLength(4);
    expect(String(readLogs[0])).toContain('Patreon is down');
    expect(Setting.get(PATREON_RECONCILE_FAILURES) || 0).toBe(0);
  });
});

describe('the stored failure count', () => {
  it('stays as it was after a successful delivery read', async () => {
    await link(createUser(), 'p1', ['tier-5']);
    Setting.set(PATREON_RECONCILE_FAILURES, 2);

    await deliver('members:update', memberBody('p1', ['tier-5']));
    await settle();

    expect(reads).toBe(1);
    expect(Setting.get(PATREON_RECONCILE_FAILURES)).toBe(2);
  });
});

describe('a burst of deliveries', () => {
  beforeEach(async () => {
    await link(createUser(), 'p1', ['tier-5']);
  });

  it('makes one read', async () => {
    const body = memberBody('p1', ['tier-10']);
    for (const event of ['members:update', 'members:pledge:update', 'members:pledge:delete', 'members:create']) {
      await deliver(event, body);
    }

    expect(reads).toBe(0);
    await settle();

    expect(reads).toBe(1);
  });

  it('reads when the first delivery\'s wait ends, however late the last delivery came', async () => {
    const body = memberBody('p1', ['tier-10']);

    await deliver('members:update', body);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS - 1);
    await deliver('members:update', body);
    expect(reads).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(reads).toBe(1);
  });

  it('holds no handle open while it waits', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');

    await deliver('members:update', memberBody('p1', ['tier-10']));

    const debounce = timers.mock.results.find((_, index) => timers.mock.calls[index][1] === READ_DEBOUNCE_MS);
    expect(debounce.value.hasRef()).toBe(false);
  });

  it('makes one more read for deliveries that land during a read, and answers them first', async () => {
    const release = holdNextRead();
    const body = memberBody('p1', ['tier-5']);
    await deliver('members:update', body);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(reads).toBe(1);

    const during = await deliver('members:update', body);
    await deliver('members:pledge:update', body);
    expect(during.status).toBe(200);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(reads).toBe(1);

    release();
    await settle();

    expect(reads).toBe(2);
  });
});

describe('a read already in flight when a delivery lands', () => {
  /** A delivery read held at the fetch: the list it answers with still shows the member's tier. */
  const heldStaleRead = async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const release = holdNextRead();
    await deliver('members:update', memberBody('p1', ['tier-5']));
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(reads).toBe(1);
    return { user, release };
  };

  it('a delivery read that fetched before an ending does not restore the tier', async () => {
    const { user, release } = await heldStaleRead();

    await deliver('members:pledge:delete', memberBody('p1', ['tier-5']));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await status(user)).tier).toBeNull();

    listDrops('p1');
    await settle();

    expect(reads).toBe(2);
    expect((await status(user)).tier).toBeNull();
  });

  it('an ending stays applied when the read after a stale read fails', async () => {
    const { user, release } = await heldStaleRead();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await deliver('members:pledge:delete', memberBody('p1', ['tier-5']));
    release();
    await vi.advanceTimersByTimeAsync(0);
    readFails = true;
    await settle();

    expect(reads).toBe(2);
    expect((await status(user)).tier).toBeNull();
  });

  it('an hourly run that fetched before an ending does not restore the tier', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const release = holdNextRead();
    const hourly = reconcilePatreon();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    await deliver('members:delete', memberBody('p1', ['tier-5']));
    release();
    await hourly;
    expect((await status(user)).tier).toBeNull();

    listDrops('p1');
    await settle();

    expect(reads).toBe(2);
    expect((await status(user)).tier).toBeNull();
  });

  it('the read after a voided one applies a new tier', async () => {
    const { user, release } = await heldStaleRead();
    listShows('p1', ['tier-10']);

    await deliver('members:pledge:update', memberBody('p1', ['tier-10']));
    release();
    await settle();

    expect(reads).toBe(2);
    expect((await status(user)).tier).toBe('supporter_plus');
  });
});

describe('an hourly run beside a delivery read', () => {
  const heldDeliveryRead = async () => {
    await link(createUser(), 'p1', ['tier-5']);
    const release = holdNextRead();
    await deliver('members:update', memberBody('p1', ['tier-5']));
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    return release;
  };

  it('shares the read in flight', async () => {
    const release = await heldDeliveryRead();

    const hourly = reconcilePatreon();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await hourly;
    await settle();

    expect(reads).toBe(1);
  });

  it('counts its own result once when the shared read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await heldDeliveryRead();
    readFails = true;

    const hourly = reconcilePatreon();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await hourly;
    await settle();

    expect(reads).toBe(1);
    expect(Setting.get(PATREON_RECONCILE_FAILURES)).toBe(1);
  });
});

describe('a server without Patreon configured', () => {
  /** Load a module again, as a new process would, and keep the database it shares. */
  const freshRequire = (path) => {
    delete require.cache[require.resolve(path)];
    return require(path);
  };

  it('makes no read when one is asked for', async () => {
    vi.stubEnv('PATREON_CAMPAIGN_ID', '');
    freshRequire('../src/config/patreon');
    const unconfigured = freshRequire('../src/utils/reconcilePatreon');

    try {
      unconfigured.requestMemberRead();
      await settle();
    } finally {
      vi.unstubAllEnvs();
      freshRequire('../src/config/patreon');
      freshRequire('../src/utils/reconcilePatreon');
    }

    expect(reads).toBe(0);
  });
});
