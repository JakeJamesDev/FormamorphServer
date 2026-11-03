const Setting = require('../models/Setting');
const HostedUsage = require('../models/HostedUsage');
const {
  HOSTED_AI, TIER_KEYS, MICROS_PER_DOLLAR, TURN_HEADER, USAGE_HEADER, REFUSALS, refusalBody, upstreamUrl, upstreamKey, userSecret, isPlainObject,
  warnThresholdsOf, breakdownThresholdOf, PROMPT_TYPE_HEADER, promptTypeOf
} = require('../config/hostedAi');
const { HostedRequestError, anonymousUser, buildUpstreamBody } = require('../utils/hostedRequest');
const { estimateTokens, worstCase, turnGrace, admitCall, settlement, generatedChars } = require('../utils/hostedMeter');
const { ageConfirmed, entitlement, unconfirmedTier, usageOf } = require('../utils/hostedState');
const { checkPause, pausedCallUsed, pauseState, liftPause } = require('../utils/hostedPause');
const { acquireSlot, takeMinute } = require('../utils/hostedLimits');
const AuditLog = require('../models/AuditLog');

/**
 * The Formamorph AI proxy.
 *
 * Nothing here logs: request and upstream bodies hold player text, and an error object can carry either.
 */

const refuse = (res, code, extra = {}) => res.status(REFUSALS[code].status).json({ ...refusalBody(code), ...extra });

/**
 * Refuse an account that has not passed the age gate or holds no entitled tier, by pledge or grant.
 *
 * Sets `req.hosted` with the spend subject and tier for the proxy.
 */
exports.admit = (req, res, next) => {
  if (!ageConfirmed(req.user.id)) return refuse(res, 'age_gate_required');

  const owned = entitlement(req.user.id);
  if (!owned) return refuse(res, unconfirmedTier(req.user.id) ? 'pledge_unconfirmed' : 'not_entitled');

  req.hosted = { subject: owned.subject, tier: owned.tier };
  return next();
};

/**
 * Answer an error from the route's own middleware, without logging it. A parse error carries the raw body.
 */
exports.routeError = (err, _req, res, _next) => {
  if (res.headersSent) return res.end();
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return refuse(res, 'invalid_request');
  }
  return res.status(500).json({ success: false, error: 'Server Error' });
};

const isPrice = (value) => typeof value === 'number' && value >= 0;

/**
 * The model and limits for a tier, or null when the proxy is not configured to send anything.
 *
 * A turn's later calls pass the model its first call ran on, so a model switch applies to the next admitted
 * turn only. A model dropped from the approved list since falls back to the active one.
 * A model without prompt and completion prices counts as unconfigured: no reservation, no budget.
 */
const activeConfig = (tier, turnModel = null) => {
  if (!TIER_KEYS.includes(tier)) return null;
  const settings = Setting.get(HOSTED_AI);
  if (!settings || !Array.isArray(settings.models)) return null;

  const entry = settings.models.find((model) => model.id === turnModel)
    || settings.models.find((model) => model.id === settings.activeModel);
  if (!entry || !settings.maxTokensCap || !settings.idleLimitSeconds) return null;
  if (!isPrice(entry.prices?.prompt) || !isPrice(entry.prices?.completion)) return null;
  if (!settings.tokenRatio || !Number.isInteger(settings.tokenMargin)) return null;
  if (!settings.turnLimitSeconds || !settings.turnCallCap) return null;
  if (!settings.parallelLimit || !settings.perMinuteLimit || !(settings.dailyCeiling > 0)) return null;
  const limits = isPlainObject(settings.tiers) && Object.hasOwn(settings.tiers, tier) ? settings.tiers[tier] : null;
  if (!isPlainObject(limits)) return null;
  if (!upstreamUrl() || !upstreamKey() || !userSecret()) return null;

  return {
    entry,
    limits,
    maxTokensCap: settings.maxTokensCap,
    idleMs: settings.idleLimitSeconds * 1000,
    ratio: settings.tokenRatio,
    margin: settings.tokenMargin,
    turnLimitMs: settings.turnLimitSeconds * 1000,
    turnCallCap: settings.turnCallCap,
    warnThresholds: warnThresholdsOf(settings),
    breakdownThreshold: breakdownThresholdOf(settings),
    turnSample: settings.turnSample || null,
    parallelLimit: settings.parallelLimit,
    perMinuteLimit: settings.perMinuteLimit,
    ceilingMicros: Math.round(settings.dailyCeiling * MICROS_PER_DOLLAR)
  };
};

/** The characters the window estimate counts: messages and tool schemas, as sent upstream. */
const promptChars = (body) => JSON.stringify(body.messages).length + (body.tools ? JSON.stringify(body.tools).length : 0);

