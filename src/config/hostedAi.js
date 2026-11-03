/**
 * Formamorph AI: the hosted chat-completions proxy for entitled Supporters.
 *
 * The upstream URL, its key and the `user` HMAC secret are environment values, read per call. Everything
 * an admin tunes lives in one admin-only setting. No window, price or provider name lives in this repo.
 */

const { SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP } = require('./patreon');

/** Where the proxy is mounted. Clients append `/chat/completions`, as with any compatible endpoint. */
const HOSTED_AI_PATH = '/api/hosted-ai';

/** The admin-only setting that holds the approved models and the proxy's limits. */
const HOSTED_AI = 'hosted_ai';

/** Internal: whether the low provider balance alert has gone out since the balance was last above the threshold. */
const HOSTED_BALANCE_ALERTED = 'hosted_ai_balance_alerted';

/** Above the largest window with JSON escaping and tool schemas on top. Caddy's cap must allow it. */
const HOSTED_BODY_LIMIT = '8mb';

/** How long a pledge stays entitled after Patreon last confirmed it. */
const PLEDGE_CONFIRMED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every refusal the proxy answers with, by code. The client mirrors this list.
 *
 * `CLIENT_UPDATE_REQUIRED` and the `protect` refusals are the server's existing ones and are not here.
 */
const REFUSALS = Object.freeze({
  invalid_request: { status: 400, error: 'The request is not a chat completion this server can send.' },
  age_gate_required: { status: 403, error: 'Confirm you are 18 or older to use Formamorph AI.' },
  not_entitled: { status: 403, error: 'Formamorph AI is part of a Supporter pledge on Patreon.' },
  pledge_unconfirmed: { status: 403, error: "We can't confirm your Patreon pledge right now. Formamorph AI will work again as soon as we can." },
  service_paused: { status: 503, error: 'Formamorph AI is paused. Try again later.' },
  rate_limited: { status: 429, error: 'Too many requests. Wait a moment and try again.' },
  turn_expired: { status: 409, error: 'This turn has ended. Start a new turn.' },
  budget_exhausted: { status: 402, error: 'Your Formamorph AI allowance for this week is used up.' },
  window_exceeded: { status: 413, error: 'This prompt is longer than your Formamorph AI window.' },
  image_not_supported: { status: 400, error: 'Formamorph AI does not accept images.' },
  upstream_error: { status: 502, error: 'The AI provider did not answer. Try again.' }
});

const REFUSAL_CODES = Object.freeze(Object.keys(REFUSALS));

/**
 * The refusal body in the server's error shape.
 *
 * @param {string} code - A key of `REFUSALS`
 * @returns {{ success: false, code: string, error: string }}
 */
const refusalBody = (code) => ({ success: false, code, error: REFUSALS[code].error });

/** The numeric sampler fields that reach upstream. */
const SAMPLER_FIELDS = Object.freeze([
  'temperature', 'top_p', 'top_k', 'min_p', 'top_a',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'
]);

/** Read per call, so a test or a restart with a new env takes effect without a reload. */
const upstreamUrl = () => process.env.HOSTED_AI_UPSTREAM_URL || '';
const upstreamKey = () => process.env.HOSTED_AI_API_KEY || '';
const userSecret = () => process.env.HOSTED_AI_USER_SECRET || '';
const balanceUrl = () => process.env.HOSTED_AI_BALANCE_URL || '';
const usageUrl = () => process.env.HOSTED_AI_USAGE_URL || '';
const staffAlertEmail = () => process.env.STAFF_ALERT_EMAIL || '';

/** The warning percents used while the setting holds none, so `warned` is always reachable. */
const DEFAULT_WARN_THRESHOLDS = Object.freeze([75, 90]);

/** The warning percents in force for a `hosted_ai` setting value: its own list, else the default. */
const warnThresholdsOf = (settings) => (
  Array.isArray(settings?.warnThresholds) && settings.warnThresholds.length > 0
    ? settings.warnThresholds
    : [...DEFAULT_WARN_THRESHOLDS]
);

/** The request header that carries a turn id, both ways. */
const TURN_HEADER = 'X-Formamorph-Turn';

/** The request header that carries a call's prompt type. It never goes upstream. */
const PROMPT_TYPE_HEADER = 'X-Formamorph-Prompt-Type';

/** Every prompt type a usage row can record. */
const PROMPT_TYPES = Object.freeze([
  'narration',
  'thinking', 'director', 'character', 'storyboard',
  'choices',
  'statUpdates', 'locationChange', 'entityLocation', 'discoverEntity', 'timePassed', 'openingTime', 'sceneTags',
  'inventory',
  'summary', 'milestoneSelect', 'diary',
  'help', 'descriptionSummary', 'descriptionBridge', 'imageTags'
]);

