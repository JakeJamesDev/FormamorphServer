const crypto = require('crypto');
const db = require('../config/db');
const HostedUsage = require('../models/HostedUsage');
const { MICROS_PER_DOLLAR, isPlainObject } = require('../config/hostedAi');
const { checkPause } = require('./hostedPause');

/**
 * Formamorph AI metering: admit a call against its turn, budget and window, then settle what it cost.
 *
 * Every cost is integer micro-dollars. Prices are dollars per million tokens, so tokens times a price is
 * already micro-dollars.
 */

/** 00:00 UTC on the Monday of the week `now` falls in; `getUTCDay` counts Sunday as 0. */
const weekStartMs = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7));

const weekStart = (now) => new Date(weekStartMs(now)).toISOString();

/** 00:00 UTC on the next Monday: when a budget resets. */
const resetAt = (now) => {
  const monday = new Date(weekStartMs(now));
  return new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7)).toISOString();
};

/** Tokens from a character count, rounded up. */
const estimateTokens = (chars, ratio) => Math.ceil(chars / ratio);

const priced = (tokens, price) => tokens * price;

/** Uncached prompt and output tokens at the model's prices. */
const promptAndOutput = (promptTokens, outputTokens, prices) => Math.round(
  priced(promptTokens, prices.prompt) + priced(outputTokens, prices.completion)
);

/** What a call can cost at most: its whole estimated prompt and every token `max_tokens` allows. */
const worstCase = (estimatedPromptTokens, maxTokens, prices) => promptAndOutput(estimatedPromptTokens, maxTokens, prices);

/**
 * Admit one call and reserve its worst case, or say why not.
 *
 * Turn, then budget, then window. The checks and the insert share one synchronous transaction, so
 * parallel first calls each see the reservations before them. The reservation then checks the daily ceiling.
 *
 * @param {Object} call - `{ subject, userId, tier, model, promptType, turnId, now, turnLimitMs, turnCallCap, budgetMicros,
 *   ceilingMicros, window, margin, estimatedPromptTokens, reserveMicros }`; `turnId` null on a turn's first call
 * @returns {{ refusal: string, extra?: Object }|{ rowId: number, turnId: string }}
 */
const admitCall = db.transaction((call) => {
  const { subject, turnId, now } = call;

  if (turnId) {
    const turn = HostedUsage.turn(subject, turnId);
    const expired = !turn
      || now.getTime() - Date.parse(turn.first) >= call.turnLimitMs
      || turn.calls >= call.turnCallCap;
    if (expired) return { refusal: 'turn_expired' };
  } else if (HostedUsage.spendSince(subject, weekStart(now)) >= call.budgetMicros) {
    return { refusal: 'budget_exhausted', extra: { resetAt: resetAt(now) } };
  }

  if (call.estimatedPromptTokens > call.window + call.margin) {
    return { refusal: 'window_exceeded', extra: { window: call.window } };
  }

  const admittedTurn = turnId || crypto.randomUUID();
  const rowId = HostedUsage.open({
    subject,
    userId: call.userId,
    turnId: admittedTurn,
    tier: call.tier,
    model: call.model,
    promptType: call.promptType,
    estimatedPromptTokens: call.estimatedPromptTokens,
    costMicros: call.reserveMicros,
    startedAt: now.toISOString()
  });
  // This reservation may be the one that reaches the ceiling.
  checkPause(now, call.ceilingMicros);

  return { rowId, turnId: admittedTurn };
});

const isCount = (value) => Number.isInteger(value) && value >= 0;
const isCost = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Whether an upstream `usage` value carries a cost or token counts to settle from. */
const isUsageBlock = (usage) => isPlainObject(usage)
  && (isCost(usage.cost) || isCount(usage.prompt_tokens) || isCount(usage.completion_tokens));

/**
 * The settled fields for a finished call.
 *
 * With a usage block: its own cost (`upstream`), else its token counts times the prices (`computed`).
 * Without one: the estimated prompt plus output estimated from the characters streamed (`estimated`).
 *
 * @param {Object} outcome - `{ usage, estimatedPromptTokens, outputChars, ratio, prices }`
 * @returns {{ costSource: string, costMicros: number, promptTokens: number|null, cachedTokens: number|null,
 *   outputTokens: number|null }}
 */
const settlement = ({ usage, estimatedPromptTokens, outputChars, ratio, prices }) => {
  if (!isUsageBlock(usage)) {
    return {
      costSource: 'estimated',
      costMicros: promptAndOutput(estimatedPromptTokens, estimateTokens(outputChars, ratio), prices),
      promptTokens: null,
      cachedTokens: null,
      outputTokens: null
    };
  }

  const promptTokens = isCount(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const cachedTokens = isCount(cached) ? Math.min(cached, promptTokens) : 0;
  const outputTokens = isCount(usage.completion_tokens) ? usage.completion_tokens : 0;
  const counts = { promptTokens, cachedTokens, outputTokens };

  if (isCost(usage.cost)) {
    return { costSource: 'upstream', costMicros: Math.round(usage.cost * MICROS_PER_DOLLAR), ...counts };
  }

  const cachedPrice = typeof prices.cached === 'number' ? prices.cached : prices.prompt;
  return {
    costSource: 'computed',
    costMicros: Math.round(
      priced(promptTokens - cachedTokens, prices.prompt)
        + priced(cachedTokens, cachedPrice)
        + priced(outputTokens, prices.completion)
    ),
    ...counts
  };
};

/**
 * The characters of generated text in one parsed reply: content, reasoning and tool arguments.
 *
 * @param {*} chunk - One parsed SSE data payload, or a whole non-streamed reply
 * @returns {number}
 */
const generatedChars = (chunk) => {
  if (!isPlainObject(chunk) || !Array.isArray(chunk.choices)) return 0;

  let chars = 0;
  for (const choice of chunk.choices) {
    // `delta` in a stream chunk, `message` in a whole reply.
    const delta = [choice?.delta, choice?.message].find(isPlainObject);
    if (!delta) continue;
    for (const field of ['content', 'reasoning', 'reasoning_content']) {
      if (typeof delta[field] === 'string') chars += delta[field].length;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (typeof call?.function?.arguments === 'string') chars += call.function.arguments.length;
      }
    }
  }

  return chars;
};

module.exports = { weekStart, resetAt, estimateTokens, worstCase, admitCall, settlement, generatedChars };
