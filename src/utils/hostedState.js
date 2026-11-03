const Policy = require('../models/Policy');
const PatreonLink = require('../models/PatreonLink');
const HostedGrant = require('../models/HostedGrant');
const HostedUsage = require('../models/HostedUsage');
const { TIER_KEYS, MICROS_PER_DOLLAR, PROMPT_TYPES, PLEDGE_CONFIRMED_MS } = require('../config/hostedAi');
const { weekStart, resetAt } = require('./hostedMeter');
const { pauseState } = require('./hostedPause');

/**
 * What an account has of Formamorph AI right now, and how much of its week is left.
 *
 * Nothing here returns a dollar amount to a caller that sends it to a player: `usageOf` speaks in percent
 * and turns.
 */

const rank = (tier) => TIER_KEYS.indexOf(tier);

/** Whether the account's age-gate acceptance is current. Anything unreadable counts as not accepted. */
const ageConfirmed = (userId) => {
  try {
    return Policy.hasAccepted(Policy.AGE_GATE, userId);
  } catch {
    return false;
  }
};

const linkOf = (userId) => {
  try {
    return PatreonLink.findByUser(userId);
  } catch {
    return null;
  }
};

/** Whether Patreon confirmed the link within the cutoff. A null or unreadable `checked_at` is not confirmed. */
const isConfirmed = (link, now) => {
  const checked = Date.parse(link.checked_at);
  return Number.isFinite(checked) && now.getTime() - checked <= PLEDGE_CONFIRMED_MS;
};

/**
 * The tier of a pledge that holds one but that Patreon has not confirmed within the cutoff, or null.
 *
 * @param {string} userId - The account
 * @param {Date} [now] - The instant, for tests
 * @returns {string|null}
 */
const unconfirmedTier = (userId, now = new Date()) => {
  const link = linkOf(userId);
  return link && rank(link.tier) >= 0 && !isConfirmed(link, now) ? link.tier : null;
};

/**
 * The tier an account is entitled to and the spend subject that pays for it, or null.
 *
 * A confirmed pledge and live grants all count and the highest tier wins. On a tie the pledge wins, so a
 * grant that only repeats the pledge never moves the week's spend to another subject.
 *
 * @param {string} userId - The account
 * @param {Date} [now] - The instant, for tests
 * @returns {{ subject: string, tier: string, source: 'pledge'|'grant' }|null}
 */
const entitlement = (userId, now = new Date()) => {
  let best = null;

  const link = linkOf(userId);
  if (link && rank(link.tier) >= 0 && isConfirmed(link, now)) {
    best = { subject: link.patreon_user_id, tier: link.tier, source: 'pledge' };
  }

  for (const grant of HostedGrant.liveFor(userId, now)) {
    if (!best || rank(grant.tier) > rank(best.tier)) {
      best = { subject: HostedGrant.subjectOf(grant.id), tier: grant.tier, source: 'grant' };
    }
  }

  return best;
};

/**
 * Percent of the week used and about how many turns are left.
 *
 * Turns left divides what remains by the subject's average cost per recent turn, grouped by turn id, over turns
 * with a narration call. With fewer settled turns than the minimum it uses the tier's fallback cost, and with neither it is null.
 *
 * @param {string} subject - The spend subject
 * @param {Object} config - `{ limits, turnSample }` from the active config
 * @param {Date} now - The instant
 * @returns {{ percentUsed: number, turnsLeft: number|null, resetAt: string, exhausted: boolean }}
 */
const usageOf = (subject, config, now) => {
  const budget = Math.round(config.limits.budget * MICROS_PER_DOLLAR);
  const spent = HostedUsage.spendSince(subject, weekStart(now));
  const exhausted = spent >= budget;

  let perTurn = null;
  if (config.turnSample) {
    const costs = HostedUsage.recentTurnCosts(subject, config.turnSample.recent);
    if (costs.length >= config.turnSample.min) perTurn = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  }
  if (!(perTurn > 0) && config.limits.turnCost) perTurn = config.limits.turnCost * MICROS_PER_DOLLAR;

  return {
    percentUsed: exhausted ? 100 : Math.floor((spent * 100) / budget),
    turnsLeft: perTurn > 0 ? Math.floor(Math.max(0, budget - spent) / perTurn) : null,
    resetAt: resetAt(now),
    exhausted
  };
};

