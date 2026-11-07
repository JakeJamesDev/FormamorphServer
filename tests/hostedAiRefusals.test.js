import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const HostedRefusal = require('../src/models/HostedRefusal');
const { eraseUser } = require('../src/utils/eraseUser');
const { sweepHostedUsage } = require('../src/utils/sweepHostedUsage');
const { HOSTED_AI, REFUSALS, refusalBody } = require('../src/config/hostedAi');
const { DAY_MS } = require('../src/config/time');

/**
 * Formamorph AI refusal totals, over HTTP against a fake upstream, read back through the admin usage report.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const REPORT = '/api/hosted-ai/admin/usage-report';
const BUDGET = 0.01; // 10,000 micro-dollars.
const CEILING = 0.001; // 1,000 micro-dollars.

const REPLY = { id: 'c1', choices: [{ message: { role: 'assistant', content: 'Hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

// `script` answers each upstream call.
let script;
const ok = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(REPLY));
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => script(req, res));
});

const SETTINGS = {
  models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 3 } }],
  activeModel: 'main',
  maxTokensCap: 100,
  idleLimitSeconds: 5,
  tiers: Object.fromEntries(['supporter', 'supporter_plus', 'supporter_top'].map((tier) => [tier, { window: 100_000, budget: BUDGET }])),
  tokenRatio: 4,
  tokenMargin: 0,
  turnLimitSeconds: 600,
  turnCallCap: 50,
  retentionDays: 30,
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null
};

const configure = (overrides) => Setting.set(HOSTED_AI, { ...SETTINGS, ...overrides });

const rnd = () => Math.random().toString(36).slice(2, 8);

/** An 18+ account on a Patreon tier. Its spend subject is `patreonUserId`. */
const supporter = (tier = 'supporter', patreonUserId = `p-${rnd()}`) => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 50, ...overrides });

const send = (user, body = chat()) => request(app).post(ROUTE).set(authHeader(user)).send(body);

/** A settled call already on the books today, for the week's allowance and the day's ceiling. */
const spent = (subject, costMicros) => db.prepare(`
  INSERT INTO hosted_usage (subject, turn_id, tier, estimated_prompt_tokens, cost_micros, cost_source, started_at, status)
  VALUES (?, ?, 'supporter', 1, ?, 'upstream', ?, 'ok')
`).run(subject, `turn-${rnd()}`, costMicros, new Date().toISOString());

const report = async (days = 7) => {
  const res = await request(app).get(`${REPORT}?days=${days}`).set(authHeader(createUser({ accountType: 'admin' })));
  expect(res.status).toBe(200);
  return res.body.data.refusals;
};

const stored = () => db.prepare('SELECT * FROM hosted_refusals ORDER BY id').all();
const today = () => new Date().toISOString().slice(0, 10);

