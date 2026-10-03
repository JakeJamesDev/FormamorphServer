const {
  PATREON_CLIENT_ID, PATREON_CLIENT_SECRET, PATREON_REDIRECT_URI, PATREON_CREATOR_ACCESS_TOKEN, PATREON_CAMPAIGN_ID
} = require('../config/patreon');

/**
 * The one module that calls Patreon, and the seam a test replaces.
 *
 * A client is `{ identify(code), members() }`. `identify` exchanges the OAuth code and returns only the
 * Patreon user ID, so a member's tokens never leave this file. `members` reads the whole campaign member
 * list with the creator token.
 */

const AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const API_BASE = 'https://www.patreon.com/api/oauth2/v2';

/** Patreon may drop a request without one. */
const USER_AGENT = 'Formamorph - Account Server';

/** The largest page the member list serves. */
const MEMBER_PAGE_SIZE = 1000;

const REQUEST_TIMEOUT_MS = 15000;

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
 * @throws {Error} A non-2xx answer, with Patreon's status
 */
const request = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Patreon refused ${new URL(url).pathname} (${response.status})`);
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

  members: async () => {
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
        headers: { Authorization: `Bearer ${PATREON_CREATOR_ACCESS_TOKEN}` }
      });

      for (const member of page.data || []) {
        const parsed = memberFrom(member);
        if (parsed) members.push(parsed);
      }

      cursor = page.meta?.pagination?.cursors?.next || null;
    } while (cursor);

    return members;
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
 * Every member of the campaign, read with the creator token.
 *
 * @returns {Promise<Array<{ patreonUserId: string, tierIds: string[], pledgeStart: string|null }>>} Members
 */
const listMembers = () => client.members();

module.exports = {
  authorizeUrl,
  identifyMember,
  listMembers,
  memberFrom,
  setPatreonClient,
  resetPatreonClient,
  httpClient,
  USER_AGENT
};
