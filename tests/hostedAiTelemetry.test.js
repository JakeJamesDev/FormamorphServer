import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import Database from 'better-sqlite3';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const { HOSTED_AI } = require('../src/config/hostedAi');
const { DAY_MS } = require('../src/config/time');
const hostedUsageTelemetry = require('../src/schema/steps/hostedUsageTelemetry');

/**
 * What a usage row keeps about its admission and its build, and the report's `reservations` and `clients`
 * sections, over HTTP against a fake upstream.
 *
 * One prompt token costs 1 micro-dollar and one output token 3.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const REPORT = '/api/hosted-ai/admin/usage-report';
const CLIENT = 'X-Formamorph-Client';
const PROMPT_TYPE = 'X-Formamorph-Prompt-Type';
const CAP = 1000;
const UPSTREAM_COST = 0.00002; // 20 micro-dollars.

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const usage = { prompt_tokens: 10, completion_tokens: 5, cost: UPSTREAM_COST };

// The fake upstream answers each call with the next script, then with the last one.
let scripts;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const script = scripts.length > 1 ? scripts.shift() : scripts[0];
    script(JSON.parse(raw), res);
  });
});

const replies = (body, res) => {
  if (!body.stream) {
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi' } }], usage }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(event({ choices: [{ delta: { content: 'Hello' } }] }));
  res.write(event({ choices: [], usage }));
  return res.end('data: [DONE]\n\n');
};

/** A stream with nothing to forward: the proxy stops it and sends it once more. */
const empty = (_body, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: [DONE]\n\n');
};

const SETTINGS = {
  models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 3, cached: 1 } }],
  activeModel: 'main',
  maxTokensCap: CAP,
  idleLimitSeconds: 5,
  tiers: { supporter: { window: 2000, budget: 1 }, supporter_plus: { window: 4000, budget: 1 }, supporter_top: { window: 8000, budget: 1 } },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 4,
  retentionDays: 30,
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null
};

const rnd = () => Math.random().toString(36).slice(2, 8);

