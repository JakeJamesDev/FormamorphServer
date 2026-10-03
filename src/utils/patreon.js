const {
  PATREON_CLIENT_ID, PATREON_CLIENT_SECRET, PATREON_REDIRECT_URI, PATREON_CREATOR_ACCESS_TOKEN,
  PATREON_CREATOR_REFRESH_TOKEN, PATREON_CAMPAIGN_ID
} = require('../config/patreon');
const { PATREON_CREATOR_TOKENS } = require('../config/settings');
const { DAY_MS } = require('../config/time');
const Setting = require('../models/Setting');

/**
 * The one module that calls Patreon, and the seam a test replaces.
 *
 * A client is `{ identify(code), members(accessToken), refresh(refreshToken) }`. `identify` exchanges the
 * OAuth code and returns only the Patreon user ID, so a member's tokens never leave this file. `members`
 * reads the whole campaign member list. `refresh` trades the creator refresh token for a new pair. The
 * creator token pair is kept above the seam, so a fake client runs the same refresh rules.
 */

/** Thrown when Patreon answers 401: the token is expired or revoked. */
class PatreonAuthError extends Error {}

const AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const API_BASE = 'https://www.patreon.com/api/oauth2/v2';

/** Patreon may drop a request without one. */
const USER_AGENT = 'Formamorph - Account Server';

/** The largest page the member list serves. */
const MEMBER_PAGE_SIZE = 1000;

const REQUEST_TIMEOUT_MS = 15000;

/** How long before its expiry the creator token is refreshed. The hourly reconcile reads well inside it. */
const TOKEN_REFRESH_MARGIN_MS = DAY_MS;

/**
 * Patreon's approval page for a member, with only the `identity` scope.
 *
 * @param {string} state - The signed state the callback verifies
 * @returns {string} The URL to send the member to
 */
const authorizeUrl = (state) => `${AUTHORIZE_URL}?${new URLSearchParams({
  response_type: 'code',
  client_id: PATREON_CLIENT_ID,
  redirect_uri: PATREON_REDIRECT_URI,
  scope: 'identity',
  state
})}`;

/**
 * One request to Patreon, answered as JSON.
 *
 * @param {string} url - The full URL
 * @param {Object} [init] - fetch options; the User-Agent is added here
 * @returns {Promise<Object>} The parsed body
 * @throws {PatreonAuthError} A 401 answer
 * @throws {Error} Any other non-2xx answer, with Patreon's status
 */
const request = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const message = `Patreon refused ${new URL(url).pathname} (${response.status})`;
    throw response.status === 401 ? new PatreonAuthError(message) : new Error(message);
  }

  return response.json();
};

/**
 * One member resource, from a member-list page or a webhook body, in our shape.
 *
 * @param {Object} member - A JSON:API member resource
 * @returns {{ patreonUserId: string, tierIds: string[], pledgeStart: string|null }|null} Null without a user
 */
const memberFrom = (member) => {
  const patreonUserId = member.relationships?.user?.data?.id;
  if (!patreonUserId) return null;

  return {
    patreonUserId: String(patreonUserId),
    tierIds: (member.relationships?.currently_entitled_tiers?.data || []).map((tier) => String(tier.id)),
    pledgeStart: member.attributes?.pledge_relationship_start || null
  };
};

