import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const { eraseUser } = require('../src/utils/eraseUser');
const { sweepHostedUsage } = require('../src/utils/sweepHostedUsage');
const { HOSTED_AI, REFUSALS } = require('../src/config/hostedAi');

/**
 * Formamorph AI metering: reservation, settlement, turns, the weekly budget and the window, over HTTP
 * against a fake upstream.
 *
 * Prices are dollars per million tokens, so here one prompt token costs 1 micro-dollar, one cached token 1
 * and one output token 3.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const TURN = 'x-formamorph-turn';
const MINUTE = 60 * 1000;

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const delta = (content) => event({ id: 'c1', choices: [{ delta: { content } }] });
const DONE = 'data: [DONE]\n\n';

// The fake upstream: each test sets `script`, and reads `received` for what it was sent. `held` keeps the
// responses a hanging script never ended, so `afterEach` can end them.
let script;
let received;
let held;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const entry = { body: JSON.parse(raw), closed: false };
    res.on('close', () => { entry.closed = !res.writableFinished; });
    received.push(entry);
    script(req, res, entry);
  });
});

/** Streams `events`, or answers one JSON body when not asked to stream. */
const answer = (events, reply) => (_req, res, entry) => {
  if (!entry.body.stream) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
  return res.end();
};

const plain = answer([delta('Hello'), DONE], { choices: [{ message: { role: 'assistant', content: 'Hi' } }] });

/** Sends headers and the given events, then hangs until `afterEach`. */
const hang = (...events) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
  held.push(res);
};

const BUDGET = 0.01; // 10,000 micro-dollars.
const SETTINGS = {
  models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 3, cached: 1 } }],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: {
    supporter: { window: 2000, budget: BUDGET },
    supporter_plus: { window: 4000, budget: BUDGET * 3 },
    supporter_top: { window: 8000, budget: BUDGET * 5 }
  },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 4,
  retentionDays: 30,
  // Out of the way: limits and the ceiling have their own file.
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null
};

const rnd = () => Math.random().toString(36).slice(2, 8);

/** An 18+ account linked to Patreon user `patreonUserId` on `tier`. */
const supporter = (tier = 'supporter', patreonUserId = `p-${rnd()}`) => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100, ...overrides });

const send = (user, body = chat(), turn = undefined) => {
  const req = request(app).post(ROUTE).set(authHeader(user));
  if (turn) req.set(TURN, turn);
  return req.send(body);
};

/** Start a call without waiting for it; supertest sends only once something awaits it. */
const fire = (...args) => { send(...args).then(() => {}, () => {}); };

const rows = () => db.prepare('SELECT * FROM hosted_usage ORDER BY id').all();
const lastRow = () => db.prepare('SELECT * FROM hosted_usage ORDER BY id DESC LIMIT 1').get();

/** Spend a subject's whole week in one call: its reservation alone reaches the budget. */
const exhaust = async (user) => {
  const res = await send(user, chat({ max_tokens: 1000 }));
  expect(res.status).toBe(200);
  db.prepare('UPDATE hosted_usage SET cost_micros = ? WHERE id = ?').run(BUDGET * 1_000_000, lastRow().id);
  return res;
};

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
  Setting.set(HOSTED_AI, SETTINGS);
  script = plain;
  received = [];
  held = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const res of held) res.end(delta('Hi'));
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM hosted_usage').run();
});

describe('the usage table', () => {
  it('holds counts and costs only, with the spec indexes and no foreign key', () => {
    const columns = db.prepare('PRAGMA table_info(hosted_usage)').all().map((column) => column.name);
    const indexes = db.prepare('PRAGMA index_list(hosted_usage)').all()
      .map((index) => db.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name).join(','));

    expect(columns).toEqual([
      'id', 'subject', 'user_id', 'turn_id', 'tier', 'estimated_prompt_tokens', 'prompt_tokens', 'cached_tokens',
      'output_tokens', 'cost_micros', 'cost_source', 'started_at', 'duration_ms', 'status', 'retry', 'stopped', 'model', 'prompt_type'
    ]);
    expect(indexes.sort()).toEqual(['started_at', 'subject,started_at']);
    expect(db.prepare('PRAGMA foreign_key_list(hosted_usage)').all()).toEqual([]);
  });

  it('never stores prompt or reply text', async () => {
    script = answer([delta('secret-reply'), DONE], {});

    await send(supporter(), chat({ stream: true, messages: [{ role: 'user', content: 'secret-prompt' }] }));

    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows())).not.toContain('secret');
  });
});