/** End a started stream with one SSE error event. */
const endWithErrorEvent = (res) => {
  if (!res.writableEnded) {
    res.end(`event: error\ndata: ${JSON.stringify(refusalBody('upstream_error'))}\n\n`);
  }
};

/** Parsed JSON text, or undefined. */
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isError = (parsed) => isPlainObject(parsed) && parsed.error !== undefined;

/** One SSE event's data, parsed, or undefined. */
const eventData = (event) => parseJson(event
  .split(/\r\n|\r|\n/)
  .filter((line) => line.startsWith('data:'))
  .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
  .join('\n'));

const EVENT_END = /\r\n\r\n|\n\n|\r\r/;

/** Whether one SSE event is the stream's `[DONE]` marker. */
const isDone = (event) => event
  .split(/\r\n|\r|\n/)
  .some((line) => line.startsWith('data:') && line.slice(5).trim() === '[DONE]');

/** The usage state as a client reads it, or null when it cannot be computed. */
const usageSnapshot = (subject, config) => {
  try {
    const { percentUsed, turnsLeft, resetAt } = usageOf(subject, config, new Date());
    return { percentUsed, turnsLeft, resetAt };
  } catch (error) {
    console.error('Hosted usage state failed:', error);
    return null;
  }
};

/** Thrown when the upstream sends an error inside a 200 reply. */
class UpstreamErrorReply extends Error {}

/** Resolve once a full socket buffer drains, or the client leaves. */
const drained = (res) => new Promise((resolve) => {
  const done = () => {
    res.off('drain', done);
    res.off('close', done);
    resolve();
  };
  res.on('drain', done);
  res.on('close', done);
});

/**
 * Settle the call's row, then check the ceiling against the settled cost. A failed write leaves the row open
 * for the hourly sweep, at its reservation.
 */
const settle = (meter, { usage, outputChars, status }) => {
  try {
    HostedUsage.settle(meter.rowId, {
      status,
      durationMs: Date.now() - meter.started.getTime(),
      ...settlement({ usage, outputChars, estimatedPromptTokens: meter.estimatedPromptTokens, ratio: meter.ratio, prices: meter.prices })
    });
  } catch (error) {
    // A database error carries no player text.
    console.error('Hosted usage settle failed:', error);
  }
  try {
    checkPause(new Date(), meter.ceilingMicros);
  } catch (error) {
    console.error('Hosted pause check failed:', error);
  }
};

exports.activeConfig = activeConfig;

/**
 * Forward one chat completion and stream the reply back unchanged.
 *
 * An admitted call reserves its worst case before forwarding and settles in `finally`, whatever ended it.
 * The parallel slot is released there too, so a refusal, an error or an abort never keeps it.
 * A client disconnect aborts the upstream call. An upstream silent past the idle limit is aborted too.
 */
