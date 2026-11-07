const Setting = require('../models/Setting');
const HostedUsage = require('../models/HostedUsage');
const HostedRefusal = require('../models/HostedRefusal');
const {
  HOSTED_AI, TIER_KEYS, MICROS_PER_DOLLAR, TURN_HEADER, USAGE_HEADER, REFUSALS, refusalBody, upstreamUrl, upstreamKey, userSecret, isPlainObject,
  warnThresholdsOf, breakdownThresholdOf, PROMPT_TYPE_HEADER, promptTypeOf
} = require('../config/hostedAi');
const { HostedRequestError, anonymousUser, buildUpstreamBody } = require('../utils/hostedRequest');
const { estimateTokens, worstCase, turnGrace, admitCall, admitRetry, settlement, generatedChars } = require('../utils/hostedMeter');
const { ageConfirmed, entitlement, unconfirmedTier, usageOf } = require('../utils/hostedState');
const { checkPause, pauseState, liftPause } = require('../utils/hostedPause');
const { acquireSlot, takeMinute } = require('../utils/hostedLimits');
const AuditLog = require('../models/AuditLog');
const { recordedVersion } = require('../config/clientVersion');

/**
 * The Formamorph AI proxy.
 *
 * Nothing here logs: request and upstream bodies hold player text, and an error object can carry either.
 */

/**
 * Answer a refusal and count it on its Refusal total. `upstream_error` is a provider failure, not a refusal.
 * A failed count never changes the answer.
 */
const refuse = (req, res, code, extra = {}) => {
  if (code !== 'upstream_error') {
    try {
      HostedRefusal.record({ userId: req.user.id, subject: req.hosted?.subject, tier: req.hosted?.tier, code, at: new Date() });
    } catch (error) {
      // A database error carries no player text.
      console.error('Hosted refusal record failed:', error);
    }
  }
  return res.status(REFUSALS[code].status).json({ ...refusalBody(code), ...extra });
};

/**
 * Refuse an account that has not passed the age gate or holds no entitled tier, by pledge or grant.
 *
 * Sets `req.hosted` with the spend subject and tier for the proxy.
 */
exports.admit = (req, res, next) => {
  if (!ageConfirmed(req.user.id)) return refuse(req, res, 'age_gate_required');

  const owned = entitlement(req.user.id);
  if (!owned) return refuse(req, res, unconfirmedTier(req.user.id) ? 'pledge_unconfirmed' : 'not_entitled');

  req.hosted = { subject: owned.subject, tier: owned.tier };
  return next();
};

/**
 * Answer an error from the route's own middleware, without logging it. A parse error carries the raw body.
 */
exports.routeError = (err, req, res, _next) => {
  if (res.headersSent) return res.end();
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return refuse(req, res, 'invalid_request');
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
    turnLimitSeconds: settings.turnLimitSeconds,
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

/** Whether a model entry asks for no thinking. With no field the provider decides, which counts as on. */
const thinkingOff = (entry) => entry.reasoning?.enabled === false || entry.reasoning?.effort === 'none';

/** The delta or message of each choice in one parsed reply. */
const replyParts = (payload) => (isPlainObject(payload) && Array.isArray(payload.choices)
  ? payload.choices.map((choice) => [choice?.delta, choice?.message].find(isPlainObject)).filter(Boolean)
  : []);

const isText = (value) => typeof value === 'string' && value.length > 0;

const hasReply = (payload) => replyParts(payload)
  .some((part) => isText(part.content) || (Array.isArray(part.tool_calls) && part.tool_calls.length > 0));

const hasThinking = (payload) => replyParts(payload)
  .some((part) => isText(part.reasoning) || isText(part.reasoning_content));

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

/** An attempt that failed for a known cause. `failure` is what the usage row records. */
class AttemptFailure extends Error {
  constructor(failure) {
    super(failure);
    this.failure = failure;
  }
}

/** Thrown when the upstream refuses a call or sends an error inside a 200 reply. */
class UpstreamErrorReply extends AttemptFailure {}

/** Thrown when a reply shows thinking on a model with thinking off, or a stream ends with nothing to forward. */
class AttemptStopped extends AttemptFailure {}

/** The first usable finish reason in one parsed reply. The pattern keeps upstream free text off the row. */
const finishReasonOf = (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.choices)) return null;
  const reason = payload.choices.map((choice) => choice?.finish_reason)
    .find((value) => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value));
  return reason ?? null;
};

