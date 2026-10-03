import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const {
  setPatreonClient, resetPatreonClient, listMembers, PatreonAuthError
} = require('../src/utils/patreon');
const { reconcilePatreon, startPatreonReconciler } = require('../src/utils/reconcilePatreon');
const PatreonLink = require('../src/models/PatreonLink');
const Setting = require('../src/models/Setting');
const { PATREON_CREATOR_TOKENS } = require('../src/config/settings');
const { HOUR_MS, DAY_MS } = require('../src/config/time');

/**
 * The hourly reconcile and the creator token it reads with.
 *
 * The Patreon client is a fake. `members` is the campaign member list, readable only with `validToken`;
 * any other token is an authorization failure. `refresh` trades `validRefresh` for the next pair.
 */

let members;
let membersFail;
let validToken;
let validRefresh;
let memberCalls;
let refreshCalls;
let refreshDown;
let nextPair;
let logged;

beforeEach(() => {
  members = [];
  membersFail = false;
  validToken = 'test-creator-token';
  validRefresh = 'test-creator-refresh';
  memberCalls = [];
  refreshCalls = [];
  refreshDown = false;
  nextPair = { accessToken: 'creator-2', refreshToken: 'refresh-2', expiresIn: 2678400 };
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  setPatreonClient({
    identify: async () => { throw new Error('not used'); },
    members: async (token) => {
      memberCalls.push(token);
      if (membersFail) throw new Error('Patreon is down');
      if (token !== validToken) throw new PatreonAuthError('Patreon refused the token (401)');
      return members;
    },
    refresh: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      if (refreshDown) throw new Error('Patreon is down');
      if (refreshToken !== validRefresh) throw new PatreonAuthError('Patreon refused the refresh (401)');
      validToken = nextPair.accessToken;
      return nextPair;
    }
  });
});

afterEach(() => {
  resetPatreonClient();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const member = (patreonUserId, tierIds, pledgeStart = '2025-03-01T00:00:00.000+00:00') =>
  ({ patreonUserId, tierIds, pledgeStart });

/** Store a creator pair that expires `expiresInMs` from now. */
const storePair = (accessToken, expiresInMs) => Setting.set(PATREON_CREATOR_TOKENS, {
  accessToken,
  refreshToken: 'test-creator-refresh',
  expiresAt: new Date(Date.now() + expiresInMs).toISOString()
});

const linkedUser = async (patreonUserId, tier, pledgeStart = null) => {
  const user = await createUser();
  PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart, checkedAt: null });
  return user;
};

describe('the Patreon reconcile', () => {
  it('corrects a wrong tier and pledge start from the member list', async () => {
    const user = await linkedUser('p1', 'supporter', '2020-01-01T00:00:00.000+00:00');
    members = [member('p1', ['tier-10'], '2025-03-01T00:00:00.000+00:00')];

    await reconcilePatreon();

    const link = PatreonLink.findByUser(user.id);
    expect(link.tier).toBe('supporter_plus');
    expect(link.pledge_start).toBe('2025-03-01T00:00:00.000+00:00');
    expect(link.checked_at).not.toBeNull();
  });

  it('clears the tier of a member who left the campaign and keeps the link', async () => {
    const departed = await linkedUser('p1', 'supporter_plus', '2025-01-01T00:00:00.000+00:00');
    const unmapped = await linkedUser('p2', 'supporter');
    const staying = await linkedUser('p3', null);
    members = [member('p2', ['tier-other']), member('p3', ['tier-5'])];

    await reconcilePatreon();

    expect(PatreonLink.findByUser(departed.id)).toMatchObject({ patreon_user_id: 'p1', tier: null, pledge_start: null });
    expect(PatreonLink.findByUser(unmapped.id)).toMatchObject({ patreon_user_id: 'p2', tier: null, pledge_start: null });
    expect(PatreonLink.findByUser(staying.id)).toMatchObject({ tier: 'supporter' });
  });

  it('changes no link and logs when the read fails', async () => {
    const user = await linkedUser('p1', 'supporter', '2024-01-01T00:00:00.000+00:00');
    const before = PatreonLink.findByUser(user.id);
    membersFail = true;

    await expect(reconcilePatreon()).resolves.toBeNull();

    expect(PatreonLink.findByUser(user.id)).toEqual(before);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0])).toContain('Patreon is down');
  });

  it('reads every page of the member list before it applies any tier', async () => {
    resetPatreonClient();
    storePair('test-creator-token', DAY_MS * 30);
    const first = await linkedUser('p1', null);
    const second = await linkedUser('p2', null);
    const page = (userId, tierId, next) => ({
      data: [{
        type: 'member',
        attributes: { pledge_relationship_start: '2025-05-05T00:00:00.000+00:00' },
        relationships: {
          user: { data: { id: userId, type: 'user' } },
          currently_entitled_tiers: { data: [{ id: tierId, type: 'tier' }] }
        }
      }],
      meta: { pagination: { cursors: { next } } }
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page('p1', 'tier-5', 'cursor-2') })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page('p2', 'tier-10', null) });
    vi.stubGlobal('fetch', fetch);

    await reconcilePatreon();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('page[cursor]')).toBe('cursor-2');
    expect(PatreonLink.findByUser(first.id).tier).toBe('supporter');
    expect(PatreonLink.findByUser(second.id).tier).toBe('supporter_plus');
  });

  it('runs again every hour and holds no handle open', async () => {
    vi.useFakeTimers();
    const user = await linkedUser('p1', null);
    members = [member('p1', ['tier-5'])];

    const timer = startPatreonReconciler();
    try {
      expect(timer.hasRef()).toBe(false);
      expect(memberCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(memberCalls).toHaveLength(1);
      expect(PatreonLink.findByUser(user.id).tier).toBe('supporter');

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(memberCalls).toHaveLength(2);
    } finally {
      clearInterval(timer);
    }
  });
});