/** The client that talks to Patreon. */
const httpClient = {
  identify: async (code) => {
    const tokens = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: PATREON_CLIENT_ID,
        client_secret: PATREON_CLIENT_SECRET,
        redirect_uri: PATREON_REDIRECT_URI
      }).toString()
    });

    if (!tokens?.access_token) throw new Error('Patreon sent no access token');

    const identity = await request(`${API_BASE}/identity`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    const id = identity?.data?.id;
    if (!id) throw new Error('Patreon sent an identity with no user ID');

    return String(id);
  },

  members: async (accessToken) => {
    const members = [];
    let cursor = null;

    do {
      const query = new URLSearchParams({
        include: 'currently_entitled_tiers,user',
        'fields[member]': 'pledge_relationship_start',
        'page[count]': String(MEMBER_PAGE_SIZE)
      });
      if (cursor) query.set('page[cursor]', cursor);

      const page = await request(`${API_BASE}/campaigns/${PATREON_CAMPAIGN_ID}/members?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      for (const member of page.data || []) {
        const parsed = memberFrom(member);
        if (parsed) members.push(parsed);
      }

      cursor = page.meta?.pagination?.cursors?.next || null;
    } while (cursor);

    return members;
  },

  refresh: async (refreshToken) => {
    const tokens = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: PATREON_CLIENT_ID,
        client_secret: PATREON_CLIENT_SECRET
      }).toString()
    });

    if (!tokens?.access_token) throw new Error('Patreon sent no access token');

    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in };
  }
};

let client = httpClient;

/** Put a client in place of the real one. Tests only. */
const setPatreonClient = (replacement) => { client = replacement; };

/** Put the real client back. */
const resetPatreonClient = () => { client = httpClient; };

/**
 * Exchange an OAuth code for the Patreon user ID behind it. The member's tokens are dropped here.
 *
 * @param {string} code - The single-use code from the callback
 * @returns {Promise<string>} The Patreon user ID
 */
const identifyMember = (code) => client.identify(code);

/**
 * The creator token pair: the stored one, or the environment pair before the first refresh.
 *
 * @returns {{ accessToken: string, refreshToken: string, expiresAt: string|null }} The pair to read with
 */
const creatorTokens = () => Setting.get(PATREON_CREATOR_TOKENS) || {
  accessToken: PATREON_CREATOR_ACCESS_TOKEN,
  refreshToken: PATREON_CREATOR_REFRESH_TOKEN,
  expiresAt: null
};

// One refresh at a time: Patreon may retire a refresh token once it is used.
let refreshing = null;

/**
 * Trade the refresh token for a new pair and store it, so the pair survives a restart.
 *
 * @param {{ refreshToken: string }} tokens - The pair being replaced
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: string|null }>} The new pair
 */
const refreshCreatorTokens = (tokens) => {
  refreshing ||= (async () => {
    try {
      const fresh = await client.refresh(tokens.refreshToken);
      return Setting.set(PATREON_CREATOR_TOKENS, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || tokens.refreshToken,
        expiresAt: Number.isFinite(fresh.expiresIn) ? new Date(Date.now() + fresh.expiresIn * 1000).toISOString() : null
      });
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
};

// An unknown expiry (the environment pair) refreshes too, which stores the pair and learns its expiry.
const needsRefresh = ({ expiresAt }) => !expiresAt || Date.parse(expiresAt) - Date.now() < TOKEN_REFRESH_MARGIN_MS;

/**
 * The pair to read with, refreshed ahead of its expiry. A failed early refresh keeps the current pair,
 * which still works until Patreon refuses it.
 *
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: string|null }>} The pair
 */
const readyCreatorTokens = async () => {
  const tokens = creatorTokens();
  if (!needsRefresh(tokens)) return tokens;

  try {
    return await refreshCreatorTokens(tokens);
  } catch (error) {
    console.error('Patreon creator token refresh failed:', error);
    return tokens;
  }
};

/**
 * Every member of the campaign, read with the creator token. The token is refreshed ahead of its expiry,
 * and once on a refusal before the read is retried.
 *
 * @returns {Promise<Array<{ patreonUserId: string, tierIds: string[], pledgeStart: string|null }>>} Members
 */
const listMembers = async () => {
  let tokens = await readyCreatorTokens();

  try {
    return await client.members(tokens.accessToken);
  } catch (error) {
    if (!(error instanceof PatreonAuthError)) throw error;
    // A read that failed alongside a finished refresh retries with the new pair instead of refreshing again.
    const current = creatorTokens();
    tokens = current.accessToken !== tokens.accessToken ? current : await refreshCreatorTokens(current);
    return client.members(tokens.accessToken);
  }
};

module.exports = {
  PatreonAuthError,
  authorizeUrl,
  identifyMember,
  listMembers,
  memberFrom,
  setPatreonClient,
  resetPatreonClient,
  httpClient,
  USER_AGENT
};
