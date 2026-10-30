const Policy = require('../models/Policy');
const PatreonLink = require('../models/PatreonLink');
const Setting = require('../models/Setting');
const HostedUsage = require('../models/HostedUsage');
const {
  HOSTED_AI, TIER_KEYS, MICROS_PER_DOLLAR, TURN_HEADER, REFUSALS, refusalBody, upstreamUrl, upstreamKey, userSecret, isPlainObject
} = require('../config/hostedAi');
const { HostedRequestError, anonymousUser, buildUpstreamBody } = require('../utils/hostedRequest');
const { estimateTokens, worstCase, admitCall, settlement, generatedChars } = require('../utils/hostedMeter');

/**
 * The Formamorph AI proxy.
 *
 * Nothing here logs: request and upstream bodies hold player text, and an error object can carry either.
 */

const ENTITLED_TIERS = new Set(TIER_KEYS);

const refuse = (res, code, extra = {}) => res.status(REFUSALS[code].status).json({ ...refusalBody(code), ...extra });

/** Whether the account's age-gate acceptance is current. Anything unreadable counts as not accepted. */
const ageConfirmed = (userId) => {
  try {
    return Policy.hasAccepted(Policy.AGE_GATE, userId);
  } catch {
    return false;
  }
};

/**
 * Refuse an account that has not passed the age gate or holds no entitled tier.
 *
 * Sets `req.hosted` with the spend subject and tier for the proxy.
 */
exports.admit = (req, res, next) => {
  if (!ageConfirmed(req.user.id)) return refuse(res, 'age_gate_required');

  let link;
  try {
    link = PatreonLink.findByUser(req.user.id);
  } catch {
    link = null;
  }
  if (!link || !ENTITLED_TIERS.has(link.tier)) return refuse(res, 'not_entitled');

  req.hosted = { subject: link.patreon_user_id, tier: link.tier };
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
 * The active model and limits for a tier, or null when the proxy is not configured to send anything.
 *
 * A model without prompt and completion prices counts as unconfigured: no reservation, no budget.
 */
const activeConfig = (tier) => {
  const settings = Setting.get(HOSTED_AI);
  if (!settings || !Array.isArray(settings.models)) return null;

  const entry = settings.models.find((model) => model.id === settings.activeModel);
  if (!entry || !settings.maxTokensCap || !settings.idleLimitSeconds) return null;
  if (!isPrice(entry.prices?.prompt) || !isPrice(entry.prices?.completion)) return null;
  if (!settings.tokenRatio || !Number.isInteger(settings.tokenMargin)) return null;
  if (!settings.turnLimitSeconds || !settings.turnCallCap) return null;
  const limits = isPlainObject(settings.tiers) ? settings.tiers[tier] : null;
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
    turnCallCap: settings.turnCallCap
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

/** Settle the call's row. A failed write leaves it open for the hourly sweep, at its reservation. */
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
};

/**
 * Forward one chat completion and stream the reply back unchanged.
 *
 * An admitted call reserves its worst case before forwarding and settles in `finally`, whatever ended it.
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
  let usage = null;
  let outputChars = 0;
  let finished = false;
  // Every parsed reply payload passes here, so usage and the output estimate see the same bytes.
  const observe = (payload) => {
    if (isPlainObject(payload) && payload.usage !== undefined) usage = payload.usage;
    outputChars += generatedChars(payload);
  };

  try {
    const config = activeConfig(req.hosted.tier);
    if (!config) return refuse(res, 'service_paused');

    let body;
    try {
      body = buildUpstreamBody(req.body, { ...config, user: anonymousUser(req.hosted.subject, userSecret()) });
    } catch (error) {
      return refuse(res, error instanceof HostedRequestError ? error.code : 'invalid_request');
    }

    const prices = config.entry.prices;
    const estimatedPromptTokens = estimateTokens(promptChars(body), config.ratio);
    const started = new Date();
    const admitted = admitCall({
      subject: req.hosted.subject,
      userId: req.user.id,
      tier: req.hosted.tier,
      turnId: req.get(TURN_HEADER) || null,
      now: started,
      turnLimitMs: config.turnLimitMs,
      turnCallCap: config.turnCallCap,
      budgetMicros: Math.round(config.limits.budget * MICROS_PER_DOLLAR),
      window: config.limits.window,
      margin: config.margin,
      estimatedPromptTokens,
      reserveMicros: worstCase(estimatedPromptTokens, body.max_tokens, prices)
    });
    if (admitted.refusal) return refuse(res, admitted.refusal, admitted.extra);
    meter = { rowId: admitted.rowId, started, estimatedPromptTokens, ratio: config.ratio, prices };
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
      return res.status(200).type('application/json').send(reply);
    }

    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // Whole events only, so an error event split across chunks is still caught before any of it is sent.
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      let complete = '';
      let end;
      while ((end = EVENT_END.exec(pending))) {
        const payload = eventData(pending.slice(0, end.index));
        if (isError(payload)) throw new UpstreamErrorReply();
        observe(payload);
        complete += pending.slice(0, end.index + end[0].length);
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
    finished = true;
    return res.end(pending);
  } catch {
    if (clientGone) return undefined;
    if (res.headersSent) return endWithErrorEvent(res);
    return refuse(res, 'upstream_error');
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
    if (meter) settle(meter, { usage, outputChars, status: finished ? 'ok' : (clientGone ? 'aborted' : 'error') });
  }
};