describe('the spend subject', () => {
  it('keeps the week when the Patreon membership moves to another account', async () => {
    const first = supporter('supporter', 'p-moving');
    await exhaust(first);

    PatreonLink.unlink(first.id);
    const second = supporter('supporter', 'p-moving');
    const res = await send(second);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('budget_exhausted');
  });

  it('keeps the week, and the rows, when the account is erased and made again', async () => {
    const first = supporter('supporter', 'p-erased');
    await exhaust(first);

    await eraseUser(first, { removeContent: true });
    const kept = rows();
    const again = supporter('supporter', 'p-erased');
    const res = await send(again);

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ subject: 'p-erased', user_id: null });
    expect(res.status).toBe(402);
  });

  it('sums each subject on its own', async () => {
    await exhaust(supporter());

    expect((await send(supporter())).status).toBe(200);
  });
});

describe('reservation', () => {
  it('records an open row with the worst case before the upstream answers', async () => {
    script = hang();
    const user = supporter();

    fire(user, chat({ stream: true, max_tokens: 5000 }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const row = lastRow();

    expect(row).toMatchObject({ status: 'open', cost_source: null, user_id: user.id, tier: 'supporter' });
    expect(row.estimated_prompt_tokens).toBeGreaterThan(0);
    // The prompt estimate at 1 each, plus the capped max_tokens at 3 each.
    expect(row.cost_micros).toBe(row.estimated_prompt_tokens + 1000 * 3);
  });

  it('admits parallel first calls only while the reservations before them stay under the budget', async () => {
    script = hang();
    const user = supporter();
    // Each reservation is just over 3,000 (1,000 output tokens at 3), so the fifth sees over 12,000.
    const settled = [];

    const calls = Array.from({ length: 6 }, () => send(user, chat({ stream: true, max_tokens: 1000 }))
      .then((res) => { settled.push(res); return res; }));
    await vi.waitFor(() => expect(received.length + settled.length).toBe(6));
    for (const res of held) res.end(delta('Hi'));
    const results = await Promise.all(calls);

    expect(received).toHaveLength(4);
    expect(results.filter((res) => res.status === 402)).toHaveLength(2);
  });
});

describe('settlement', () => {
  it('takes the cost from the usage block when it reports one', async () => {
    script = answer([delta('Hi'), event({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 7, cost: 0.0001234 } }), DONE]);

    await send(supporter(), chat({ stream: true }));

    expect(lastRow()).toMatchObject({
      status: 'ok', cost_source: 'upstream', cost_micros: 123, prompt_tokens: 40, cached_tokens: 0, output_tokens: 7
    });
    expect(lastRow().duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('takes the cost from a usage block that reports a cost and no token counts', async () => {
    script = answer([event({ choices: [], usage: { cost: 0.00005 } }), DONE]);

    await send(supporter(), chat({ stream: true }));

    expect(lastRow()).toMatchObject({ cost_source: 'upstream', cost_micros: 50 });
  });

  it('computes the cost from token counts and prices when the block has none', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, models: [{ ...SETTINGS.models[0], prices: { prompt: 4, completion: 3, cached: 1 } }] });
    script = answer([], { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6 } } });

    await send(supporter());

    // 4 uncached at 4, 6 cached at 1, 5 output at 3.
    expect(lastRow()).toMatchObject({ status: 'ok', cost_source: 'computed', cost_micros: 37, prompt_tokens: 10, cached_tokens: 6 });
  });

  it('prices cached tokens as prompt tokens when the model has no cached price', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, models: [{ ...SETTINGS.models[0], prices: { prompt: 4, completion: 3 } }] });
    script = answer([], { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6 } } });

    await send(supporter());

    expect(lastRow().cost_micros).toBe(10 * 4 + 5 * 3);
  });

  it('estimates a reply with no usage block from the prompt estimate and the text streamed', async () => {
    script = answer([delta('Hello there!'), DONE]);

    await send(supporter(), chat({ stream: true }));
    const row = lastRow();

    // 12 characters at 4 a token is 3 output tokens.
    expect(row).toMatchObject({ status: 'ok', cost_source: 'estimated', prompt_tokens: null, output_tokens: null });
    expect(row.cost_micros).toBe(row.estimated_prompt_tokens + 3 * 3);
  });

  it('counts streamed tool-call arguments and reasoning into the output estimate', async () => {
    const toolDelta = event({ choices: [{ delta: { reasoning: 'Hmm.', tool_calls: [{ index: 0, function: { arguments: '{"d":20}' } }] } }] });
    script = answer([toolDelta, DONE]);

    await send(supporter(), chat({ stream: true }));

    // 4 + 8 characters is 3 output tokens.
    expect(lastRow().cost_micros).toBe(lastRow().estimated_prompt_tokens + 3 * 3);
  });

  it('estimates a non-streamed reply with no usage block from its message', async () => {
    script = answer([], { choices: [{ message: { role: 'assistant', content: 'Hello there!' } }] });

    await send(supporter());

    expect(lastRow().cost_micros).toBe(lastRow().estimated_prompt_tokens + 3 * 3);
  });

  it('estimates a call the client left from what had streamed', async () => {
    script = hang(delta('Hello'));
    const user = supporter();
    const url = new URL(ROUTE, request(app).post(ROUTE).url);
    const payload = JSON.stringify(chat({ stream: true }));

    await new Promise((resolve) => {
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...authHeader(user) }
      }, (res) => res.once('data', () => { req.destroy(); resolve(); }));
      req.on('error', () => {});
      req.end(payload);
    });
    await vi.waitFor(() => expect(lastRow().status).toBe('aborted'));

    // 5 characters is 2 output tokens.
    expect(lastRow()).toMatchObject({ cost_source: 'estimated', cost_micros: lastRow().estimated_prompt_tokens + 2 * 3 });
  });

  it('estimates an upstream failure with nothing streamed at the prompt alone', async () => {
    script = (_req, res) => res.writeHead(500).end('{"error":"x"}');

    const res = await send(supporter());

    expect(res.status).toBe(502);
    expect(lastRow()).toMatchObject({ status: 'error', cost_source: 'estimated', cost_micros: lastRow().estimated_prompt_tokens });
  });

  it('estimates a call aborted at the idle limit from what had streamed', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, idleLimitSeconds: 1 });
    script = hang(delta('Hello there!'));

    const res = await send(supporter(), chat({ stream: true }));

    expect(res.text).toContain('event: error');
    expect(lastRow()).toMatchObject({ status: 'error', cost_source: 'estimated', cost_micros: lastRow().estimated_prompt_tokens + 3 * 3 });
  }, 10_000);

  it('records the upstream prompt count next to the estimate', async () => {
    script = answer([event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }), DONE]);

    await send(supporter(), chat({ stream: true }));

    expect(lastRow().prompt_tokens).toBe(9);
    expect(lastRow().estimated_prompt_tokens).toBeGreaterThan(0);
  });
});

