const Policy = require('../models/Policy');
const PatreonLink = require('../models/PatreonLink');
const HostedGrant = require('../models/HostedGrant');
const HostedUsage = require('../models/HostedUsage');
const { TIER_KEYS, MICROS_PER_DOLLAR } = require('../config/hostedAi');
const { monthStart, resetAt } = require('./hostedMeter');
const { pauseState } = require('./hostedPause');

/**
 * What an account has of Formamorph AI right now, and how much of its month is left.
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

/**
 * The tier an account is entitled to and the spend subject that pays for it, or null.
 *
 * A live pledge and live grants all count and the highest tier wins. On a tie the pledge wins, so a grant
 * that only repeats the pledge never moves the month's spend to another subject.
 *
 * @param {string} userId - The account
 * @param {Date} [now] - The instant, for tests
 * @returns {{ subject: string, tier: string, source: 'pledge'|'grant' }|null}
 */
const entitlement = (userId, now = new Date()) => {
  let best = null;

  let link = null;
  try {
    link = PatreonLink.findByUser(userId);
  } catch {
    link = null;
  }
  if (link && rank(link.tier) >= 0) best = { subject: link.patreon_user_id, tier: link.tier, source: 'pledge' };

  for (const grant of HostedGrant.liveFor(userId, now)) {
    if (!best || rank(grant.tier) > rank(best.tier)) {
      best = { subject: HostedGrant.subjectOf(grant.id), tier: grant.tier, source: 'grant' };
    }
  }

  return best;
};

/**
 * Percent of the month used and about how many turns are left.
 *
 * Turns left divides what remains by the subject's average cost per recent turn, grouped by turn id. With
 * fewer settled turns than the minimum it uses the tier's fallback cost, and with neither it is null.
 *
 * @param {string} subject - The spend subject
 * @param {Object} config - `{ limits, turnSample }` from the active config
 * @param {Date} now - The instant
 * @returns {{ percentUsed: number, turnsLeft: number|null, resetAt: string, exhausted: boolean }}
 */
const usageOf = (subject, config, now) => {
  const budget = Math.round(config.limits.budget * MICROS_PER_DOLLAR);
  const spent = HostedUsage.spendSince(subject, monthStart(now));
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

/** `YYYY-MM` of the UTC month an instant falls in: the key a warning acknowledgment is kept under. */
const monthKey = (now) => now.toISOString().slice(0, 7);

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
    percentUsed: null, turnsLeft: null, resetAt: null, warnThresholds: null, acknowledged: []
  };
  if (!ageConfirmed(user.id)) return { ...empty, state: 'age-gate' };
  if (!owned) return { ...empty, state: 'locked' };
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
    acknowledged: HostedGrant.acknowledged(user.id, monthKey(now))
  };
};

module.exports = { ageConfirmed, entitlement, usageOf, hostedState, monthKey };
