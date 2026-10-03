/**
 * The Patreon link: its configuration, its tier rule, and the names its routes answer with.
 *
 * Every value is an environment value. A server without the client, the creator token, or the campaign
 * refuses to start a link rather than send a member to a flow that cannot finish.
 */

const { HOUR_MS } = require('./time');

const PATREON_CLIENT_ID = process.env.PATREON_CLIENT_ID || '';
const PATREON_CLIENT_SECRET = process.env.PATREON_CLIENT_SECRET || '';
const PATREON_REDIRECT_URI = process.env.PATREON_REDIRECT_URI || '';
const PATREON_CREATOR_ACCESS_TOKEN = process.env.PATREON_CREATOR_ACCESS_TOKEN || '';
const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID || '';

/** The two tiers, as stored and as sent. */
const SUPPORTER = 'supporter';
const SUPPORTER_PLUS = 'supporter_plus';

/** Patreon tier ID to our tier, highest first. An unset ID maps nothing. */
const TIER_MAP = [
  [process.env.PATREON_SUPPORTER_PLUS_TIER_ID, SUPPORTER_PLUS],
  [process.env.PATREON_SUPPORTER_TIER_ID, SUPPORTER]
].filter(([id]) => Boolean(id));

/** Whether this server can run a link from start to finish. */
const patreonConfigured = () => Boolean(
  PATREON_CLIENT_ID && PATREON_CLIENT_SECRET && PATREON_REDIRECT_URI
    && PATREON_CREATOR_ACCESS_TOKEN && PATREON_CAMPAIGN_ID
);

/**
 * The highest mapped tier among the tiers Patreon says a member is entitled to.
 *
 * @param {string[]} tierIds - Patreon tier IDs from `currently_entitled_tiers`
 * @returns {string|null} `SUPPORTER_PLUS`, `SUPPORTER`, or null when no ID is mapped
 */
const tierFor = (tierIds) => {
  const held = new Set(tierIds);
  const match = TIER_MAP.find(([id]) => held.has(id));

  return match ? match[1] : null;
};

/** How long a member has to approve on Patreon before the signed `state` runs out. */
const LINK_STATE_TTL_MS = HOUR_MS / 6;

/** How long the account page has to confirm an approval. */
const PENDING_LINK_TTL_MS = HOUR_MS / 6;

/** What the callback tells the site's account page, as `?patreon=<result>`. `CONFIRM` carries `&token=`. */
const LINK_RESULTS = Object.freeze({
  CONFIRM: 'confirm',
  TAKEN: 'taken',
  DENIED: 'denied',
  EXPIRED: 'expired',
  FAILED: 'failed'
});

module.exports = {
  PATREON_CLIENT_ID,
  PATREON_CLIENT_SECRET,
  PATREON_REDIRECT_URI,
  PATREON_CREATOR_ACCESS_TOKEN,
  PATREON_CAMPAIGN_ID,
  SUPPORTER,
  SUPPORTER_PLUS,
  patreonConfigured,
  tierFor,
  LINK_STATE_TTL_MS,
  PENDING_LINK_TTL_MS,
  LINK_RESULTS
};