describe('the hourly sweep', () => {
  it('settles a row still open past the turn limit at its reservation, and a late settle leaves it', async () => {
    script = hang();
    fire(supporter(), chat({ stream: true }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const reserved = lastRow().cost_micros;

    const early = sweepHostedUsage(new Date(Date.now() + 599 * 1000));
    const late = sweepHostedUsage(new Date(Date.now() + 601 * 1000));
    for (const res of held) res.end(delta('Hi') + event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
    held = [];
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    expect(early.settled).toBe(0);
    expect(late.settled).toBe(1);
    expect(lastRow()).toMatchObject({ status: 'swept', cost_source: 'estimated', cost_micros: reserved });
  });

  it('deletes rows past the retention period and keeps the rest', async () => {
    await send(supporter());
    await send(supporter());

    const kept = sweepHostedUsage(new Date(Date.now() + 29 * 24 * 60 * MINUTE));
    const gone = sweepHostedUsage(new Date(Date.now() + 31 * 24 * 60 * MINUTE));

    expect(kept.deleted).toBe(0);
    expect(gone.deleted).toBe(2);
    expect(rows()).toEqual([]);
  });
});

describe('turns', () => {
  it('issues a turn id on a first call and keeps it on the calls that carry it', async () => {
    const user = supporter();

    const first = await send(user);
    const second = await send(user, chat(), first.headers[TURN]);

    expect(first.headers[TURN]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.status).toBe(200);
    expect(second.headers[TURN]).toBe(first.headers[TURN]);
    expect(rows().map((row) => row.turn_id)).toEqual([first.headers[TURN], first.headers[TURN]]);
    expect((await send(user)).headers[TURN]).not.toBe(first.headers[TURN]);
  });

  it('lets a started turn finish past the budget, while a new turn is refused', async () => {
    const user = supporter();
    const first = await exhaust(user);

    const later = await send(user, chat(), first.headers[TURN]);
    const fresh = await send(user);

    expect(later.status).toBe(200);
    expect(fresh.status).toBe(402);
  });

  it('refuses a turn past its time limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const user = supporter();
    const turn = (await send(user)).headers[TURN];

    vi.setSystemTime(new Date('2026-10-30T12:09:59Z'));
    const inside = await send(user, chat(), turn);
    vi.setSystemTime(new Date('2026-10-30T12:10:00Z'));
    const outside = await send(user, chat(), turn);

    expect(inside.status).toBe(200);
    expect(outside.status).toBe(409);
    expect(outside.body).toEqual({ success: false, code: 'turn_expired', error: REFUSALS.turn_expired.error });
  });

  it('refuses a call past the turn call cap', async () => {
    const user = supporter();
    const turn = (await send(user)).headers[TURN];

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await send(user, chat(), turn)).status);

    expect(statuses).toEqual([200, 200, 200, 409]);
    expect(rows()).toHaveLength(4);
  });

  it('refuses a turn id it never issued, or one issued to another subject', async () => {
    const owner = supporter();
    const turn = (await send(owner)).headers[TURN];

    const unknown = await send(owner, chat(), '00000000-0000-4000-8000-000000000000');
    const foreign = await send(supporter(), chat(), turn);

    expect(unknown.body.code).toBe('turn_expired');
    expect(foreign.body.code).toBe('turn_expired');
    expect(received).toHaveLength(1);
  });

  it('lets a browser send and read the turn header', async () => {
    const res = await request(app).options(ROUTE)
      .set('Origin', 'https://formamorph.ai')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-formamorph-turn');
    const call = await send(supporter()).set('Origin', 'https://formamorph.ai');

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain(TURN);
    expect(call.headers['access-control-expose-headers'].toLowerCase()).toContain(TURN);
  });
});

