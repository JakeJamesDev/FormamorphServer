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

/**
 * The tier and pledge start a member gives a link. The pledge start counts only with a tier.
 *
 * @param {{ tierIds: string[], pledgeStart: string|null }|null} member - A parsed member, or null for none
 * @returns {{ tier: string|null, pledgeStart: string|null }} No tier and no pledge start for no member
 */
const tierStateOf = (member) => {
  const tier = member ? tierFor(member.tierIds) : null;
  return { tier, pledgeStart: tier ? member.pledgeStart : null };
};

/** How long a member has to approve on Patreon before the signed `state` runs out. */
const LINK_STATE_TTL_MS = HOUR_MS / 6;

/** How long the account page has to confirm an approval. */
const PENDING_LINK_TTL_MS = HOUR_MS / 6;

/** The secret Patreon signs each webhook with, read per call. Empty when unset. */
const patreonWebhookSecret = () => process.env.PATREON_WEBHOOK_SECRET || '';

/** Webhook triggers whose payload carries the member's current tiers. */
const WEBHOOK_TIER_TRIGGERS = new Set([
  'members:create', 'members:update', 'members:pledge:create', 'members:pledge:update'
]);

/** Webhook triggers that end the tier, whatever tiers the payload still lists. */
const WEBHOOK_ENDING_TRIGGERS = new Set(['members:delete', 'members:pledge:delete']);

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
  tierStateOf,
  LINK_STATE_TTL_MS,
  PENDING_LINK_TTL_MS,
  LINK_RESULTS,
  patreonWebhookSecret,
  WEBHOOK_TIER_TRIGGERS,
  WEBHOOK_ENDING_TRIGGERS
};
