const Policy = require('../models/Policy');
const PatreonLink = require('../models/PatreonLink');
const Setting = require('../models/Setting');
const { SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP } = require('../config/patreon');
const {
  HOSTED_AI, REFUSALS, refusalBody, upstreamUrl, upstreamKey, userSecret, isPlainObject
} = require('../config/hostedAi');
const { HostedRequestError, anonymousUser, buildUpstreamBody } = require('../utils/hostedRequest');

/**
 * The Formamorph AI proxy.
 *
 * Nothing here logs: request and upstream bodies hold player text, and an error object can carry either.
 */

const ENTITLED_TIERS = new Set([SUPPORTER, SUPPORTER_PLUS, SUPPORTER_TOP]);

const refuse = (res, code) => res.status(REFUSALS[code].status).json(refusalBody(code));

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
 * Sets `req.hosted` with the spend subject for the proxy.
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

  req.hosted = { subject: link.patreon_user_id };
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

/** The active model and limits, or null when the proxy is not configured to send anything. */
const activeConfig = () => {
  const settings = Setting.get(HOSTED_AI);
  if (!settings || !Array.isArray(settings.models)) return null;

  const entry = settings.models.find((model) => model.id === settings.activeModel);
  if (!entry || !settings.maxTokensCap || !settings.idleLimitSeconds) return null;
  if (!upstreamUrl() || !upstreamKey() || !userSecret()) return null;

  return { entry, maxTokensCap: settings.maxTokensCap, idleMs: settings.idleLimitSeconds * 1000 };
};

/** End a started stream with one SSE error event. */
const endWithErrorEvent = (res) => {
  if (!res.writableEnded) {
    res.end(`event: error\ndata: ${JSON.stringify(refusalBody('upstream_error'))}\n\n`);
  }
};

/** Whether JSON text is an object with a top-level `error`. */
const isErrorJson = (text) => {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) && parsed.error !== undefined;
  } catch {
    return false;
  }
};

/** Whether one SSE event's data is an upstream error. */
const isErrorEvent = (event) => isErrorJson(event
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

/**
 * Forward one chat completion and stream the reply back unchanged.
 *
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

  try {
    const config = activeConfig();
    if (!config) return refuse(res, 'service_paused');

    let body;
    try {
      body = buildUpstreamBody(req.body, { ...config, user: anonymousUser(req.hosted.subject, userSecret()) });
    } catch (error) {
      return refuse(res, error instanceof HostedRequestError ? error.code : 'invalid_request');
    }

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
      if (isErrorJson(reply.toString('utf8'))) return refuse(res, 'upstream_error');
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
        if (isErrorEvent(pending.slice(0, end.index))) throw new UpstreamErrorReply();
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
    if (isErrorEvent(pending)) throw new UpstreamErrorReply();
    return res.end(pending);
  } catch {
    if (clientGone) return undefined;
    if (res.headersSent) return endWithErrorEvent(res);
    return refuse(res, 'upstream_error');
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
  }
};
