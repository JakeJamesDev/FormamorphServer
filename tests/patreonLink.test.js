import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { setPatreonClient, resetPatreonClient } = require('../src/utils/patreon');
const deleteUser = require('../src/utils/deleteUser');
const User = require('../src/models/User');
const PatreonLink = require('../src/models/PatreonLink');
const { LINK_STATE_TTL_MS, PENDING_LINK_TTL_MS } = require('../src/config/patreon');
const jwt = require('jsonwebtoken');

/**
 * Linking a Patreon account.
 *
 * A member starts the link here, approves on Patreon, and lands back on the site's account page with a
 * one-shot token, which that page confirms as the same account. The Patreon client is a fake: `identities` maps an OAuth code to a Patreon user, and `members`
 * is the campaign member list the creator token reads.
 */

let identities;
let members;
let membersFail;
let identifyCalls;

beforeEach(() => {
  identities = {};
  members = [];
  membersFail = false;
  identifyCalls = 0;
  setPatreonClient({
    identify: async (code) => {
      identifyCalls += 1;
      if (!(code in identities)) throw new Error('Patreon refused the code');
      return identities[code];
    },
    members: async () => {
      if (membersFail) throw new Error('Patreon is down');
      return members;
    }
  });
});

afterEach(() => {
  resetPatreonClient();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const startLink = (user) => request(app).post('/api/users/me/patreon/link').set(authHeader(user));

/** The state the start route put in Patreon's approval URL. */
const stateFor = async (user) => new URL((await startLink(user)).body.data.url).searchParams.get('state');

/** Patreon sending the browser back. Answers what the account page receives. */
const arrive = async (query) => {
  const res = await request(app).get('/api/patreon/callback').query(query);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location);
  expect(`${location.origin}${location.pathname}`).toBe('https://formamorph.ai/account');
  return { result: location.searchParams.get('patreon'), token: location.searchParams.get('token') };
};

const callback = async (query) => (await arrive(query)).result;

/** Approve on Patreon as `patreonUserId` against `user`'s state. Answers the account page's URL values. */
const approve = async (user, patreonUserId) => {
  const code = `code-${patreonUserId}-${user.id}`;
  identities[code] = patreonUserId;
  return arrive({ code, state: await stateFor(user) });
};

/** The account page, signed in as `user`, confirming with the token from its URL. */
const confirm = (user, token) =>
  request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send({ token });

const CONFIRM_RESULTS = { 200: 'linked', 400: 'refused', 409: 'taken' };

/** The whole flow: start, approve on Patreon as `patreonUserId`, come back, confirm. */
const link = async (user, patreonUserId) => {
  const { result, token } = await approve(user, patreonUserId);
  if (result !== 'confirm') return result;
  return CONFIRM_RESULTS[(await confirm(user, token)).status];
};

const status = async (user) => {
  const res = await request(app).get('/api/users/me/patreon').set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data;
};

const unlink = (user) => request(app).delete('/api/users/me/patreon').set(authHeader(user));

const member = (patreonUserId, tierIds, pledgeStart = '2026-03-01T00:00:00.000+00:00') =>
  ({ patreonUserId, tierIds, pledgeStart });

describe('starting a link', () => {
  it("answers Patreon's approval URL with the identity scope and a state", async () => {
    const user = createUser();

    const res = await startLink(user);

    expect(res.status).toBe(200);
    const url = new URL(res.body.data.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.patreon.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identity');
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/patreon/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('is refused to a signed-out visitor', async () => {
    expect((await request(app).post('/api/users/me/patreon/link')).status).toBe(401);
  });

  it('hands out a state that does not work as a session token', async () => {
    const user = createUser();
    const state = await stateFor(user);

    const res = await request(app).get('/api/users/me/patreon').set('Authorization', `Bearer ${state}`);

    expect(res.status).toBe(401);
  });
});

describe('the tier a link reads', () => {
  it.each([
    ['the $5 tier', ['tier-5'], 'supporter'],
    ['the $10 tier', ['tier-10'], 'supporter_plus'],
    ['both tiers, which reads as the higher one', ['tier-5', 'tier-10'], 'supporter_plus'],
    ['a mapped tier beside an unmapped one', ['tier-other', 'tier-5'], 'supporter']
  ])('gives %s its tier and pledge start', async (_name, tierIds, tier) => {
    const user = createUser();
    members = [member('p-1', tierIds, '2025-11-04T10:00:00.000+00:00')];

    expect(await link(user, 'p-1')).toBe('linked');

    expect(await status(user)).toEqual({
      linked: true, tier, since: '2025-11-04T10:00:00.000+00:00', showFlair: true
    });
  });

  it.each([
    ['no entitled tier', [member('p-1', [])]],
    ['only an unmapped tier', [member('p-1', ['tier-other'])]],
    ['a member absent from the list', [member('p-2', ['tier-10'])]]
  ])('links %s with no tier', async (_name, list) => {
    const user = createUser();
    members = list;

    expect(await link(user, 'p-1')).toBe('linked');

    expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
  });

  it('links with no tier when the member list cannot be read', async () => {
    const user = createUser();
    membersFail = true;

    expect(await link(user, 'p-1')).toBe('linked');

    expect(await status(user)).toEqual({ linked: true, tier: null, since: null, showFlair: true });
  });

  it('keeps a null pledge start as null', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-5'], null)];

    await link(user, 'p-1');

    expect(await status(user)).toMatchObject({ tier: 'supporter', since: null });
  });
});

describe('the callback', () => {
  it('stores nothing for a forged state', async () => {
    const user = createUser();
    identities.good = 'p-1';
    const forged = jwt.sign({ id: user.id, tv: 0 }, 'not-the-secret');

    expect(await callback({ code: 'good', state: forged })).toBe('expired');

    expect(await status(user)).toEqual({ linked: false });
    expect(identifyCalls).toBe(0);
  });

  it('stores nothing for a session token passed as the state', async () => {
    const user = createUser();
    identities.good = 'p-1';
    const session = authHeader(user).Authorization.replace('Bearer ', '');

    expect(await callback({ code: 'good', state: session })).toBe('expired');

    expect(await status(user)).toEqual({ linked: false });
  });

  it('stores nothing for a missing state', async () => {
    identities.good = 'p-1';

    expect(await callback({ code: 'good' })).toBe('expired');

    expect(identifyCalls).toBe(0);
  });

  it('stores nothing once the state has run out', async () => {
    const user = createUser();
    identities.good = 'p-1';
    vi.useFakeTimers({ toFake: ['Date'] });
    const state = await stateFor(user);

    vi.setSystemTime(Date.now() + LINK_STATE_TTL_MS + 1000);

    expect(await callback({ code: 'good', state })).toBe('expired');
    expect(await status(user)).toEqual({ linked: false });
  });

  it('still accepts the approval inside the state lifetime', async () => {
    const user = createUser();
    identities.good = 'p-1';
    vi.useFakeTimers({ toFake: ['Date'] });
    const state = await stateFor(user);

    vi.setSystemTime(Date.now() + LINK_STATE_TTL_MS - 60 * 1000);

    expect(await callback({ code: 'good', state })).toBe('confirm');
  });

  it('stores nothing for an account erased while it was on Patreon', async () => {
    const user = createUser();
    identities.good = 'p-1';
    const state = await stateFor(user);

    expect((await deleteUser(user.username)).success).toBe(true);

    expect(await callback({ code: 'good', state })).toBe('expired');
  });

  it('stores nothing once the account signed out everywhere', async () => {
    const user = createUser();
    identities.good = 'p-1';
    const state = await stateFor(user);

    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);

    expect(await callback({ code: 'good', state })).toBe('expired');
    expect(await status(user)).toEqual({ linked: false });
  });

  it('stores nothing for an account suspended while it was on Patreon', async () => {
    const user = createUser();
    identities.good = 'p-1';
    const state = await stateFor(user);

    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);

    expect(await callback({ code: 'good', state })).toBe('expired');
    expect(await status(user)).toEqual({ linked: false });
  });

  it('says denied when the member refused on Patreon', async () => {
    const user = createUser();

    expect(await callback({ error: 'access_denied', state: await stateFor(user) })).toBe('denied');

    expect(await status(user)).toEqual({ linked: false });
  });

  it('says failed when Patreon refuses the code', async () => {
    const user = createUser();

    expect(await callback({ code: 'unknown', state: await stateFor(user) })).toBe('failed');

    expect(await status(user)).toEqual({ linked: false });
  });

  it.each([
    ['reading the account', () => vi.spyOn(User, 'findById')],
    ['checking the Patreon user', () => vi.spyOn(PatreonLink, 'isHeldElsewhere')]
  ])('says failed when the database throws while %s', async (_name, spy) => {
    const user = createUser();
    identities.good = 'p-1';
    const state = await stateFor(user);
    spy().mockImplementation(() => { throw new Error('database is locked'); });

    expect(await callback({ code: 'good', state })).toBe('failed');
  });

  it('links nothing until the account confirms', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-5'])];

    const { result, token } = await approve(user, 'p-1');

    expect(result).toBe('confirm');
    expect(token).toBeTruthy();
    expect(await status(user)).toEqual({ linked: false });
  });
});

