/**
 * Formamorph AI: the hosted chat-completions proxy for entitled Supporters.
 *
 * The upstream URL, its key and the `user` HMAC secret are environment values, read per call. Everything
 * an admin tunes lives in one admin-only setting. No window, price or provider name lives in this repo.
 */

/** Where the proxy is mounted. Clients append `/chat/completions`, as with any compatible endpoint. */
const HOSTED_AI_PATH = '/api/hosted-ai';

/** The admin-only setting that holds the approved models and the proxy's limits. */
const HOSTED_AI = 'hosted_ai';

/** Above the largest window with JSON escaping and tool schemas on top. Caddy's cap must allow it. */
const HOSTED_BODY_LIMIT = '8mb';

/**
 * Every refusal the proxy answers with, by code. The client mirrors this list.
 *
 * `CLIENT_UPDATE_REQUIRED` and the `protect` refusals are the server's existing ones and are not here.
 */
const REFUSALS = Object.freeze({
  invalid_request: { status: 400, error: 'The request is not a chat completion this server can send.' },
  age_gate_required: { status: 403, error: 'Confirm you are 18 or older to use Formamorph AI.' },
  not_entitled: { status: 403, error: 'Formamorph AI is part of a Supporter pledge on Patreon.' },
  service_paused: { status: 503, error: 'Formamorph AI is paused. Try again later.' },
  rate_limited: { status: 429, error: 'Too many requests. Wait a moment and try again.' },
  turn_expired: { status: 409, error: 'This turn has ended. Start a new turn.' },
  budget_exhausted: { status: 402, error: 'Your Formamorph AI allowance for this month is used up.' },
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
  const allowed = ['models', 'activeModel', 'maxTokensCap', 'idleLimitSeconds'];
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

  for (const key of ['maxTokensCap', 'idleLimitSeconds']) {
    if (value[key] !== null && !isPositiveInteger(value[key])) return `${key} must be a whole number above zero`;
  }

  return null;
};

/** No model and no limits until an admin writes them, so an unconfigured proxy refuses every call. */
const HOSTED_AI_DEFAULT = Object.freeze({ models: [], activeModel: null, maxTokensCap: null, idleLimitSeconds: null });

module.exports = {
  isPlainObject,
  HOSTED_AI_PATH,
  HOSTED_AI,
  HOSTED_AI_DEFAULT,
  HOSTED_BODY_LIMIT,
  REFUSALS,
  REFUSAL_CODES,
  refusalBody,
  SAMPLER_FIELDS,
  upstreamUrl,
  upstreamKey,
  userSecret,
  validateHostedAi
};
