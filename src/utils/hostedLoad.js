const http = require('http');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const db = require('../config/db');
const { migrate } = require('../schema');
const Setting = require('../models/Setting');
const Policy = require('../models/Policy');
const PatreonLink = require('../models/PatreonLink');
const { HOSTED_AI, HOSTED_AI_PATH, TURN_HEADER, REFUSAL_CODES } = require('../config/hostedAi');
const { SUPPORTER } = require('../config/patreon');
const { heldSlots } = require('./hostedLimits');

/**
 * Load run for the Formamorph AI proxy, against a slow fake upstream.
 *
 * Runs the real app on a local port over whatever database `config/db` opened, so the caller must point
 * `DB_PATH` at a scratch database first (the CLI does). Nothing here reaches the network.
 * The prices and limits below are synthetic: they only have to be large enough that no budget refusal fires.
 */

const SYNTHETIC_SETTINGS = {
  models: [{ id: 'load', model: 'load/model', prices: { prompt: 1, completion: 1 } }],
  activeModel: 'load',
  maxTokensCap: 1000,
  idleLimitSeconds: 30,
  tiers: { [SUPPORTER]: { window: 100000, budget: 1_000_000 } },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 1000,
  retentionDays: 30,
  dailyCeiling: 1_000_000,
  balanceThreshold: null
};

const STREAM_CHUNKS = 5;
const CHUNK_GAP_MS = 10;
const DRAIN_MS = 5000;

/** The fake upstream: silent for `delayMs`, then a short stream that ends with a usage block. */
const startUpstream = (delayMs) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(async () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let i = 0; i < STREAM_CHUNKS; i += 1) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'word ' } }] })}\n\n`);
          await new Promise((resolve) => { setTimeout(resolve, CHUNK_GAP_MS); });
        }
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: STREAM_CHUNKS } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, delayMs);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(done);
    })
  })));
};

/** Seed `count` entitled accounts straight into the database, each with a bearer header. */
const seedAccounts = (count, tier = SUPPORTER) => {
  const insert = db.prepare('INSERT INTO users (id, username, password, account_type) VALUES (?, ?, ?, ?)');
  const accounts = [];
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const id = uuidv4();
      insert.run(id, `load-${String(i).padStart(4, '0')}`, 'not-a-login', 'normal');
      Policy.accept(Policy.AGE_GATE, id);
      PatreonLink.link({ userId: id, patreonUserId: `load-p-${i}`, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
      accounts.push({ id, authorization: `Bearer ${jwt.sign({ id, tv: 0 }, process.env.JWT_SECRET)}` });
    }
  })();

  return accounts;
};

/** The value at fraction `p` of a sorted list, or null when empty. */
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null);

/**
 * One call. Resolves with how it ended; never rejects.
 *
 * `ttfbMs` is the time to the first body chunk. A stream counts as complete only when it ends in `[DONE]`
 * with no `event: error` before it.
 */
const callOnce = async (origin, account, turnId) => {
  const started = performance.now();
  try {
    const res = await fetch(`${origin}${HOSTED_AI_PATH}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: account.authorization, ...(turnId ? { [TURN_HEADER]: turnId } : {}) },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Load run' }], max_tokens: 100, stream: true })
    });
    const reader = res.body.getReader();
    let ttfbMs = null;
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = performance.now() - started;
      text += decoder.decode(value, { stream: true });
    }
    if (res.status !== 200) {
      let code = null;
      try { code = JSON.parse(text).code || null; } catch { /* not JSON */ }
      return { status: res.status, code, ttfbMs, turnId: res.headers.get(TURN_HEADER) };
    }
    const complete = text.trimEnd().endsWith('[DONE]') && !text.includes('event: error');

    return { status: 200, code: complete ? null : 'stream_incomplete', ttfbMs, turnId: res.headers.get(TURN_HEADER) };
  } catch (error) {
    return { status: 0, code: `network:${error.cause?.code || error.name}`, ttfbMs: null, turnId: null };
  }
};

