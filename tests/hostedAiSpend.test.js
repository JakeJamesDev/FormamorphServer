import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const HostedUsage = require('../src/models/HostedUsage');
const { HOSTED_AI, REFUSALS } = require('../src/config/hostedAi');

/**
 * Formamorph AI spend controls: what one spend subject can spend in a week however many turn ids it holds,
 * over HTTP against a fake upstream.
 *
 * One prompt token costs 1 micro-dollar and one output token 3. A call at window plus margin and the output
 * cap costs 2,050 + 3,000 = 5,050, so the grace is 4 × 5,050 = 20,200.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const TURN = 'x-formamorph-turn';

const BUDGET_MICROS = 10_000;
const LARGEST_CALL = 5_050;
const GRACE = 20_200;
const BOUND = BUDGET_MICROS + 2 * GRACE;
const CALL_CAP = 4;

const SETTINGS = {
  models: [
    { id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 3 } },
    { id: 'pricey', model: 'vendor/model-b', prices: { prompt: 2, completion: 6 } }
  ],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: {
    supporter: { window: 2000, budget: 0.01 },
    supporter_plus: { window: 4000, budget: 0.03 },
    supporter_top: { window: 8000, budget: 0.05 }
  },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: CALL_CAP,
  retentionDays: 30,
  parallelLimit: 500,
  perMinuteLimit: 10_000,
  dailyCeiling: 1000,
  balanceThreshold: null
};

// Answers with every token it was allowed and no usage block, so each call settles at its reservation.
let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    received += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'x'.repeat(body.max_tokens * 4) } }]
    }));
  });
});

const rnd = () => Math.random().toString(36).slice(2, 8);

const supporter = (tier = 'supporter') => {
  const user = createUser({ username: `sup-${rnd()}` });
  const subject = `p-${rnd()}`;
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: subject, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return { user, subject };
};

const cheap = { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1 };

// 2,050 tokens at four characters each, counting the JSON around the content.
const WRAPPER_CHARS = JSON.stringify([{ role: 'user', content: '' }]).length;
const largest = { messages: [{ role: 'user', content: 'x'.repeat(2050 * 4 - WRAPPER_CHARS) }], max_tokens: 1000 };

const send = (user, body, turn = undefined) => {
  const req = request(app).post(ROUTE).set(authHeader(user));
  if (turn) req.set(TURN, turn);
  return req.send(body);
};

const spent = (subject) => db
  .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS total FROM hosted_usage WHERE subject = ?')
  .get(subject).total;

/** Open `count` turns on the cheapest call and keep every id. */
const stockpile = async (user, count) => {
  const turns = [];
  for (let i = 0; i < count; i += 1) {
    const res = await send(user, cheap);
    expect(res.status).toBe(200);
    turns.push(res.headers[TURN]);
  }
  return turns;
};

/** Spend the week through real calls until a new turn is refused. */
const spendTheWeek = async (user) => {
  for (let res = await send(user, largest); res.status !== 402; res = await send(user, largest)) {
    expect(res.status).toBe(200);
  }
};

/** Spend on another turn of the subject, already settled. */
const otherSpend = ({ user, subject }, costMicros, startedAt = new Date().toISOString()) => {
  const id = HostedUsage.open({
    subject, userId: user.id, turnId: `other-${rnd()}`, tier: 'supporter', model: 'main', estimatedPromptTokens: 0, costMicros, startedAt
  });
  HostedUsage.settle(id, { status: 'ok', costSource: 'computed', costMicros, promptTokens: 0, cachedTokens: 0, outputTokens: 0, durationMs: 1 });
};

/** The whole stockpile attack, one call at a time, and what the subject has spent after it. */
const attack = async (count) => {
  const account = supporter();
  const turns = await stockpile(account.user, count);
  await spendTheWeek(account.user);

  const statuses = [];
  for (const turn of turns) {
    for (let i = 1; i < CALL_CAP; i += 1) statuses.push((await send(account.user, largest, turn)).status);
  }
  return { total: spent(account.subject), statuses };
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
  received = 0;
});

afterEach(() => {
  vi.useRealTimers();
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM hosted_usage').run();
});