/** The stored type for a header value: a known type, else null. */
const promptTypeOf = (value) => (PROMPT_TYPES.includes(value) ? value : null);

/** The share, in percent, at which the client names a single prompt under its group. */
const DEFAULT_BREAKDOWN_THRESHOLD = 10;

/** The breakdown threshold in force for a `hosted_ai` setting value: its own, else the default. */
const breakdownThresholdOf = (settings) => settings?.breakdownThreshold ?? DEFAULT_BREAKDOWN_THRESHOLD;

/** The response header that carries the usage state on a non-streamed call. */
const USAGE_HEADER = 'X-Formamorph-Usage';

/** Model prices are dollars per million tokens, so tokens times a price is micro-dollars. */
const MICROS_PER_DOLLAR = 1_000_000;

/** The tiers Formamorph AI serves, each with its own window and budget. */
const TIER_KEYS = Object.freeze([SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP]);
const INTEGER_LIMITS = [
  'maxTokensCap', 'idleLimitSeconds', 'turnLimitSeconds', 'turnCallCap', 'retentionDays', 'parallelLimit', 'perMinuteLimit'
];
/** Usage rows must outlive the week that sums them. */
const MIN_RETENTION_DAYS = 7;
/** Dollar amounts: the daily ceiling over all spend, and the provider balance that raises an alert. */
const DOLLAR_LIMITS = ['dailyCeiling', 'balanceThreshold'];

const MAX_MODELS = 20;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isOptionalObject = (value) => value === undefined || value === null || isPlainObject(value);

/**
 * Why one approved-model entry cannot be stored, or null.
 *
 * @param {*} entry - One element of `models`
 * @returns {string|null}
 */
const validateModel = (entry) => {
  if (!isPlainObject(entry)) return 'Each model must be an object';
  const allowed = ['id', 'model', 'routing', 'reasoning', 'prices', 'capabilities'];
  const unknown = Object.keys(entry).find((key) => !allowed.includes(key));
  if (unknown) return `Models have no field "${unknown}"`;
  if (typeof entry.id !== 'string' || !MODEL_ID.test(entry.id)) return 'Each model needs an id';
  if (typeof entry.model !== 'string' || !MODEL_ID.test(entry.model)) return `"${entry.id}" needs an upstream model id`;
  for (const key of ['routing', 'reasoning', 'prices', 'capabilities']) {
    if (!isOptionalObject(entry[key])) return `"${entry.id}" ${key} must be an object`;
  }
  if (entry.prices && Object.values(entry.prices).some((price) => typeof price !== 'number' || !(price >= 0))) {
    return `"${entry.id}" prices must be numbers of zero or more`;
  }

  return null;
};

/**
 * Why a hosted settings value cannot be stored, or null.
 *
 * Exactly one entry is active while any exist, so a write that drops the active entry is refused.
 *
 * @param {*} value - What the admin sent
 * @returns {string|null}
 */
const validateHostedAi = (value) => {
  if (!isPlainObject(value)) return 'Hosted AI settings must be an object';
  const allowed = [
    'models', 'activeModel', 'tiers', 'tokenRatio', 'tokenMargin', 'warnThresholds', 'turnSample', 'breakdownThreshold', ...INTEGER_LIMITS, ...DOLLAR_LIMITS
  ];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) return `Hosted AI settings have no field "${unknown}"`;

  if (!Array.isArray(value.models)) return 'models must be a list';
  if (value.models.length > MAX_MODELS) return `At most ${MAX_MODELS} models may be approved`;
  for (const entry of value.models) {
    const problem = validateModel(entry);
    if (problem) return problem;
  }
  const ids = value.models.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) return 'Each model id must be unique';

  if (value.models.length > 0 && !ids.includes(value.activeModel)) {
    return `The active model "${value.activeModel}" is not in the approved list`;
  }
  if (value.models.length === 0 && value.activeModel !== null) return 'With no models, the active model is null';

  for (const key of INTEGER_LIMITS) {
    if (value[key] !== null && !isPositiveInteger(value[key])) return `${key} must be a whole number above zero`;
  }
  if (value.retentionDays !== null && value.retentionDays < MIN_RETENTION_DAYS) {
    return `retentionDays must be at least ${MIN_RETENTION_DAYS}`;
  }
  for (const key of DOLLAR_LIMITS) {
    if (value[key] !== null && !(typeof value[key] === 'number' && value[key] >= 0)) return `${key} must be zero or more`;
  }
  if (value.dailyCeiling === 0) return 'dailyCeiling must be above zero';
  if (value.tokenRatio !== null && !(typeof value.tokenRatio === 'number' && value.tokenRatio > 0)) {
    return 'tokenRatio must be a number above zero';
  }
  if (value.tokenMargin !== null && !(Number.isInteger(value.tokenMargin) && value.tokenMargin >= 0)) {
    return 'tokenMargin must be a whole number of zero or more';
  }

  return validateWarnings(value) || validateTiers(value.tiers);
};