const supporter = () => {
  const user = createUser({ username: `tel-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${rnd()}`, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

/** Send one call. `client` is the raw client header, or undefined to send none. */
const send = (user, { client, promptType, ...body } = {}) => {
  const req = request(app).post(ROUTE).set(authHeader(user));
  if (client !== undefined) req.set(CLIENT, client);
  if (promptType) req.set(PROMPT_TYPE, promptType);
  return req.send({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100, ...body });
};

const rows = () => db.prepare('SELECT * FROM hosted_usage ORDER BY id').all();

const report = async () => {
  const res = await request(app).get(`${REPORT}?days=7`).set(authHeader(createUser({ accountType: 'admin' })));
  expect(res.status).toBe(200);
  return res.body.data;
};

/** Insert one settled row. Each test names only what it reads. */
const call = (fields = {}) => {
  const row = {
    subject: 'subject-a', turn_id: `turn-${rnd()}`, tier: 'supporter', prompt_type: 'narration', estimated_prompt_tokens: 1,
    cost_micros: 100, reserve_micros: 400, cost_source: 'upstream', started_at: new Date().toISOString(), status: 'ok', stopped: 0,
    client_version: null, ...fields
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO hosted_usage (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(row);
};

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

beforeAll(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.HOSTED_AI_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
  process.env.HOSTED_AI_API_KEY = 'test-upstream-key';
  process.env.HOSTED_AI_USER_SECRET = 'test-user-secret';
});

afterAll(() => {
  upstream.closeAllConnections();
  return new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  migrate(db);
  db.prepare('DELETE FROM hosted_usage').run();
  db.prepare('DELETE FROM hosted_pause').run();
  Setting.set(HOSTED_AI, SETTINGS);
  scripts = [replies];
});

describe('usage row admission fields', () => {
  it('keeps the capped max_tokens and the reservation admission held, after the row settles', async () => {
    expect((await send(supporter(), { max_tokens: 5000, client: '2.18.0 windows' })).status).toBe(200);

    const [row] = rows();
    expect(row).toMatchObject({ status: 'ok', cost_source: 'upstream', cost_micros: 20, max_tokens: CAP });
    // The worst case: every estimated prompt token at the prompt price, every capped output token at the completion price.
    expect(row.reserve_micros).toBe(row.estimated_prompt_tokens * 1 + CAP * 3);

    const { reservations } = await report();
    expect(reservations.overall).toEqual({ calls: 1, reserveMicros: row.reserve_micros, costMicros: 20, ratio: 20 / row.reserve_micros });
    expect(reservations.promptTypes).toEqual([{ promptType: null, ...reservations.overall }]);
  });

  it('gives a retry the capped max_tokens and client version, and its own reservation', async () => {
    scripts = [empty, replies];

    expect((await send(supporter(), { stream: true, max_tokens: 5000, client: '2.18.0 windows' })).status).toBe(200);

    const [first, retry] = rows();
    expect(first).toMatchObject({ retry: 0, stopped: 1, status: 'error' });
    expect(retry).toMatchObject({ retry: 1, status: 'ok', max_tokens: CAP, client_version: '2.18.0', reserve_micros: first.reserve_micros });
    expect(first).toMatchObject({ max_tokens: CAP, client_version: '2.18.0' });

    const { reservations, clients } = await report();
    // The stopped attempt is left out of the reservation sums; the retry is in.
    expect(reservations.overall).toMatchObject({ calls: 1, reserveMicros: retry.reserve_micros, costMicros: 20 });
    // Both rows count as calls under the build, the retry included.
    expect(clients).toEqual([expect.objectContaining({ clientVersion: '2.18.0', calls: 2, turns: 1 })]);
  });

  it('reports a valid client header under its version, and a missing or unreadable one under null', async () => {
    const user = supporter();
    await send(user, { client: '2.18.0-beta.1 web' });
    await send(user);
    await send(user, { client: 'garbage' });
    await send(user, { client: '0.0.0 web' });

    expect(rows().map((row) => row.client_version)).toEqual(['2.18.0-beta.1', null, null, null]);
    const { clients } = await report();
    expect(clients).toEqual([
      { clientVersion: null, calls: 3, turns: 3, costMicros: 60, turnsWithoutNarration: 3 },
      { clientVersion: '2.18.0-beta.1', calls: 1, turns: 1, costMicros: 20, turnsWithoutNarration: 1 }
    ]);
    expect(JSON.stringify(clients)).not.toContain('0.0.0');
  });

  it('counts a turn with no narration call under its build, and leaves a narration turn out', async () => {
    const user = supporter();
    await send(user, { client: '2.18.0 web', promptType: 'summary' });
    await send(user, { client: '2.18.0 web', promptType: 'narration' });

    expect((await report()).clients).toEqual([
      { clientVersion: '2.18.0', calls: 2, turns: 2, costMicros: 40, turnsWithoutNarration: 1 }
    ]);
  });
});

describe('report reservations', () => {
  it('sums only settled upstream-priced rows that kept their reply and have a reservation', async () => {
    call({ prompt_type: 'narration', reserve_micros: 1000, cost_micros: 600 });
    call({ prompt_type: 'narration', reserve_micros: 1000, cost_micros: 200, retry: 1 });
    call({ prompt_type: 'summary', reserve_micros: 500, cost_micros: 100 });
    // Each of these would pull the ratio toward 1 or carry no reservation.
    call({ cost_source: 'computed' });
    call({ cost_source: 'estimated', status: 'swept' });
    call({ status: 'error' });
    call({ status: 'aborted' });
    call({ stopped: 1 });
    call({ reserve_micros: null });
    call({ started_at: daysAgo(8) });

    const { reservations } = await report();

    expect(reservations).toEqual({
      overall: { calls: 3, reserveMicros: 2500, costMicros: 900, ratio: 900 / 2500 },
      promptTypes: [
        { promptType: 'narration', calls: 2, reserveMicros: 2000, costMicros: 800, ratio: 0.4 },
        { promptType: 'summary', calls: 1, reserveMicros: 500, costMicros: 100, ratio: 0.2 }
      ]
    });
  });

  it('gives no ratio with nothing reserved', async () => {
    call({ reserve_micros: null });

    expect((await report()).reservations).toEqual({ overall: { calls: 0, reserveMicros: 0, costMicros: 0, ratio: null }, promptTypes: [] });
  });
});

describe('report clients', () => {
  it('judges a turn on all its rows, under its first row\'s build, only when that row is in range', async () => {
    // Counted: closed, no narration, first row in range. The later row's build does not split it.
    call({ turn_id: 'quiet', prompt_type: 'summary', client_version: '1.0.0' });
    call({ turn_id: 'quiet', prompt_type: null, client_version: '1.1.0' });
    // Counted: a turn whose rows record no prompt type has no narration call.
    call({ turn_id: 'untyped', prompt_type: null, client_version: '1.0.0' });
    // Left out: a narration call, even one after the summary.
    call({ turn_id: 'told', prompt_type: 'summary', client_version: '1.0.0' });
    call({ turn_id: 'told', prompt_type: 'narration', client_version: '1.0.0' });
    // Left out: still open.
    call({ turn_id: 'open', prompt_type: 'summary', client_version: '1.0.0' });
    call({ turn_id: 'open', prompt_type: 'summary', client_version: '1.0.0', status: 'open' });
    // Left out: its first row is before the range, and its narration sits there too.
    call({ turn_id: 'edge', prompt_type: 'narration', client_version: '1.0.0', started_at: daysAgo(8) });
    call({ turn_id: 'edge', prompt_type: 'summary', client_version: '1.0.0' });
    // Left out: no narration call, but its first row is before the range.
    call({ turn_id: 'early', prompt_type: 'summary', client_version: '1.0.0', started_at: daysAgo(8) });
    call({ turn_id: 'early', prompt_type: 'summary', client_version: '1.0.0' });

    const { clients } = await report();

    expect(clients).toEqual([
      { clientVersion: '1.0.0', calls: 8, turns: 6, costMicros: 800, turnsWithoutNarration: 2 },
      { clientVersion: '1.1.0', calls: 1, turns: 1, costMicros: 100, turnsWithoutNarration: 0 }
    ]);
  });
});

describe('report clients before versions were recorded', () => {
  it('leaves out rows older than the first versioned row, and keeps a later row with no version', async () => {
    call({ turn_id: 'before', client_version: null, started_at: daysAgo(3) });
    call({ turn_id: 'first', client_version: '1.0.0', started_at: daysAgo(2) });
    call({ turn_id: 'headerless', client_version: null, started_at: daysAgo(1) });

    expect((await report()).clients).toEqual([
      { clientVersion: '1.0.0', calls: 1, turns: 1, costMicros: 100, turnsWithoutNarration: 0 },
      { clientVersion: null, calls: 1, turns: 1, costMicros: 100, turnsWithoutNarration: 0 }
    ]);
  });

  it('lists no clients while no row has a version', async () => {
    call({ client_version: null });

    expect((await report()).clients).toEqual([]);
  });
});

describe('hostedUsageTelemetry schema step', () => {
  it('adds the three nullable columns to an existing table, once', () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE hosted_usage (id INTEGER PRIMARY KEY)');
    old.exec('INSERT INTO hosted_usage DEFAULT VALUES');

    expect(hostedUsageTelemetry.apply(old)).toBe(true);
    expect(old.prepare('SELECT max_tokens, reserve_micros, client_version FROM hosted_usage').get()).toEqual({
      max_tokens: null, reserve_micros: null, client_version: null
    });
    expect(hostedUsageTelemetry.apply(old)).toBe(false);
    old.close();
  });
});
