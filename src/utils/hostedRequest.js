const crypto = require('crypto');
const { SAMPLER_FIELDS, isPlainObject } = require('../config/hostedAi');

/**
 * Build the upstream chat-completions body from what a client sent.
 *
 * An allow-list at every level: top-level fields, message fields, content parts and tool fields. That is
 * what keeps `n`, `user`, routing, caching (`cache_control` sits inside parts) and unknown keys out.
 */

/** Thrown for a body the proxy refuses; `code` is a refusal code. */
class HostedRequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const invalid = () => new HostedRequestError('invalid_request');

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const MESSAGE_FIELDS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);
const TOOL_CHOICES = new Set(['none', 'auto', 'required']);
const RESPONSE_FORMATS = new Set(['text', 'json_object', 'json_schema']);

const pick = (source, fields) => {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
};

const isString = (value) => typeof value === 'string';

/** One content part, reduced to its text. */
const cleanPart = (part) => {
  if (!isPlainObject(part)) throw invalid();
  if (IMAGE_PART_TYPES.has(part.type)) throw new HostedRequestError('image_not_supported');
  if (part.type !== 'text' || !isString(part.text)) throw invalid();

  return { type: 'text', text: part.text };
};

const cleanFunction = (fn, fields) => {
  if (!isPlainObject(fn) || !isString(fn.name)) throw invalid();
  return pick(fn, fields);
};

const cleanToolCall = (call) => {
  if (!isPlainObject(call) || call.type !== 'function') throw invalid();

  return { ...pick(call, ['id', 'type']), function: cleanFunction(call.function, ['name', 'arguments']) };
};

const cleanMessage = (message) => {
  if (!isPlainObject(message) || !ROLES.has(message.role)) throw invalid();

  const out = pick(message, MESSAGE_FIELDS);
  if (Array.isArray(out.content)) out.content = out.content.map(cleanPart);
  else if (out.content !== undefined && out.content !== null && !isString(out.content)) throw invalid();
  if (out.tool_calls !== undefined) {
    if (!Array.isArray(out.tool_calls)) throw invalid();
    out.tool_calls = out.tool_calls.map(cleanToolCall);
  }

  return out;
};

const cleanTool = (tool) => {
  if (!isPlainObject(tool) || tool.type !== 'function') throw invalid();

  return { type: 'function', function: cleanFunction(tool.function, ['name', 'description', 'parameters', 'strict']) };
};

const cleanToolChoice = (choice) => {
  if (TOOL_CHOICES.has(choice)) return choice;
  if (!isPlainObject(choice) || choice.type !== 'function') throw invalid();

  return { type: 'function', function: cleanFunction(choice.function, ['name']) };
};

const cleanResponseFormat = (format) => {
  if (!isPlainObject(format) || !RESPONSE_FORMATS.has(format.type)) throw invalid();
  if (format.type !== 'json_schema') return { type: format.type };
  if (!isPlainObject(format.json_schema)) throw invalid();

  return { type: 'json_schema', json_schema: pick(format.json_schema, ['name', 'description', 'schema', 'strict']) };
};

const cleanStop = (stop) => {
  if (isString(stop)) return stop;
  if (!Array.isArray(stop) || !stop.every(isString)) throw invalid();

  return stop;
};

/**
 * The anonymous, stable id upstream sees for one spend subject.
 *
 * @param {string} subject - The spend subject
 * @param {string} secret - The dedicated server secret
 * @returns {string} Hex HMAC
 */
const anonymousUser = (subject, secret) => crypto.createHmac('sha256', secret).update(String(subject)).digest('hex');

/**
 * The body to send upstream.
 *
 * @param {*} body - The parsed client body
 * @param {Object} options - `{ entry, maxTokensCap, user }`: the active model entry, the cap, the HMAC
 * @returns {Object} The upstream body
 * @throws {HostedRequestError} For a body the proxy refuses
 */
const buildUpstreamBody = (body, { entry, maxTokensCap, user }) => {
  if (!isPlainObject(body)) throw invalid();
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid();
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) throw invalid();
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw invalid();

  const stream = body.stream === true;
  const out = {
    model: entry.model,
    messages: body.messages.map(cleanMessage),
    max_tokens: Math.min(body.max_tokens, maxTokensCap),
    stream,
    user
  };
  for (const field of SAMPLER_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) throw invalid();
    out[field] = body[field];
  }
  if (body.stop !== undefined) out.stop = cleanStop(body.stop);
  if (body.tools !== undefined) out.tools = body.tools.map(cleanTool);
  if (body.tool_choice !== undefined) out.tool_choice = cleanToolChoice(body.tool_choice);
  if (body.response_format !== undefined) out.response_format = cleanResponseFormat(body.response_format);
  if (stream) out.stream_options = { include_usage: true };
  if (entry.routing) out.provider = entry.routing;
  if (entry.reasoning) out.reasoning = entry.reasoning;

  return out;
};

module.exports = { HostedRequestError, anonymousUser, buildUpstreamBody };