/** The usage row's cause for a failed attempt, from fixed values only. */
const failureOf = (error, idleFired) => {
  if (idleFired) return 'idle_limit';
  if (error instanceof AttemptFailure) return error.failure;
  // The messages Node's fetch gives a failed connection and a dropped body.
  if (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)) return 'network';
  return 'other';
};

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
const settle = (meter, { usage, outputChars, status, stopped, diagnostics }) => {
  try {
    HostedUsage.settle(meter.rowId, {
      status,
      stopped: stopped ? 1 : 0,
      durationMs: Date.now() - meter.started.getTime(),
      ...diagnostics,
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
 *
 * A stream holds its frames until one has reply text or a tool call, or thinking on a model with thinking on.
 * An attempt that fails before then, or thinks on a model with thinking off, is stopped and sent once more.
 * The parallel slot, the per-minute count and the turn-cap slot cover both attempts.
 */
exports.proxy = async (req, res) => {
  let controller = new AbortController();
  let idleTimer = null;
  let idleFired = false;
  let clientGone = false;
  const armIdle = (idleMs) => {
    clearTimeout(idleTimer);
    const running = controller;
    idleTimer = setTimeout(() => {
      idleFired = true;
      running.abort();
    }, idleMs);
  };

  let meter = null;
  let release = null;
  let usage = null;
  let outputChars = 0;
  let finished = false;
  let settled = false;
  let firstTokenMs = null;
  let maxGapMs = null;
  let lastTokenAt = null;
  let finishReason = null;
  let failure = null;
  // The first settle wins: the success path settles before it reports usage, `finally` covers the rest.
  const settleOnce = (status, stopped = false) => {
    if (settled || !meter) return;
    settled = true;
    settle(meter, {
      usage,
      outputChars,
      status,
      stopped,
      diagnostics: { firstTokenMs, maxGapMs, finishReason, failure: status === 'error' ? failure : null }
    });
  };
  // Every parsed reply payload passes here, so usage and the output estimate see the same bytes.
  const observe = (payload) => {
    if (isPlainObject(payload) && payload.usage !== undefined) usage = payload.usage;
    outputChars += generatedChars(payload);
    finishReason = finishReasonOf(payload) ?? finishReason;
  };
  // Stream frames only: a whole reply has one arrival, which `duration_ms` already holds.
  const markToken = (payload) => {
    if (generatedChars(payload) === 0) return;
    const now = Date.now();
    if (firstTokenMs === null) {
      firstTokenMs = now - meter.started.getTime();
      maxGapMs = 0;
    } else {
      maxGapMs = Math.max(maxGapMs, now - lastTokenAt);
    }
    lastTokenAt = now;
  };

  try {
    const turnId = req.get(TURN_HEADER) || null;
    const config = activeConfig(req.hosted.tier, turnId ? HostedUsage.turnModel(req.hosted.subject, turnId) : null);
    if (!config) return refuse(req, res, 'service_paused');

    const started = new Date();
    // Before the rate limits, so a paused call spends no slot and answers as paused.
    if (checkPause(started, config.ceilingMicros)) return refuse(req, res, 'service_paused');
    release = acquireSlot(req.user.id, config.parallelLimit);
    if (!release) return refuse(req, res, 'rate_limited');
    if (!takeMinute(req.user.id, config.perMinuteLimit, started.getTime())) return refuse(req, res, 'rate_limited');

    let body;
    try {
      body = buildUpstreamBody(req.body, { ...config, user: anonymousUser(req.hosted.subject, userSecret()) });
    } catch (error) {
      return refuse(req, res, error instanceof HostedRequestError ? error.code : 'invalid_request');
    }

    const prices = config.entry.prices;
    const estimatedPromptTokens = estimateTokens(promptChars(body), config.ratio);
    const call = {
      subject: req.hosted.subject,
      userId: req.user.id,
      tier: req.hosted.tier,
      model: config.entry.id,
      promptType: promptTypeOf(req.get(PROMPT_TYPE_HEADER)),
      clientVersion: recordedVersion(req.client),
      turnLimitMs: config.turnLimitMs,
      ceilingMicros: config.ceilingMicros,
      estimatedPromptTokens,
      maxTokens: body.max_tokens,
      reserveMicros: worstCase(estimatedPromptTokens, body.max_tokens, prices)
    };
    const admitted = admitCall({
      ...call,
      turnId,
      now: started,
      turnCallCap: config.turnCallCap,
      budgetMicros: Math.round(config.limits.budget * MICROS_PER_DOLLAR),
      graceMicros: turnGrace(config, prices),
      window: config.limits.window,
      margin: config.margin
    });
    if (admitted.refusal) return refuse(req, res, admitted.refusal, admitted.extra);
    meter = { rowId: admitted.rowId, started, estimatedPromptTokens, ratio: config.ratio, prices, ceilingMicros: config.ceilingMicros };
    res.set(TURN_HEADER, admitted.turnId);

    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      controller.abort();
    });

    const noThinking = thinkingOff(config.entry);

    const forwardWhole = async (upstream) => {
      const chunks = [];
      for await (const chunk of upstream.body) {
        armIdle(config.idleMs);
        chunks.push(Buffer.from(chunk));
      }
      const reply = Buffer.concat(chunks);
      const parsed = parseJson(reply.toString('utf8'));
      if (isError(parsed)) throw new UpstreamErrorReply('upstream_reply');
      observe(parsed);
      if (noThinking && hasThinking(parsed) && !hasReply(parsed)) throw new AttemptStopped('thinking');
      finished = true;
      settleOnce('ok');
      const state = usageSnapshot(req.hosted.subject, config);
      if (state) res.set(USAGE_HEADER, JSON.stringify(state));
      return res.status(200).type('application/json').send(reply);
    };

    const forwardStream = async (upstream) => {
      // Whole events only, so an error event split across chunks is still caught before any of it is sent.
      const decoder = new TextDecoder();
      let pending = '';
      // Held back and sent last: clients stop reading at `[DONE]`, so the usage event has to precede it.
      let doneEvent = '';
      let holding = true;
      let unsent = '';
      const openStream = () => {
        if (res.headersSent) return;
        res.status(200);
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders();
      };
      const readFrame = (payload) => {
        if (isError(payload)) throw new UpstreamErrorReply('upstream_reply');
        observe(payload);
        markToken(payload);
        if (!holding) return;
        const thinking = hasThinking(payload);
        if (hasReply(payload) || (thinking && !noThinking)) holding = false;
        else if (thinking) throw new AttemptStopped('thinking');
      };
      for await (const chunk of upstream.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = EVENT_END.exec(pending))) {
          readFrame(eventData(pending.slice(0, end.index)));
          const whole = pending.slice(0, end.index + end[0].length);
          if (isDone(whole)) doneEvent = whole;
          else unsent += whole;
          pending = pending.slice(end.index + end[0].length);
        }
        if (!holding && unsent) {
          openStream();
          const flowing = res.write(unsent);
          unsent = '';
          if (!flowing) {
            // A slow client is not upstream silence, so the idle clock stops while the buffer drains.
            clearTimeout(idleTimer);
            await drained(res);
            // The same holds for the longest gap.
            lastTokenAt = Date.now();
          }
        }
        armIdle(config.idleMs);
      }
      pending += decoder.decode();
      readFrame(eventData(pending));
      if (holding) throw new AttemptStopped('empty');
      if (isDone(pending)) {
        doneEvent = pending;
        pending = '';
      }
      finished = true;
      settleOnce('ok');
      openStream();
      // An unterminated fragment goes before the usage event, so nothing follows [DONE].
      if (unsent || pending) res.write(unsent + pending);
      const state = usageSnapshot(req.hosted.subject, config);
      if (state) res.write(`event: usage\ndata: ${JSON.stringify(state)}\n\n`);
      if (doneEvent) res.write(/[\r\n]$/.test(doneEvent) ? doneEvent : `${doneEvent}\n\n`);
      return res.end();
    };

    const attempt = async () => {
      armIdle(config.idleMs);
      const upstream = await fetch(upstreamUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey()}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw new UpstreamErrorReply(`status_${upstream.status}`);
      }

      return body.stream ? forwardStream(upstream) : forwardWhole(upstream);
    };

    let retried = false;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        failure = failureOf(error, idleFired);
        if (clientGone || res.headersSent || !(body.stream || retried || error instanceof AttemptStopped)) throw error;
      }
      settleOnce('error', true);
      if (retried) return refuse(req, res, 'upstream_error');
      retried = true;
      const now = new Date();
      const rowId = admitRetry({ ...call, turnId: admitted.turnId, now });
      if (rowId === null) return refuse(req, res, 'upstream_error');
      controller.abort();
      controller = new AbortController();
      meter = { ...meter, rowId, started: now };
      usage = null;
      outputChars = 0;
      settled = false;
      idleFired = false;
      firstTokenMs = null;
      maxGapMs = null;
      lastTokenAt = null;
      finishReason = null;
    }
  } catch {
    if (clientGone) return undefined;
    if (res.headersSent) return endWithErrorEvent(res);
    return refuse(req, res, 'upstream_error');
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