/**
 * Each prompt type's share of the subject's cost this week, as a percent with one decimal.
 *
 * Costs include open rows. A missing or unknown type counts as `other`.
 *
 * @param {string} subject - The spend subject
 * @param {Date} now - The instant
 * @param {boolean} [listAll] - List every type, zero included, with `other` last; else only types with a share
 * @returns {Object<string, number>} Type to percent; empty for a week with no spend
 */
const breakdownOf = (subject, now, listAll = false) => {
  const costs = new Map();
  for (const { promptType, costMicros } of HostedUsage.costByType(subject, weekStart(now))) {
    const key = PROMPT_TYPES.includes(promptType) ? promptType : 'other';
    costs.set(key, (costs.get(key) || 0) + costMicros);
  }
  const total = [...costs.values()].reduce((sum, cost) => sum + cost, 0);
  const keys = listAll ? [...PROMPT_TYPES, 'other'] : [...costs.keys()];
  const shares = {};
  for (const key of keys) {
    const share = total > 0 ? Math.round(((costs.get(key) || 0) * 1000) / total) / 10 : 0;
    if (listAll || share > 0) shares[key] = share;
  }

  return shares;
};

/** The week's UTC Monday as `YYYY-MM-DD`: the key a warning acknowledgment is kept under. */
const weekKey = (now) => weekStart(now).slice(0, 10);

/**
 * The hosted state an account reads.
 *
 * The state is `paused` when `config` is null, as the proxy then answers `service_paused`, and while the
 * day's pause holds.
 *
 * @param {Object} user - The signed-in account
 * @param {Object|null} config - The active config for the account's tier
 * @param {Object|null} owned - What `entitlement` returned
 * @param {Date} now - The instant
 * @returns {Object}
 */
const hostedState = (user, config, owned, now) => {
  const empty = {
    tier: owned ? owned.tier : null, state: null, window: null, maxTokens: null, tokenMargin: null, model: null,
    percentUsed: null, turnsLeft: null, resetAt: null, warnThresholds: null, breakdown: null, breakdownThreshold: null, acknowledged: []
  };
  if (!ageConfirmed(user.id)) return { ...empty, state: 'age-gate' };
  if (!owned) {
    const held = unconfirmedTier(user.id, now);
    return held ? { ...empty, tier: held, state: 'unconfirmed' } : { ...empty, state: 'locked' };
  }
  if (!config) return { ...empty, state: 'paused' };

  const usage = usageOf(owned.subject, config, now);
  const thresholds = config.warnThresholds;
  let state = 'ready';
  // The daily pause refuses a first call before the budget does.
  if (pauseState(now).paused) state = 'paused';
  else if (usage.exhausted) state = 'exhausted';
  else if (thresholds.length > 0 && usage.percentUsed >= thresholds[0]) state = 'warned';

  return {
    ...empty,
    state,
    window: config.limits.window,
    maxTokens: config.maxTokensCap,
    tokenMargin: config.margin,
    model: { id: config.entry.id, capabilities: config.entry.capabilities || {} },
    percentUsed: usage.percentUsed,
    turnsLeft: usage.turnsLeft,
    resetAt: usage.resetAt,
    warnThresholds: thresholds,
    breakdown: breakdownOf(owned.subject, now),
    breakdownThreshold: config.breakdownThreshold,
    acknowledged: HostedGrant.acknowledged(user.id, weekKey(now))
  };
};

module.exports = { ageConfirmed, entitlement, unconfirmedTier, usageOf, breakdownOf, hostedState, weekKey };