describe('confirming a link', () => {
  it("refuses a victim who approved an attacker's link, and links neither account", async () => {
    const attacker = createUser();
    const victim = createUser();
    members = [member('p-victim', ['tier-10'])];

    // The attacker's state, approved on Patreon by the victim, lands in the victim's browser.
    const { token } = await approve(attacker, 'p-victim');
    const res = await confirm(victim, token);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PATREON_CONFIRM_REFUSED');
    expect(await status(victim)).toEqual({ linked: false });
    expect(await status(attacker)).toEqual({ linked: false });
  });

  it('spends the token on a refused confirm, so the named account cannot use it after', async () => {
    const attacker = createUser();
    const victim = createUser();
    const { token } = await approve(attacker, 'p-victim');
    await confirm(victim, token);

    expect((await confirm(attacker, token)).status).toBe(400);

    expect(await status(attacker)).toEqual({ linked: false });
    expect(await link(victim, 'p-victim')).toBe('linked');
  });

  it('works once', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-5'])];
    const { token } = await approve(user, 'p-1');

    expect((await confirm(user, token)).status).toBe(200);
    await unlink(user);

    expect((await confirm(user, token)).status).toBe(400);
    expect(await status(user)).toEqual({ linked: false });
  });

  it('answers the new status', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-10'], '2025-06-01T00:00:00.000+00:00')];
    const { token } = await approve(user, 'p-1');

    const res = await confirm(user, token);

    expect(res.body.data).toEqual({
      linked: true, tier: 'supporter_plus', since: '2025-06-01T00:00:00.000+00:00', showFlair: true
    });
  });

  it('refuses once the token has run out', async () => {
    const user = createUser();
    vi.useFakeTimers({ toFake: ['Date'] });
    const { token } = await approve(user, 'p-1');

    vi.setSystemTime(Date.now() + PENDING_LINK_TTL_MS + 1000);

    expect((await confirm(user, token)).status).toBe(400);
    expect(await status(user)).toEqual({ linked: false });
  });

  it('still confirms inside the token lifetime', async () => {
    const user = createUser();
    vi.useFakeTimers({ toFake: ['Date'] });
    const { token } = await approve(user, 'p-1');

    vi.setSystemTime(Date.now() + PENDING_LINK_TTL_MS - 60 * 1000);

    expect((await confirm(user, token)).status).toBe(200);
  });

  it.each([
    ['no token', {}],
    ['an unknown token', { token: 'made-up' }],
    ['a token that is not a string', { token: { $ne: null } }]
  ])('refuses %s', async (_name, body) => {
    const user = createUser();

    const res = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send(body);

    expect(res.status).toBe(400);
  });

  it('is refused to a signed-out visitor', async () => {
    const user = createUser();
    const { token } = await approve(user, 'p-1');

    expect((await request(app).post('/api/users/me/patreon/confirm').send({ token })).status).toBe(401);
    expect((await confirm(user, token)).status).toBe(200);
  });

  it('refuses a Patreon user another account linked between approval and confirm', async () => {
    const first = createUser();
    const second = createUser();
    const pending = await approve(first, 'p-1');
    await link(second, 'p-1');

    const res = await confirm(first, pending.token);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATREON_TAKEN');
    expect(await status(first)).toEqual({ linked: false });
  });
});