describe('the weekly budget', () => {
  // 2026-11-02 and 2027-01-04 are Mondays. The first week here spans two months, the second two years.
  it.each([
    ['inside one month', '2026-11-03T12:00:00Z', '2026-11-08T23:59:00Z', '2026-11-09T00:00:00Z'],
    ['across two months', '2026-10-30T12:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'],
    ['across two years', '2026-12-31T12:00:00Z', '2027-01-01T00:00:00Z', '2027-01-04T00:00:00Z']
  ])('refuses a first call until the Monday reset, %s', async (_name, spentAt, stillRefusedAt, resetsAt) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(spentAt));
    const user = supporter();
    await exhaust(user);

    vi.setSystemTime(new Date(stillRefusedAt));
    const refused = await send(user);
    vi.setSystemTime(new Date(new Date(resetsAt).getTime() - 1000));
    const justBefore = await send(user);
    vi.setSystemTime(new Date(resetsAt));
    const nextWeek = await send(user);

    expect(refused.status).toBe(402);
    expect(refused.body).toEqual({
      success: false, code: 'budget_exhausted', error: REFUSALS.budget_exhausted.error, resetAt: new Date(resetsAt).toISOString()
    });
    expect(justBefore.status).toBe(402);
    expect(nextWeek.status).toBe(200);
  });

  it('lets a turn admitted before the reset finish after it, while a new turn is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T23:59:30Z'));
    const user = supporter();
    const first = await send(user);

    vi.setSystemTime(new Date('2026-11-02T00:00:10Z'));
    await exhaust(user);
    const finished = await send(user, chat(), first.headers[TURN]);
    const fresh = await send(user);

    expect(finished.status).toBe(200);
    expect(fresh.status).toBe(402);
  });

  it('admits a first call one micro-dollar under the budget', async () => {
    const user = supporter();
    await exhaust(user);
    db.prepare('UPDATE hosted_usage SET cost_micros = cost_micros - 1').run();

    expect((await send(user)).status).toBe(200);
  });

  it('applies a tier change at once against the same sum', async () => {
    const user = supporter('supporter', 'p-tiers');
    await exhaust(user);

    PatreonLink.setTier({ patreonUserId: 'p-tiers', tier: 'supporter_plus', pledgeStart: null, checkedAt: new Date().toISOString() });
    const upgraded = await send(user);
    PatreonLink.setTier({ patreonUserId: 'p-tiers', tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });
    const downgraded = await send(user);

    expect(upgraded.status).toBe(200);
    expect(downgraded.status).toBe(402);
    expect(rows().map((row) => row.tier)).toEqual(['supporter', 'supporter_plus']);
  });
});