exports.proxy = async (req, res) => {
  const controller = new AbortController();
  let idleTimer = null;
  let clientGone = false;
  const armIdle = (idleMs) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };

  let meter = null;
  let release = null;
  let usage = null;
  let outputChars = 0;
  let finished = false;
  let settled = false;
  // The first settle wins: the success path settles before it reports usage, `finally` covers the rest.
  const settleOnce = (status) => {
    if (settled || !meter) return;
    settled = true;
    settle(meter, { usage, outputChars, status });
  };
  // Every parsed reply payload passes here, so usage and the output estimate see the same bytes.
  const observe = (payload) => {
    if (isPlainObject(payload) && payload.usage !== undefined) usage = payload.usage;
    outputChars += generatedChars(payload);
  };

  try {
    const turnId = req.get(TURN_HEADER) || null;
    const config = activeConfig(req.hosted.tier, turnId ? HostedUsage.turnModel(req.hosted.subject, turnId) : null);
    if (!config) return refuse(res, 'service_paused');

    const started = new Date();
    // Before the rate limits, so a paused call spends no slot and answers as paused.
    const paused = turnId
      ? pausedCallUsed(started, config.ceilingMicros, req.hosted.subject, turnId)
      : checkPause(started, config.ceilingMicros);
    if (paused) return refuse(res, 'service_paused');
    release = acquireSlot(req.user.id, config.parallelLimit);
    if (!release) return refuse(res, 'rate_limited');
    if (!takeMinute(req.user.id, config.perMinuteLimit, started.getTime())) return refuse(res, 'rate_limited');

    let body;
    try {
      body = buildUpstreamBody(req.body, { ...config, user: anonymousUser(req.hosted.subject, userSecret()) });
    } catch (error) {
      return refuse(res, error instanceof HostedRequestError ? error.code : 'invalid_request');
    }

    const prices = config.entry.prices;
    const estimatedPromptTokens = estimateTokens(promptChars(body), config.ratio);
    const admitted = admitCall({
      subject: req.hosted.subject,
      userId: req.user.id,
      tier: req.hosted.tier,
      turnId,
      model: config.entry.id,
      promptType: promptTypeOf(req.get(PROMPT_TYPE_HEADER)),
      now: started,
      turnLimitMs: config.turnLimitMs,
      turnCallCap: config.turnCallCap,
      budgetMicros: Math.round(config.limits.budget * MICROS_PER_DOLLAR),
      graceMicros: turnGrace(config, prices),
      ceilingMicros: config.ceilingMicros,
      window: config.limits.window,
      margin: config.margin,
      estimatedPromptTokens,
      reserveMicros: worstCase(estimatedPromptTokens, body.max_tokens, prices)
    });
    if (admitted.refusal) return refuse(res, admitted.refusal, admitted.extra);
    meter = { rowId: admitted.rowId, started, estimatedPromptTokens, ratio: config.ratio, prices, ceilingMicros: config.ceilingMicros };
    res.set(TURN_HEADER, admitted.turnId);

    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      controller.abort();
    });

    armIdle(config.idleMs);
    const upstream = await fetch(upstreamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey()}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return refuse(res, 'upstream_error');
    }

    if (!body.stream) {
      const chunks = [];
      for await (const chunk of upstream.body) {
        armIdle(config.idleMs);
        chunks.push(Buffer.from(chunk));
      }
      const reply = Buffer.concat(chunks);
      const parsed = parseJson(reply.toString('utf8'));
      if (isError(parsed)) return refuse(res, 'upstream_error');
      observe(parsed);
      finished = true;
      settleOnce('ok');
      const state = usageSnapshot(req.hosted.subject, config);
      if (state) res.set(USAGE_HEADER, JSON.stringify(state));
      return res.status(200).type('application/json').send(reply);
    }

    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // Whole events only, so an error event split across chunks is still caught before any of it is sent.
    const decoder = new TextDecoder();
    let pending = '';
    // Held back and sent last: clients stop reading at `[DONE]`, so the usage event has to precede it.
    let doneEvent = '';
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      let complete = '';
      let end;
      while ((end = EVENT_END.exec(pending))) {
        const payload = eventData(pending.slice(0, end.index));
        if (isError(payload)) throw new UpstreamErrorReply();
        observe(payload);
        const whole = pending.slice(0, end.index + end[0].length);
        if (isDone(whole)) doneEvent = whole;
        else complete += whole;
        pending = pending.slice(end.index + end[0].length);
      }
      if (complete && !res.write(complete)) {
        // A slow client is not upstream silence, so the idle clock stops while the buffer drains.
        clearTimeout(idleTimer);
        await drained(res);
      }
      armIdle(config.idleMs);
    }
    pending += decoder.decode();
    const last = eventData(pending);
    if (isError(last)) throw new UpstreamErrorReply();
    observe(last);
    if (isDone(pending)) {
      doneEvent = pending;
      pending = '';
    }
    finished = true;
    settleOnce('ok');
    // An unterminated fragment goes before the usage event, so nothing follows [DONE].
    if (pending) res.write(pending);
    pending = '';
    const state = usageSnapshot(req.hosted.subject, config);
    if (state) res.write(`event: usage\ndata: ${JSON.stringify(state)}\n\n`);
    if (doneEvent) res.write(/[\r\n]$/.test(doneEvent) ? doneEvent : `${doneEvent}\n\n`);
    return res.end(pending);
  } catch {
    if (clientGone) return undefined;
    if (res.headersSent) return endWithErrorEvent(res);
    return refuse(res, 'upstream_error');
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
    settleOnce(finished ? 'ok' : (clientGone ? 'aborted' : 'error'));
    if (release) release();
  }
};

/**
 * @desc    Read today's Formamorph AI pause
 * @route   GET /api/hosted-ai/pause
 * @access  Private/Staff
 */
exports.getPause = (_req, res, next) => {
  try {
    res.status(200).json({ success: true, data: pauseState(new Date()) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Lift today's Formamorph AI pause until 00:00 UTC
 * @route   POST /api/hosted-ai/pause/lift
 * @access  Private/Admin
 */
exports.liftPause = (req, res, next) => {
  try {
    const now = new Date();
    if (!liftPause(now, req.user.id)) {
      return res.status(409).json({ success: false, error: 'Formamorph AI is not paused' });
    }
    AuditLog.tryRecord({ action: 'hosted_pause_lifted', actor: req.user });

    return res.status(200).json({ success: true, data: pauseState(now) });
  } catch (error) {
    return next(error);
  }
};
