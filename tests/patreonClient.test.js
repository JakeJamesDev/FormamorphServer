import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { httpClient, USER_AGENT } = require('../src/utils/patreon');

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** A fetch that answers each call with the next body in order. */
const stubFetch = (...bodies) => {
  const fetch = vi.fn();
  for (const body of bodies) {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const memberResource = (userId, tierIds, pledgeStart) => ({
  type: 'member',
  attributes: { pledge_relationship_start: pledgeStart },
  relationships: {
    user: { data: { id: userId, type: 'user' } },
    currently_entitled_tiers: { data: tierIds.map((id) => ({ id, type: 'tier' })) }
  }
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the Patreon client', () => {
  it('exchanges the code, reads the identity with that token, and hands back only the user ID', async () => {
    const fetch = stubFetch(
      { access_token: 'member-access', refresh_token: 'member-refresh', expires_in: 2678400 },
      { data: { id: '9001', type: 'user' } }
    );

    const id = await httpClient.identify('the-code');

    expect(id).toBe('9001');
    const [tokenUrl, tokenInit] = fetch.mock.calls[0];
    expect(tokenUrl).toBe('https://www.patreon.com/api/oauth2/token');
    expect(tokenInit.method).toBe('POST');
    const form = new URLSearchParams(tokenInit.body);
    expect(form.get('code')).toBe('the-code');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe('https://api.example.test/api/patreon/callback');
    const [identityUrl, identityInit] = fetch.mock.calls[1];
    expect(identityUrl).toBe('https://www.patreon.com/api/oauth2/v2/identity');
    expect(identityInit.headers.Authorization).toBe('Bearer member-access');
  });

  it('reads every page of the member list with the creator token', async () => {
    const fetch = stubFetch(
      {
        data: [memberResource('1', ['tier-5'], '2025-01-01T00:00:00.000+00:00')],
        meta: { pagination: { cursors: { next: 'cursor-2' } } }
      },
      {
        data: [memberResource('2', ['tier-10', 'tier-other'], null), { type: 'member', relationships: {} }],
        meta: { pagination: { cursors: { next: null } } }
      }
    );

    const members = await httpClient.members();

    expect(members).toEqual([
      { patreonUserId: '1', tierIds: ['tier-5'], pledgeStart: '2025-01-01T00:00:00.000+00:00' },
      { patreonUserId: '2', tierIds: ['tier-10', 'tier-other'], pledgeStart: null }
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = new URL(fetch.mock.calls[0][0]);
    expect(first.pathname).toBe('/api/oauth2/v2/campaigns/test-campaign/members');
    expect(first.searchParams.get('include')).toBe('currently_entitled_tiers,user');
    expect(first.searchParams.get('fields[member]')).toBe('pledge_relationship_start');
    expect(first.searchParams.has('page[cursor]')).toBe(false);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('page[cursor]')).toBe('cursor-2');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-creator-token');
  });

  it('sends the User-Agent on every request', async () => {
    const fetch = stubFetch(
      { access_token: 'a' },
      { data: { id: '1' } },
      { data: [], meta: { pagination: { cursors: { next: null } } } }
    );

    await httpClient.identify('code');
    await httpClient.members();

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(init.headers['User-Agent']).toBe(USER_AGENT);
    }
  });

  it('throws, and reads no identity, when the exchange sends no access token', async () => {
    const fetch = stubFetch({ error: 'invalid_grant' });

    await expect(httpClient.identify('code')).rejects.toThrow('no access token');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await expect(httpClient.identify('code')).rejects.toThrow('401');
    await expect(httpClient.members()).rejects.toThrow('401');
  });

  it('is the only server code that names Patreon', () => {
    const naming = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'storage') walk(full);
        } else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('patreon.com')) {
          naming.push(path.relative(SRC, full).replace(/\\/g, '/'));
        }
      }
    };

    walk(SRC);

    expect(naming).toEqual(['utils/patreon.js']);
  });
});