describe('the creator token', () => {
  it('refreshes the environment pair on first use and stores the new pair with its expiry', async () => {
    expect(Setting.get(PATREON_CREATOR_TOKENS)).toBeNull();

    await listMembers();

    expect(refreshCalls).toEqual(['test-creator-refresh']);
    expect(memberCalls).toEqual(['creator-2']);
    const stored = Setting.get(PATREON_CREATOR_TOKENS);
    expect(stored).toMatchObject({ accessToken: 'creator-2', refreshToken: 'refresh-2' });
    expect(Date.parse(stored.expiresAt) - Date.now()).toBeGreaterThan(30 * DAY_MS);

    // The stored pair is what the next read, or the next process, starts from.
    validRefresh = 'refresh-2';
    await listMembers();
    expect(memberCalls).toEqual(['creator-2', 'creator-2']);
    expect(refreshCalls).toHaveLength(1);
  });

  it('refreshes on an authorization failure, retries, and stores the new pair', async () => {
    storePair('a-token-patreon-revoked', DAY_MS * 20);

    await listMembers();

    expect(refreshCalls).toEqual(['test-creator-refresh']);
    expect(memberCalls).toEqual(['a-token-patreon-revoked', 'creator-2']);
    expect(Setting.get(PATREON_CREATOR_TOKENS)).toMatchObject({ accessToken: 'creator-2', refreshToken: 'refresh-2' });
  });

  it('refreshes ahead of a stored expiry without waiting for a refusal', async () => {
    storePair('test-creator-token', HOUR_MS);

    await listMembers();

    expect(refreshCalls).toEqual(['test-creator-refresh']);
    expect(memberCalls).toEqual(['creator-2']);
    expect(Setting.get(PATREON_CREATOR_TOKENS).accessToken).toBe('creator-2');
  });

  it('reads with the current pair when an early refresh fails', async () => {
    storePair('test-creator-token', HOUR_MS);
    members = [member('p1', ['tier-5'])];
    refreshDown = true;

    await expect(listMembers()).resolves.toEqual(members);

    expect(memberCalls).toEqual(['test-creator-token']);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(Setting.get(PATREON_CREATOR_TOKENS).accessToken).toBe('test-creator-token');
  });

  it('keeps the refresh token when Patreon sends none back', async () => {
    nextPair.refreshToken = undefined;

    await listMembers();

    expect(Setting.get(PATREON_CREATOR_TOKENS)).toMatchObject({ accessToken: 'creator-2', refreshToken: 'test-creator-refresh' });
  });

  it('sends one refresh for reads that fail together', async () => {
    storePair('revoked', DAY_MS * 20);

    await Promise.all([listMembers(), listMembers(), listMembers()]);

    expect(refreshCalls).toHaveLength(1);
    expect(memberCalls.filter((token) => token === 'creator-2')).toHaveLength(3);
  });

  it('retries with the new pair when a refusal lands after another read refreshed', async () => {
    storePair('revoked', DAY_MS * 20);
    const refusals = [];
    setPatreonClient({
      identify: async () => { throw new Error('not used'); },
      members: (token) => {
        memberCalls.push(token);
        if (token === validToken) return Promise.resolve(members);
        return new Promise((resolve, reject) => refusals.push(() => reject(new PatreonAuthError('refused (401)'))));
      },
      refresh: async (refreshToken) => {
        refreshCalls.push(refreshToken);
        if (refreshToken !== validRefresh) throw new PatreonAuthError('Patreon refused the refresh (401)');
        validToken = nextPair.accessToken;
        return nextPair;
      }
    });

    const first = listMembers();
    const second = listMembers();
    await vi.waitFor(() => expect(refusals).toHaveLength(2));
    refusals[0]();
    await first;
    refusals[1]();

    await expect(second).resolves.toEqual(members);
    expect(refreshCalls).toEqual(['test-creator-refresh']);
  });

  it('stores nothing when the refresh fails', async () => {
    validToken = 'revoked';
    validRefresh = 'a-refresh-patreon-revoked';

    await expect(listMembers()).rejects.toThrow('401');

    expect(Setting.get(PATREON_CREATOR_TOKENS)).toBeNull();
  });

  it('is not a setting staff can read or write', async () => {
    const staff = await createUser({ accountType: 'admin' });

    const read = await request(app).get(`/api/settings/${PATREON_CREATOR_TOKENS}`).set(authHeader(staff));
    const write = await request(app).put(`/api/settings/${PATREON_CREATOR_TOKENS}`).set(authHeader(staff))
      .send({ value: { accessToken: 'mine' } });

    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
  });
});
