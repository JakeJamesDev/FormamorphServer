const { TIER_KEYS, tierRank } = require('../config/patreon');
const { isSupporterOnlyNow, TIMED_KINDS } = require('./supporterWindow');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 3650;

// Highest tier first: the order the stages run in.
const STAGES = [...TIER_KEYS].reverse();
const TOP_TIER = STAGES[0];
// The tiers a row can name: every tier below the top, which opens at publish.
const ROW_TIERS = STAGES.slice(1);

/**
 * When each tier opens, as epoch milliseconds. No rows opens every tier at publish. Otherwise each tier
 * reads its own row, and a null date is the public date, or never without one.
 *
 * @param {Object} row - A worlds row
 * @param {Array<{ tier: string, opens_at: string|null }>} rows - The listing's schedule rows
 * @returns {Object<string, number>} Tier key to opening time; Infinity for a tier that never opens
 */
const openTimes = (row, rows) => {
  if (rows.length === 0) return Object.fromEntries(STAGES.map((tier) => [tier, -Infinity]));

  const publicAt = row.supporter_until ? Date.parse(row.supporter_until) : Infinity;
  const times = { [TOP_TIER]: -Infinity };

  for (const tier of ROW_TIERS) {
    const own = rows.find((entry) => entry.tier === tier);
    times[tier] = own && own.opens_at ? Date.parse(own.opens_at) : publicAt;
  }

  return times;
};

/**
 * The lowest tier that may download a listing now, or null when the listing is public.
 *
 * @param {Object} row - A worlds row
 * @param {Array<{ tier: string, opens_at: string|null }>} rows - The listing's schedule rows
 * @param {number} [now] - Epoch milliseconds; tests inject it
 * @returns {string|null}
 */
const openTierNow = (row, rows, now = Date.now()) => {
  if (!isSupporterOnlyNow(row, now)) return null;

  const times = openTimes(row, rows);
  const open = TIER_KEYS.filter((tier) => times[tier] <= now);

  return open.length > 0 ? open[0] : TOP_TIER;
};

/**
 * Whether an account on `tier` may download a listing now. Staff and the author are the caller's concern.
 *
 * @param {string|null} tier - The account's tier key
 * @param {Object} row - A worlds row
 * @param {Array<{ tier: string, opens_at: string|null }>} rows - The listing's schedule rows
 * @param {number} [now] - Epoch milliseconds
 * @returns {{ ok: boolean, requiredTier: string|null, opensAt: string|null }} `opensAt` is when this
 *   account's own tier opens, or null when it never does
 */
const tierAdmission = (tier, row, rows, now = Date.now()) => {
  const required = openTierNow(row, rows, now);
  if (!required || tierRank(tier) >= tierRank(required)) return { ok: true, requiredTier: required, opensAt: null };

  const opens = tierRank(tier) < 0 ? Infinity : openTimes(row, rows)[tier];

  return { ok: false, requiredTier: required, opensAt: Number.isFinite(opens) ? new Date(opens).toISOString() : null };
};

/**
 * The schedule a reader sees: each row, highest tier first, passed rows included.
 *
 * @param {Array<{ tier: string, opens_at: string|null }>} rows - The listing's schedule rows
 * @returns {Array<{ tier: string, opensAt: string }>}
 */
const schedulePayload = (rows) => STAGES
  .map((tier) => rows.find((entry) => entry.tier === tier))
  .filter(Boolean)
  .map((entry) => ({ tier: entry.tier, opensAt: entry.opens_at }));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const readDays = (schedule, now) => {
  const { days, goPublic } = schedule;
  if (!isPlainObject(days)) return { error: 'supporterSchedule.days must be an object of days per tier' };
  if (typeof goPublic !== 'boolean') return { error: 'supporterSchedule.goPublic must be a boolean' };

  const stages = Object.keys(days);
  if (stages.some((tier) => !STAGES.includes(tier))) return { error: 'supporterSchedule.days names an unknown tier' };
  for (const tier of stages) {
    if (!Number.isInteger(days[tier]) || days[tier] < 1 || days[tier] > MAX_DAYS) {
      return { error: `Days for ${tier} must be a whole number from 1 to ${MAX_DAYS}` };
    }
  }
  if (stages.length === 0) return { error: 'supporterSchedule.days needs at least one stage' };

  // Every lower tier gets a row; a skipped stage's row is the date the next stage opens, null below the last stage.
  const last = STAGES.reduce((found, tier, index) => (days[tier] === undefined ? found : index), -1);
  const rows = [];
  let at = now;
  STAGES.forEach((tier, index) => {
    if (tier !== TOP_TIER) rows.push({ tier, opens_at: index > last ? null : new Date(at).toISOString() });
    if (days[tier] !== undefined) at += days[tier] * DAY_MS;
  });

  return { rows, until: goPublic ? new Date(at).toISOString() : null };
};