describe('one Patreon account, one Formamorph account', () => {
  it('refuses a Patreon user another account holds, and leaves that link alone', async () => {
    const holder = createUser();
    const second = createUser();
    members = [member('p-1', ['tier-10'])];
    await link(holder, 'p-1');

    expect(await link(second, 'p-1')).toBe('taken');

    expect(await status(second)).toEqual({ linked: false });
    expect(await status(holder)).toMatchObject({ linked: true, tier: 'supporter_plus' });
  });

  it('links the second account once the first unlinks', async () => {
    const holder = createUser();
    const second = createUser();
    members = [member('p-1', ['tier-5'])];
    await link(holder, 'p-1');

    expect((await unlink(holder)).status).toBe(200);

    expect(await link(second, 'p-1')).toBe('linked');
    expect(await status(second)).toMatchObject({ linked: true, tier: 'supporter' });
  });

  it('replaces the link when an account links a different Patreon user, and frees the old one', async () => {
    const user = createUser();
    const other = createUser();
    members = [member('p-1', ['tier-5']), member('p-2', ['tier-10'])];
    await link(user, 'p-1');

    expect(await link(user, 'p-2')).toBe('linked');
    expect(await status(user)).toMatchObject({ tier: 'supporter_plus' });

    expect(await link(other, 'p-1')).toBe('linked');
  });

  it('relinks the same Patreon user to the same account', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-5'])];
    await link(user, 'p-1');

    expect(await link(user, 'p-1')).toBe('linked');
  });

  it('frees the Patreon user when the account that held it is erased', async () => {
    const holder = createUser();
    const second = createUser();
    await link(holder, 'p-1');

    expect((await deleteUser(holder.username)).success).toBe(true);

    expect(await link(second, 'p-1')).toBe('linked');
  });
});

describe('status and unlink', () => {
  it('reads not linked for an account that never linked', async () => {
    expect(await status(createUser())).toEqual({ linked: false });
  });

  it('is refused to a signed-out visitor', async () => {
    expect((await request(app).get('/api/users/me/patreon')).status).toBe(401);
    expect((await request(app).delete('/api/users/me/patreon')).status).toBe(401);
  });

  it('unlinks, and the status reads not linked', async () => {
    const user = createUser();
    members = [member('p-1', ['tier-5'])];
    await link(user, 'p-1');

    const res = await unlink(user);

    expect(res.body.data).toEqual({ linked: false });
    expect(await status(user)).toEqual({ linked: false });
  });

  it('answers an unlink with no link as done', async () => {
    expect((await unlink(createUser())).status).toBe(200);
  });

  it("reads only the caller's own link", async () => {
    const linked = createUser();
    const other = createUser();
    members = [member('p-1', ['tier-5'])];
    await link(linked, 'p-1');

    expect(await status(other)).toEqual({ linked: false });
  });
});