/** Why a warning, turn sample or breakdown setting cannot be stored, or null. Each may be absent or null. */
const validateWarnings = ({ warnThresholds, turnSample, breakdownThreshold }) => {
  if (warnThresholds !== undefined && warnThresholds !== null) {
    const valid = Array.isArray(warnThresholds) && warnThresholds.length <= 5
      && warnThresholds.every((percent, i) => Number.isInteger(percent) && percent > 0 && percent < 100
        && (i === 0 || percent > warnThresholds[i - 1]));
    if (!valid) return 'warnThresholds must be a rising list of whole percents between 1 and 99';
  }
  if (turnSample !== undefined && turnSample !== null) {
    if (!isPlainObject(turnSample) || Object.keys(turnSample).some((field) => !['recent', 'min'].includes(field))
      || !isPositiveInteger(turnSample.recent) || !isPositiveInteger(turnSample.min) || turnSample.min > turnSample.recent) {
      return 'turnSample holds recent and min, whole numbers above zero, with min no more than recent';
    }
  }

  if (breakdownThreshold !== undefined && breakdownThreshold !== null
    && !(Number.isInteger(breakdownThreshold) && breakdownThreshold >= 1 && breakdownThreshold <= 100)) {
    return 'breakdownThreshold must be a whole percent between 1 and 100';
  }

  return null;
};

/** Why a `tiers` value cannot be stored, or null. A budget is dollars per week and a turn cost is dollars. */
const validateTiers = (tiers) => {
  if (!isPlainObject(tiers)) return 'tiers must be an object';
  for (const [key, tier] of Object.entries(tiers)) {
    if (!TIER_KEYS.includes(key)) return `There is no tier "${key}"`;
    if (!isPlainObject(tier) || Object.keys(tier).some((field) => !['window', 'budget', 'turnCost'].includes(field))) {
      return `Tier "${key}" holds only window, budget and turnCost`;
    }
    if (!isPositiveInteger(tier.window)) return `Tier "${key}" window must be a whole number above zero`;
    if (typeof tier.budget !== 'number' || !(tier.budget >= 0)) return `Tier "${key}" budget must be zero or more`;
    if (tier.turnCost !== undefined && tier.turnCost !== null && !(typeof tier.turnCost === 'number' && tier.turnCost > 0)) {
      return `Tier "${key}" turnCost must be a number above zero`;
    }
  }

  return null;
};

/** No model and no limits until an admin writes them, so an unconfigured proxy refuses every call. */
const HOSTED_AI_DEFAULT = Object.freeze({
  models: [],
  activeModel: null,
  maxTokensCap: null,
  idleLimitSeconds: null,
  tiers: {},
  tokenRatio: null,
  tokenMargin: null,
  turnLimitSeconds: null,
  turnCallCap: null,
  retentionDays: null,
  warnThresholds: null,
  turnSample: null,
  breakdownThreshold: null,
  parallelLimit: null,
  perMinuteLimit: null,
  dailyCeiling: null,
  balanceThreshold: null
});

module.exports = {
  isPlainObject,
  HOSTED_AI_PATH,
  HOSTED_AI,
  HOSTED_AI_DEFAULT,
  HOSTED_BALANCE_ALERTED,
  HOSTED_BODY_LIMIT,
  PLEDGE_CONFIRMED_MS,
  DEFAULT_WARN_THRESHOLDS,
  warnThresholdsOf,
  PROMPT_TYPE_HEADER,
  PROMPT_TYPES,
  promptTypeOf,
  DEFAULT_BREAKDOWN_THRESHOLD,
  breakdownThresholdOf,
  MICROS_PER_DOLLAR,
  TIER_KEYS,
  TURN_HEADER,
  USAGE_HEADER,
  REFUSALS,
  REFUSAL_CODES,
  refusalBody,
  SAMPLER_FIELDS,
  upstreamUrl,
  upstreamKey,
  userSecret,
  balanceUrl,
  usageUrl,
  staffAlertEmail,
  validateHostedAi
};
