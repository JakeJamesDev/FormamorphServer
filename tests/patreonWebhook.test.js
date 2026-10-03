import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { app } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { setPatreonClient, resetPatreonClient } = require('../src/utils/patreon');

/**
 * Patreon telling the server a membership changed.
 *
 * Each test signs its own payload with the suite's webhook secret, the way Patreon signs a delivery. Accounts
 * link through the real flow against a fake Patreon client, then the webhook moves their tier.
 */

const SECRET = 'test-webhook-secret';

let identities;
let members;

beforeEach(() => {
  identities = {};
  members = [];
  setPatreonClient({
    identify: async (code) => identities[code],
    members: async () => members
  });
});

afterEach(() => {
  resetPatreonClient();
  vi.unstubAllEnvs();
});

/** Link `user` to `patreonUserId` through start, approve, and confirm, with the tier the member list gives. */
const link = async (user, patreonUserId, tierIds = []) => {
  members = [{ patreonUserId, tierIds, pledgeStart: '2025-01-01T00:00:00.000+00:00' }];
  const started = await request(app).post('/api/users/me/patreon/link').set(authHeader(user));
  const state = new URL(started.body.data.url).searchParams.get('state');
  const code = `code-${patreonUserId}`;
  identities[code] = patreonUserId;
  const back = await request(app).get('/api/patreon/callback').query({ code, state });
  const token = new URL(back.headers.location).searchParams.get('token');
  const confirmed = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send({ token });
  expect(confirmed.status).toBe(200);
};

const status = async (user) => {
  const res = await request(app).get('/api/users/me/patreon').set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data;
};

/** A member resource as Patreon sends it, in the shape of its documented webhook body. */
const memberBody = (patreonUserId, tierIds, pledgeStart = '2026-03-01T00:00:00.000+00:00') => JSON.stringify({
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

const SINCE = '2026-03-01T00:00:00.000+00:00';

describe('the signature', () => {
  it('accepts a good one and moves the tier', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']));

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual({ linked: true, tier: 'supporter_plus', since: SINCE, showFlair: true });
  });

  it('accepts a signature made outside this suite, so the signer cannot mirror the check', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const body = '{"data":{"type":"member","attributes":{"pledge_relationship_start":null},"relationships":'
      + '{"user":{"data":{"id":"p1","type":"user"}},"currently_entitled_tiers":{"data":[{"id":"tier-10","type":"tier"}]}}}}';

    // Hex HMAC-MD5 of `body` under the suite's secret, computed with Python's hmac module.
    const res = await deliver('members:update', body, 'f8558d37922779613b9ae5df999bba2e');

    expect(res.status).toBe(200);
    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('refuses a signed body that is not JSON', async () => {
    const res = await deliver('members:update', 'not json');

    expect(res.status).toBe(400);
  });

  it('refuses a bad one, and nothing changes', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    const body = memberBody('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', body, sign(body, 'not-the-secret'));

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
  });

  it('refuses a signature over a different body', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']), sign(memberBody('p1', ['tier-5'])));

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
  });

  it('refuses one of the wrong length', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    const body = memberBody('p1', ['tier-10']);

    const res = await deliver('members:pledge:update', body, sign(body).slice(1));

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
  });

  it('refuses a missing one, and nothing changes', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-10']), null);

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
  });

  it('checks the bytes Patreon sent, not a re-serialized copy', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    // Spacing and key order that JSON.stringify would not reproduce.
    const body = `{ "included": [],\n  "data": ${JSON.stringify(JSON.parse(memberBody('p1', ['tier-10'])).data, null, 3)} }`;

    const res = await deliver('members:update', body);

    expect(res.status).toBe(200);
    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('refuses a form-encoded body, which the server would parse before the check', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);
    const body = 'data=x';

    const res = await request(app).post('/api/patreon/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Patreon-Event', 'members:delete')
      .set('X-Patreon-Signature', sign(body))
      .send(body);

    expect(res.status).toBe(401);
    expect(await status(user)).toEqual(before);
  });

  it('refuses everything when the server has no webhook secret', async () => {
    vi.stubEnv('PATREON_WEBHOOK_SECRET', '');
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const body = memberBody('p1', []);

    const res = await deliver('members:delete', body, sign(body, ''));

    expect(res.status).toBe(503);
    expect((await status(user)).tier).toBe('supporter');
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
  ])('%s sets the tier and pledge start from the payload', async (event) => {
    const user = createUser();
    await link(user, 'p1');

    const res = await deliver(event, memberBody('p1', ['tier-5'], '2026-05-05T00:00:00.000+00:00'));

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

      const res = await deliver(event, memberBody('p1', ['tier-10']));

      expect(res.status).toBe(200);
      expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
    }
  );

  it('takes the highest mapped tier', async () => {
    const user = createUser();
    await link(user, 'p1');

    await deliver('members:update', memberBody('p1', ['tier-5', 'tier-other', 'tier-10']));

    expect((await status(user)).tier).toBe('supporter_plus');
  });

  it('clears the tier for a payload with no mapped tier, and keeps the link', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);

    const res = await deliver('members:pledge:update', memberBody('p1', ['tier-other']));

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
  });

  it('keeps a null pledge start as null', async () => {
    const user = createUser();
    await link(user, 'p1');

    await deliver('members:update', memberBody('p1', ['tier-5'], null));

    expect(await status(user)).toEqual({ linked: true, tier: 'supporter', since: null, showFlair: true });
  });

  it('accepts and ignores a trigger it does not handle', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const before = await status(user);

    const res = await deliver('posts:publish', memberBody('p1', []));

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual(before);
  });

  it('keeps the flair toggle as the member set it', async () => {
    const user = createUser();
    await link(user, 'p1', ['tier-5']);
    const toggled = await request(app).patch('/api/users/me/patreon').set(authHeader(user)).send({ showFlair: false });
    expect(toggled.status).toBe(200);

    await deliver('members:pledge:update', memberBody('p1', ['tier-10']));

    expect((await status(user)).showFlair).toBe(false);
  });
});

describe('who it reaches', () => {
  it('accepts and ignores a Patreon user with no link, and links nobody', async () => {
    const linked = createUser();
    const bystander = createUser();
    await link(linked, 'p1', ['tier-5']);

    const res = await deliver('members:create', memberBody('p-unlinked', ['tier-10']));

    expect(res.status).toBe(200);
    expect(await status(linked)).toEqual({ linked: true, tier: 'supporter', since: '2025-01-01T00:00:00.000+00:00', showFlair: true });
    expect(await status(bystander)).toEqual({ linked: false });
  });

  it('moves only the account linked to that Patreon user', async () => {
    const first = createUser();
    const second = createUser();
    await link(first, 'p1', ['tier-5']);
    await link(second, 'p2', ['tier-5']);

    await deliver('members:pledge:update', memberBody('p2', ['tier-10']));

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

    await deliver(event, body);
    const once = await status(user);
    const res = await deliver(event, body);

    expect(res.status).toBe(200);
    expect(await status(user)).toEqual(once);
  });
});