/** Answer exactly as the refusal code says, with no extra fields. */
const expectRefusal = (res, code) => {
  expect(res.status).toBe(REFUSALS[code].status);
  expect(res.body).toEqual(refusalBody(code));
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
  configure({});
  script = ok;
  for (const table of ['hosted_refusals', 'hosted_usage', 'hosted_pause', 'patreon_links']) db.prepare(`DELETE FROM ${table}`).run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refusal totals', () => {
  it('counts each refusal family under its code and answers it unchanged', async () => {
    const minor = createUser({ username: `minor-${rnd()}` });
    expectRefusal(await send(minor), 'age_gate_required');

    const free = createUser({ username: `free-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, free.id);
    expectRefusal(await send(free), 'not_entitled');

    expectRefusal(await send(supporter(), { messages: 'not a list', max_tokens: 50 }), 'invalid_request');
    const parseError = await request(app).post(ROUTE).set(authHeader(supporter()))
      .set('Content-Type', 'application/json').send('{"messages": [');
    expectRefusal(parseError, 'invalid_request');

    const spender = supporter('supporter', 'p-spender');
    spent('p-spender', BUDGET * 1_000_000);
    const exhausted = await send(spender);
    expect(exhausted.status).toBe(REFUSALS.budget_exhausted.status);
    expect(exhausted.body).toMatchObject(refusalBody('budget_exhausted'));

    configure({ perMinuteLimit: 1 });
    const hasty = supporter();
    expect((await send(hasty)).status).toBe(200);
    expectRefusal(await send(hasty), 'rate_limited');

    configure({ dailyCeiling: CEILING });
    spent('p-other', CEILING * 1_000_000);
    expectRefusal(await send(supporter()), 'service_paused');

    const { days } = await report();

    expect(days).toEqual([
      { day: today(), code: 'age_gate_required', count: 1, accounts: 1 },
      { day: today(), code: 'budget_exhausted', count: 1, accounts: 1 },
      { day: today(), code: 'invalid_request', count: 2, accounts: 2 },
      { day: today(), code: 'not_entitled', count: 1, accounts: 1 },
      { day: today(), code: 'rate_limited', count: 1, accounts: 1 },
      { day: today(), code: 'service_paused', count: 1, accounts: 1 }
    ]);
  });

  it('does not count upstream_error, a provider failure', async () => {
    script = (_req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"down"}');

    expectRefusal(await send(supporter()), 'upstream_error');

    expect(stored()).toEqual([]);
    expect((await report()).days).toEqual([]);
  });

  it('adds a repeated refusal to one total, moving its last time and keeping its first', async () => {
    configure({ perMinuteLimit: 1 });
    const user = supporter('supporter_plus', 'p-looping');
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(`${today()}T00:00:01.000Z`);
    vi.setSystemTime(start);
    expect((await send(user)).status).toBe(200);

    for (let i = 0; i < 20; i += 1) expectRefusal(await send(user), 'rate_limited');
    vi.setSystemTime(start.getTime() + 30 * 1000);
    expectRefusal(await send(user), 'rate_limited');

    expect(stored()).toEqual([{
      id: expect.any(Number), day: today(), user_id: user.id, subject: 'p-looping', tier: 'supporter_plus', code: 'rate_limited',
      count: 21, first_at: start.toISOString(), last_at: new Date(start.getTime() + 30 * 1000).toISOString()
    }]);
  });

  it('stores an entitlement refusal with no subject and an empty tier, so it still adds to one total', async () => {
    const minor = createUser({ username: `minor-${rnd()}` });

    await send(minor);
    await send(minor);

    expect(stored()).toEqual([expect.objectContaining({ user_id: minor.id, subject: null, tier: '', code: 'age_gate_required', count: 2 })]);
  });

  it('still answers the same refusal when the write throws, and logs the failure', async () => {
    vi.spyOn(HostedRefusal, 'record').mockImplementation(() => { throw new Error('disk full'); });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    configure({ perMinuteLimit: 1 });
    const hasty = supporter();

    expectRefusal(await send(createUser({ username: `minor-${rnd()}` })), 'age_gate_required');
    expect((await send(hasty)).status).toBe(200);
    expectRefusal(await send(hasty), 'rate_limited');

    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith('Hosted refusal record failed:', expect.any(Error));
  });
});

describe('the report refusals section', () => {
  it('sums per tier and code, and counts the accounts refused for budget_exhausted', async () => {
    const first = supporter('supporter', 'p-first');
    const second = supporter('supporter_top', 'p-second');
    spent('p-first', BUDGET * 1_000_000);
    spent('p-second', BUDGET * 1_000_000);
    await send(first);
    await send(first);
    await send(second);
    await send(createUser({ username: `minor-${rnd()}` }));

    const refusals = await report();

    expect(refusals.tiers).toEqual([
      { tier: null, code: 'age_gate_required', count: 1, accounts: 1 },
      { tier: 'supporter', code: 'budget_exhausted', count: 2, accounts: 1 },
      { tier: 'supporter_top', code: 'budget_exhausted', count: 1, accounts: 1 }
    ]);
    expect(refusals.budgetExhaustedAccounts).toBe(2);
  });

  it('splits by UTC day and leaves out days before the range', async () => {
    const user = createUser({ username: `minor-${rnd()}` });
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const daysAgo of [5, 1, 1, 0]) {
      vi.setSystemTime(now - daysAgo * DAY_MS);
      await send(user);
    }
    vi.useRealTimers();
    const dayOf = (daysAgo) => new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);

    expect((await report(2)).days).toEqual([
      { day: dayOf(1), code: 'age_gate_required', count: 2, accounts: 1 },
      { day: dayOf(0), code: 'age_gate_required', count: 1, accounts: 1 }
    ]);
  });

  it('never names an account or a spend subject', async () => {
    const user = supporter('supporter', 'p-private-subject');
    spent('p-private-subject', BUDGET * 1_000_000);
    await send(user);

    const text = JSON.stringify(await report());

    expect(text).toContain('budget_exhausted');
    for (const trace of ['p-private-subject', user.id, user.username]) expect(text).not.toContain(trace);
  });

  it('counts an erased account in the totals but not in the distinct accounts', async () => {
    const erased = supporter('supporter', 'p-erased');
    const kept = supporter('supporter', 'p-kept');
    spent('p-erased', BUDGET * 1_000_000);
    spent('p-kept', BUDGET * 1_000_000);
    await send(erased);
    await send(kept);

    await eraseUser(erased, { removeContent: true });
    const refusals = await report();

    expect(refusals.days).toEqual([{ day: today(), code: 'budget_exhausted', count: 2, accounts: 1 }]);
    expect(refusals.budgetExhaustedAccounts).toBe(1);
  });
});

describe('retention and erasure', () => {
  it('sweeps totals whose first time is past retention and keeps newer ones', async () => {
    const user = createUser({ username: `minor-${rnd()}` });
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now - 31 * DAY_MS);
    await send(user);
    vi.setSystemTime(now - 29 * DAY_MS);
    await send(user);
    vi.useRealTimers();

    const swept = sweepHostedUsage(new Date(now));

    expect(swept.refusalsDeleted).toBe(1);
    expect(stored().map((row) => row.day)).toEqual([new Date(now - 29 * DAY_MS).toISOString().slice(0, 10)]);
  });

  it('judges a total by its first time, so a total refused again after the cutoff still goes', async () => {
    const user = createUser({ username: `minor-${rnd()}` });
    const sweptAt = new Date(`${today()}T12:00:00.000Z`);
    const cutoff = sweptAt.getTime() - 30 * DAY_MS;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(cutoff - 60 * 60 * 1000);
    await send(user);
    vi.setSystemTime(cutoff + 60 * 60 * 1000);
    await send(user);
    vi.useRealTimers();

    expect(stored()).toEqual([expect.objectContaining({ count: 2 })]);
    expect(sweepHostedUsage(sweptAt).refusalsDeleted).toBe(1);
    expect(stored()).toEqual([]);
  });

  it('nulls the account on an erased account\'s totals and keeps them', async () => {
    const user = supporter('supporter', 'p-gone');
    spent('p-gone', BUDGET * 1_000_000);
    await send(user);
    await send(user);

    await eraseUser(user, { removeContent: true });

    expect(stored()).toEqual([expect.objectContaining({ user_id: null, subject: 'p-gone', code: 'budget_exhausted', count: 2 })]);
  });
});

describe('the hostedRefusals schema step', () => {
  it('creates the table once, keyed by day, account, code and tier', () => {
    const fresh = new Database(':memory:');
    const step = require('../src/schema/steps/hostedRefusals');

    expect(step.apply(fresh)).toBe(true);
    expect(step.apply(fresh)).toBe(false);
    const unique = fresh.prepare('PRAGMA index_list(hosted_refusals)').all().filter((index) => index.unique && index.origin === 'c');
    expect(unique.map((index) => fresh.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name)))
      .toEqual([['day', 'user_id', 'code', 'tier']]);
    expect(fresh.prepare('PRAGMA foreign_key_list(hosted_refusals)').all()).toEqual([]);
    fresh.close();
  });
});
