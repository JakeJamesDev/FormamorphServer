const fs = require('fs');
const http = require('http');
const app = require('../app');
const db = require('../config/db');
const { migrate } = require('../schema');
const Setting = require('../models/Setting');
const { HOSTED_AI, HOSTED_AI_PATH, TURN_HEADER, USAGE_HEADER, validateHostedAi } = require('../config/hostedAi');
const { SUPPORTER } = require('../config/patreon');
const { heldSlots } = require('./hostedLimits');
const { seedAccounts, drain } = require('./hostedLoad');

/**
 * Live run for the Formamorph AI proxy: the real app and a scratch database, against the real upstream.
 *
 * The caller must point `DB_PATH` at a scratch database first (the CLI does). Only the upstream call leaves
 * this machine, and it spends on the testing key.
 */

/**
 * The upstream URL and testing key from env values. `HOSTED_AI_API_KEY` is never a fallback.
 *
 * @param {Object} values - Env values
 * @returns {{ upstreamUrl: string, apiKey: string }}
 */
const readLiveEnv = (values) => {
  const missing = ['HOSTED_AI_UPSTREAM_URL', 'HOSTED_AI_TEST_API_KEY'].filter((key) => !values[key]);
  if (missing.length) throw new Error(`Add to the local .env: ${missing.join(', ')}`);

  return { upstreamUrl: values.HOSTED_AI_UPSTREAM_URL, apiKey: values.HOSTED_AI_TEST_API_KEY };
};

/**
 * The `hosted_ai` setting copied from production, checked as an admin write would be.
 *
 * @param {string} file - Path to the JSON copy
 * @returns {Object}
 */
const readLiveSettings = (file) => {
  if (!fs.existsSync(file)) throw new Error(`No settings copy at ${file}`);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problem = validateHostedAi(settings);
  if (problem) throw new Error(`Settings copy at ${file}: ${problem}`);

  return settings;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Text, thinking, usage state and error code from a whole reply or a stream's text. */
const readStream = (text) => {
  const read = { reply: '', thinkingChars: 0, usage: null, code: null };
  for (const event of text.split(/\r\n\r\n|\n\n|\r\r/)) {
    const lines = event.split(/\r\n|\r|\n/);
    const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = parseJson(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('\n'));
    if (name === 'error') read.code = data?.code || 'stream_error';
    else if (name === 'usage') read.usage = data;
    else if (data) {
      const delta = data.choices?.[0]?.delta;
      read.reply += delta?.content || '';
      read.thinkingChars += (delta?.reasoning || delta?.reasoning_content || '').length;
    }
  }

  return read;
};

/** One call through the local app. Resolves with how it ended; never rejects. */
const callOnce = async (origin, account, requestBody, stream) => {
  const started = performance.now();
  try {
    const res = await fetch(`${origin}${HOSTED_AI_PATH}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: account.authorization },
      body: JSON.stringify({ ...requestBody, stream })
    });
    const text = await res.text();
    const base = { mode: stream ? 'stream' : 'whole', status: res.status, turnId: res.headers.get(TURN_HEADER), ms: performance.now() - started };
    if (res.status !== 200) return { ...base, code: parseJson(text)?.code || null, reply: '', thinkingChars: 0, usage: null };
    if (stream) return { ...base, ...readStream(text) };

    const message = parseJson(text)?.choices?.[0]?.message;
    return {
      ...base,
      code: null,
      reply: message?.content || '',
      thinkingChars: (message?.reasoning || message?.reasoning_content || '').length,
      usage: parseJson(res.headers.get(USAGE_HEADER) || '') ?? null
    };
  } catch (error) {
    return {
      mode: stream ? 'stream' : 'whole',
      status: 0,
      code: `network:${error.cause?.code || error.name}`,
      turnId: null,
      ms: performance.now() - started,
      reply: '',
      thinkingChars: 0,
      usage: null
    };
  }
};

/**
 * Send calls through the real route and report each with its usage rows.
 *
 * @param {Object} options
 * @param {Object} options.settings - The `hosted_ai` setting to run under
 * @param {string} options.upstreamUrl - The upstream chat-completions URL
 * @param {string} options.apiKey - The testing key
 * @param {Object} options.requestBody - The chat completion, without `stream`
 * @param {('stream'|'whole')[]} [options.modes] - One call per mode, in order
 * @param {string} [options.tier] - The account's tier
 * @param {number} [options.drainMs] - How long to wait for rows and slots to free
 * @returns {Promise<Object>} The report, with `ok` false when a call failed or a row or slot leaked
 */
const runLive = async ({ settings, upstreamUrl, apiKey, requestBody, modes = ['stream', 'whole'], tier = SUPPORTER, drainMs }) => {
  migrate(db);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  process.env.HOSTED_AI_UPSTREAM_URL = upstreamUrl;
  process.env.HOSTED_AI_API_KEY = apiKey;
  process.env.HOSTED_AI_USER_SECRET = 'live-run-secret';
  delete process.env.HOSTED_AI_BALANCE_URL;
  delete process.env.HOSTED_AI_USAGE_URL;
  Setting.set(HOSTED_AI, settings);

  try {
    const [account] = seedAccounts(1, tier);
    const results = [];
    for (const mode of modes) results.push(await callOnce(origin, account, requestBody, mode === 'stream'));
    await drain(drainMs);

    const rowsOf = db.prepare('SELECT * FROM hosted_usage WHERE turn_id = ? ORDER BY id');
    const calls = results.map((call) => ({ ...call, rows: call.turnId ? rowsOf.all(call.turnId) : [] }));
    const openRows = db.prepare("SELECT COUNT(*) AS n FROM hosted_usage WHERE status = 'open'").get().n;
    const slots = heldSlots();
    const passed = (call) => call.rows.at(-1)?.status === 'ok';

    return { calls, openRows, slots, ok: openRows === 0 && slots === 0 && calls.every(passed) };
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
};

module.exports = { readLiveEnv, readLiveSettings, runLive };