const readDates = (schedule, now) => {
  const { opensAt, publicAt } = schedule;
  if (!isPlainObject(opensAt)) return { error: 'supporterSchedule.opensAt must be an object of dates per tier' };
  if (publicAt === undefined) return { error: 'supporterSchedule.publicAt must be a date or null' };
  if (Object.keys(opensAt).some((tier) => !ROW_TIERS.includes(tier))) {
    return { error: 'supporterSchedule.opensAt names an unknown tier' };
  }

  // Every lower tier is named, and a null date means the public date, or never without one.
  const rows = [];
  for (const tier of ROW_TIERS) {
    if (opensAt[tier] === null) {
      rows.push({ tier, opens_at: null });
      continue;
    }
    const time = typeof opensAt[tier] === 'string' ? Date.parse(opensAt[tier]) : NaN;
    if (Number.isNaN(time)) return { error: `Opening date for ${tier} must be a date or null` };
    rows.push({ tier, opens_at: new Date(time).toISOString() });
  }

  let until = null;
  if (publicAt !== null) {
    const time = typeof publicAt === 'string' ? Date.parse(publicAt) : NaN;
    if (Number.isNaN(time)) return { error: 'supporterSchedule.publicAt must be a date or null' };
    if (time <= now) return { error: 'The public date must be in the future' };
    until = new Date(time).toISOString();
  }

  return { rows, until };
};

/**
 * No lower tier opens before a higher one, and none opens after the public date.
 *
 * @param {Array<{ tier: string, opens_at: string|null }>} rows - The new rows
 * @param {string|null} until - The new public date
 * @returns {string|null} A refusal, or null when the order holds
 */
const scheduleOrderRefusal = (rows, until) => {
  const times = openTimes({ supporter_until: until }, rows);
  const ordered = STAGES.map((tier) => times[tier]);

  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i] < ordered[i - 1]) return 'A lower tier cannot open before a higher one';
  }
  const publicAt = until ? Date.parse(until) : Infinity;
  if (rows.some((entry) => entry.opens_at && Date.parse(entry.opens_at) > publicAt)) return 'A tier cannot open after the public date';

  return null;
};

/**
 * Read a tier schedule from a request body: `supporterSchedule` in its days form (`{ days, goPublic }`,
 * counted from `now`) or its dates form (`{ opensAt, publicAt }`), or `null` to clear the rows. Absent
 * means the body says nothing about the schedule.
 *
 * @param {Object} body - The request body
 * @param {number} [now] - Epoch milliseconds
 * @returns {{ provided: boolean, rows?: Array, until?: string|null, clear?: boolean, error?: string }}
 */
const readSchedule = (body, now = Date.now()) => {
  const schedule = body ? body.supporterSchedule : undefined;
  if (schedule === undefined) return { provided: false };
  if (body.supporterDays !== undefined || body.supporterUntil !== undefined) {
    return { provided: true, error: 'Send supporterSchedule, or supporterDays or supporterUntil, not both' };
  }
  if (schedule === null) return { provided: true, clear: true, rows: [] };
  if (!isPlainObject(schedule)) return { provided: true, error: 'supporterSchedule must be an object or null' };

  const days = schedule.days !== undefined;
  const dates = schedule.opensAt !== undefined || schedule.publicAt !== undefined;
  if (days === dates) return { provided: true, error: 'Send supporterSchedule as days and goPublic, or opensAt and publicAt' };

  const read = days ? readDays(schedule, now) : readDates(schedule, now);
  if (read.error) return { provided: true, error: read.error };

  const refusal = scheduleOrderRefusal(read.rows, read.until);
  if (refusal) return { provided: true, error: refusal };

  return { provided: true, rows: read.rows, until: read.until };
};

/** The refusal for a schedule on a listing that cannot carry one. */
const scheduleRefusal = (schedule, { supporterOnly, kind }) => {
  if (schedule.error) return schedule.error;
  if (!TIMED_KINDS.includes(kind)) return 'Only a Mascot or a World can have a Supporter-only schedule';
  if (!supporterOnly) return 'A schedule needs a Supporter-only listing';

  return null;
};

/** One audit line for a schedule: each row's tier and date, then the public date. */
const scheduleSnippet = (rows, until) => [
  ...rows.map((entry) => `${entry.tier}=${entry.opens_at || 'public'}`),
  `public=${until || 'none'}`
].join(' ');

module.exports = {
  tierAdmission,
  schedulePayload,
  readSchedule,
  scheduleRefusal,
  scheduleSnippet,
  scheduleOrderRefusal
};