describe('a client that stockpiles turn ids', () => {
  it('spends the same, within the bound, whether it holds a few turns or many', async () => {
    const small = await attack(4);
    const large = await attack(24);

    expect(small.total).toBeGreaterThan(BUDGET_MICROS);
    expect(small.total).toBeLessThanOrEqual(BOUND);
    expect(large.total).toBeLessThanOrEqual(BOUND);
    expect(Math.abs(large.total - small.total)).toBeLessThanOrEqual(LARGEST_CALL);
    expect(large.statuses.filter((status) => status === 402).length).toBeGreaterThan(0);
  });

  it('stays within the bound when every held turn redeems at once', async () => {
    const { user, subject } = supporter();
    const turns = await stockpile(user, 24);
    await spendTheWeek(user);

    const calls = turns.flatMap((turn) => Array.from({ length: CALL_CAP - 1 }, () => send(user, largest, turn)));
    const statuses = (await Promise.all(calls)).map((res) => res.status);

    expect(statuses.filter((status) => status === 402).length).toBeGreaterThan(0);
    expect(spent(subject)).toBeLessThanOrEqual(BOUND);
  });

  it('refuses a continuation past the level with its resetAt, and nothing reaches the upstream', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const account = supporter();
    const [turn] = await stockpile(account.user, 1);
    otherSpend(account, BUDGET_MICROS + GRACE);
    const before = received;

    const res = await send(account.user, largest, turn);

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      success: false, code: 'budget_exhausted', error: REFUSALS.budget_exhausted.error, resetAt: '2026-11-09T00:00:00.000Z'
    });
    expect(received).toBe(before);
  });

  it('answers turn_expired, not the budget, for a held turn past the turn limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const { user } = supporter();
    const turns = await stockpile(user, 2);
    await spendTheWeek(user);

    vi.setSystemTime(new Date('2026-11-03T12:10:00Z'));
    const codes = [];
    for (const turn of turns) codes.push((await send(user, largest, turn)).body.code);

    expect(codes).toEqual(['turn_expired', 'turn_expired']);
  });
});

describe('the level a continuation stops at', () => {
  // Budget plus turnCallCap × (window + margin at the prompt price + maxTokensCap at the completion price).
  it.each([
    { name: 'the base settings', level: 30_200 },
    { name: 'a higher turn call cap', turnCallCap: 8, level: 50_400 },
    { name: 'a higher output cap', maxTokensCap: 2000, level: 42_200 },
    { name: 'a larger margin', tokenMargin: 150, level: 30_600 },
    { name: "a larger tier's window and budget", tier: 'supporter_plus', level: 58_200 }
  ])('is the budget plus the grace under $name', async ({ tier, level, ...overrides }) => {
    Setting.set(HOSTED_AI, { ...SETTINGS, ...overrides });
    const account = supporter(tier);
    const [turn] = await stockpile(account.user, 1);

    otherSpend(account, level - 1);
    const under = await send(account.user, cheap, turn);
    otherSpend(account, 1);
    const at = await send(account.user, cheap, turn);

    expect(under.status).toBe(200);
    expect(at.status).toBe(402);
    expect(at.body.code).toBe('budget_exhausted');
  });

  it("uses the prices of the turn's model, not the active one", async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, activeModel: 'pricey' });
    const account = supporter();
    const [turn] = await stockpile(account.user, 1);
    Setting.set(HOSTED_AI, SETTINGS);

    // Twice the prices: 10,000 + 4 × 10,100.
    otherSpend(account, 50_399);
    const under = await send(account.user, cheap, turn);
    otherSpend(account, 1);
    const at = await send(account.user, cheap, turn);

    expect(under.status).toBe(200);
    expect(at.status).toBe(402);
  });

  it('does not count the turn against itself', async () => {
    const account = supporter();
    const [turn] = await stockpile(account.user, 1);
    otherSpend(account, 30_199);

    const statuses = [];
    for (let i = 1; i < CALL_CAP; i += 1) statuses.push((await send(account.user, largest, turn)).status);

    expect(statuses).toEqual([200, 200, 200]);
  });

  it("takes only this week's part of a turn that crosses the reset", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T23:55:00Z'));
    const account = supporter();
    const turn = (await send(account.user, largest)).headers[TURN];
    expect((await send(account.user, largest, turn)).status).toBe(200);

    vi.setSystemTime(new Date('2026-11-02T00:01:00Z'));
    otherSpend(account, 30_200);
    const res = await send(account.user, cheap, turn);

    expect(res.status).toBe(402);
    expect(res.body.resetAt).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('an honest turn', () => {
  it('finishes past the budget when it started under it, and the next turn is refused', async () => {
    const { user, subject } = supporter();
    expect((await send(user, largest)).status).toBe(200);

    const first = await send(user, largest);
    const statuses = [];
    for (let i = 1; i < CALL_CAP; i += 1) statuses.push((await send(user, largest, first.headers[TURN])).status);

    expect(statuses).toEqual([200, 200, 200]);
    expect(spent(subject)).toBe(5 * LARGEST_CALL);
    expect(spent(subject)).toBeGreaterThan(BUDGET_MICROS);
    expect((await send(user, cheap)).status).toBe(402);
  });
});