describe('the window', () => {
  /** The estimate the server made for a body, read back from its row. */
  const estimateOf = async (body) => {
    await send(supporter('supporter_top'), body);
    return lastRow().estimated_prompt_tokens;
  };

  it('refuses only past the window plus the margin, and carries the window', async () => {
    const body = chat({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
    const estimate = await estimateOf(body);
    const at = (window) => ({ ...SETTINGS, tiers: { ...SETTINGS.tiers, supporter: { window, budget: BUDGET } } });

    Setting.set(HOSTED_AI, at(estimate - SETTINGS.tokenMargin));
    const edge = await send(supporter(), body);
    Setting.set(HOSTED_AI, at(estimate - SETTINGS.tokenMargin - 1));
    const over = await send(supporter(), body);

    expect(estimate).toBeGreaterThan(1000);
    expect(edge.status).toBe(200);
    expect(over.status).toBe(413);
    expect(over.body).toEqual({
      success: false, code: 'window_exceeded', error: REFUSALS.window_exceeded.error, window: estimate - SETTINGS.tokenMargin - 1
    });
  });

  it('counts tool schemas into the estimate', async () => {
    const tools = [{ type: 'function', function: { name: 'roll', parameters: { type: 'object', description: 'y'.repeat(4000) } } }];

    const without = await estimateOf(chat());
    const withTools = await estimateOf(chat({ tools }));

    expect(withTools - without).toBeGreaterThan(1000);
  });
});

describe('configuration', () => {
  it('pauses while the active model has no prompt or completion price, or the tier has no limits', async () => {
    const user = supporter();

    Setting.set(HOSTED_AI, { ...SETTINGS, models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1 } }] });
    const unpriced = await send(user);
    Setting.set(HOSTED_AI, { ...SETTINGS, tiers: { supporter_top: SETTINGS.tiers.supporter_top } });
    const untiered = await send(user);

    for (const res of [unpriced, untiered]) expect(res.body.code).toBe('service_paused');
    expect(received).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it('takes valid tier limits from an admin and refuses unknown tiers or fields', async () => {
    const admin = createUser({ username: `admin-${rnd()}`, accountType: 'admin' });
    const write = (value) => request(app).put(`/api/settings/${HOSTED_AI}`).set(authHeader(admin)).send({ value });

    const saved = await write(SETTINGS);
    const unknownTier = await write({ ...SETTINGS, tiers: { patron: { window: 1, budget: 1 } } });
    const extraField = await write({ ...SETTINGS, tiers: { supporter: { window: 1, budget: 1, cost: 1 } } });
    const badRatio = await write({ ...SETTINGS, tokenRatio: 0 });

    expect(saved.status).toBe(200);
    for (const res of [unknownTier, extraField, badRatio]) expect(res.status).toBe(400);
  });
});