/** One turn as the client sends it: the first call alone, then the rest together on its turn id. */
const runTurn = async (origin, account, parallel) => {
  const first = await callOnce(origin, account, null);
  if (first.status !== 200 || !first.turnId) return [first];
  const rest = await Promise.all(Array.from({ length: parallel - 1 }, () => callOnce(origin, account, first.turnId)));

  return [first, ...rest];
};

/** Wait for every row to settle and every slot to free, up to `waitMs`. */
const drain = async (waitMs = DRAIN_MS) => {
  const deadline = Date.now() + waitMs;
  const open = () => db.prepare("SELECT COUNT(*) AS n FROM hosted_usage WHERE status = 'open'").get().n;
  while ((open() > 0 || heldSlots() > 0) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
};

/**
 * Drive the proxy and report.
 *
 * @param {Object} options
 * @param {number} options.accounts - Entitled accounts, each running turns at once
 * @param {number} options.turns - Turns per account, one after another
 * @param {number} options.parallel - Calls per turn: one first call, then the rest at once
 * @param {number} options.delayMs - How long the fake upstream stays silent before its first byte
 * @param {number} [options.parallelLimit] - Per-account parallel limit; defaults to `parallel`
 * @param {number} [options.minuteLimit] - Per-account calls per minute; defaults to enough for the run
 * @param {string[]} [options.expect] - Refusal codes the run is meant to trigger; any other failure is unplanned
 * @returns {Promise<Object>} The report, with `ok` false when the run found a leak or an unplanned failure
 */
const runLoad = async ({ accounts, turns, parallel, delayMs, parallelLimit = parallel, minuteLimit = null, expect = [] }) => {
  for (const code of expect) {
    if (!REFUSAL_CODES.includes(code)) throw new Error(`Unknown refusal code: ${code}`);
  }
  migrate(db);
  const upstream = await startUpstream(delayMs);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  process.env.HOSTED_AI_UPSTREAM_URL = `http://127.0.0.1:${upstream.port}/v1/chat/completions`;
  process.env.HOSTED_AI_API_KEY = 'load-run-key';
  process.env.HOSTED_AI_USER_SECRET = 'load-run-secret';
  delete process.env.HOSTED_AI_BALANCE_URL;
  delete process.env.HOSTED_AI_USAGE_URL;
  Setting.set(HOSTED_AI, { ...SYNTHETIC_SETTINGS, parallelLimit, perMinuteLimit: minuteLimit || turns * parallel * 2 });

  try {
    const people = seedAccounts(accounts);
    const started = performance.now();
    const results = (await Promise.all(people.map(async (account) => {
      const all = [];
      for (let i = 0; i < turns; i += 1) all.push(...await runTurn(origin, account, parallel));
      return all;
    }))).flat();
    const wallMs = performance.now() - started;
    await drain();

    const ttfb = results.filter((r) => r.status === 200 && r.ttfbMs !== null).map((r) => r.ttfbMs).sort((a, b) => a - b);
    const failures = {};
    for (const r of results) {
      if (r.status === 200 && !r.code) continue;
      const key = r.code || `http_${r.status}`;
      failures[key] = (failures[key] || 0) + 1;
    }
    const unplanned = Object.keys(failures).filter((key) => !expect.includes(key));
    const openRows = db.prepare("SELECT COUNT(*) AS n FROM hosted_usage WHERE status = 'open'").get().n;
    const rows = db.prepare('SELECT COUNT(*) AS n FROM hosted_usage').get().n;
    const slots = heldSlots();

    return {
      calls: results.length,
      rows,
      wallMs,
      ttfbP50Ms: percentile(ttfb, 0.5),
      ttfbP90Ms: percentile(ttfb, 0.9),
      failures,
      unplanned,
      openRows,
      slots,
      ok: openRows === 0 && slots === 0 && unplanned.length === 0
    };
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await upstream.close();
  }
};

module.exports = { runLoad, seedAccounts, drain };
