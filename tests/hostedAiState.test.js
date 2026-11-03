import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const Database = require('better-sqlite3');
const warningAckWeek = require('../src/schema/steps/warningAckWeek');
const HostedGrant = require('../src/models/HostedGrant');
const HostedProviderSpend = require('../src/models/HostedProviderSpend');
const { checkPause } = require('../src/utils/hostedPause');
const { eraseUser } = require('../src/utils/eraseUser');
const { HOSTED_AI, REFUSALS } = require('../src/config/hostedAi');
const { entitlement } = require('../src/utils/hostedState');

/**
 * Formamorph AI hosted state, warnings, grants and the admin routes, over HTTP.
 *
 * Prices are dollars per million tokens, so here one prompt token costs 1 micro-dollar and one output token 3.
 */

const BASE = '/api/hosted-ai';
const CHAT = `${BASE}/chat/completions`;
const TURN = 'x-formamorph-turn';

let script;
let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const entry = { body: JSON.parse(raw) };
    received.push(entry);
    script(req, res, entry);
  });
});

const USAGE = { prompt_tokens: 5, completion_tokens: 2 };
const answer = (_req, res, entry) => {
  if (!entry.body.stream) {
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: 'Hi' } }], usage: USAGE }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"id":"c1","choices":[{"delta":{"content":"Hello"}}]}\n\n');
  res.write(`data: ${JSON.stringify({ id: 'c1', choices: [], usage: USAGE })}\n\n`);
  return res.end('data: [DONE]\n\n');
};

const MODELS = [
  { id: 'first', model: 'vendor/model-a', prices: { prompt: 1, completion: 3 }, capabilities: { tools: true, reasoning: 'a' } },
  { id: 'second', model: 'vendor/model-b', prices: { prompt: 2, completion: 6 }, capabilities: { tools: false, reasoning: 'b' } }
];
const SETTINGS = {
  models: MODELS,
  activeModel: 'first',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: {
    supporter: { window: 2000, budget: 0.01, turnCost: 0.002 },
    supporter_plus: { window: 4000, budget: 0.03, turnCost: 0.004 },
    supporter_top: { window: 8000, budget: 0.05, turnCost: 0.006 }
  },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 4,
  retentionDays: 30,
  warnThresholds: [75, 90],
  turnSample: { recent: 5, min: 3 },
  // Out of the way: limits and the ceiling have their own file.
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null
};

const rnd = () => Math.random().toString(36).slice(2, 8);

const account = (accountType = 'normal') => {
  const user = createUser({ username: `acct-${rnd()}`, accountType });
  Policy.accept(Policy.AGE_GATE, user.id);
  return user;
};

const supporter = (tier = 'supporter', patreonUserId = `p-${rnd()}`) => {
  const user = account();
  PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const futureIso = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();

const state = (user) => request(app).get(`${BASE}/state`).set(authHeader(user));

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100, ...overrides });
const send = (user, body = chat(), turn = undefined) => {
  const req = request(app).post(CHAT).set(authHeader(user));
  if (turn) req.set(TURN, turn);
  return req.send(body);
};

/** Insert settled rows directly, one per entry of `turns`: each entry lists that turn's call costs. */
const settledTurns = (subject, turns, promptType = 'narration') => {
  const insert = db.prepare(`
    INSERT INTO hosted_usage (subject, turn_id, tier, prompt_type, estimated_prompt_tokens, cost_micros, started_at, status, cost_source)
    VALUES (?, ?, 'supporter', ?, 1, ?, ?, 'ok', 'upstream')
  `);
  const batch = rnd();
  turns.forEach((costs, i) => costs.forEach((cost) => insert.run(subject, `turn-${batch}-${i}`, promptType, cost, new Date().toISOString())));
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
  script = answer;
  received = [];
});

afterEach(() => {
  vi.useRealTimers();
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM hosted_usage').run();
  db.prepare('DELETE FROM hosted_grants').run();
  db.prepare('DELETE FROM hosted_provider_spend').run();
  db.prepare('DELETE FROM hosted_pause').run();
  db.prepare('DELETE FROM hosted_warning_acks').run();
});

describe('the hosted state route', () => {
  it('needs a signed-in account', async () => {
    expect((await request(app).get(`${BASE}/state`)).status).toBe(401);
  });

  it('returns the tier, window, caps, active model and usage, and no cost field', async () => {
    const user = supporter('supporter_plus');

    const res = await state(user);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      tier: 'supporter_plus',
      state: 'ready',
      window: 4000,
      turnLimitSeconds: 600,
      maxTokens: 1000,
      tokenMargin: 50,
      model: { id: 'first', capabilities: { tools: true, reasoning: 'a' } },
      percentUsed: 0,
      turnsLeft: 7,
      resetAt: expect.any(String),
      warnThresholds: [75, 90],
      breakdown: {},
      breakdownThreshold: 10,
      acknowledged: []
    });
    const reset = new Date(res.body.data.resetAt);
    expect([reset.getUTCDay(), reset.getUTCHours(), reset.getUTCMinutes()]).toEqual([1, 0, 0]);
    expect(Object.keys(res.body.data).filter((key) => /cost|price|budget|micro|dollar|spend/i.test(key))).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/cost|price|budget|micro|dollar|spend/i);
  });

  it('says locked without an entitlement and age-gate without the age gate', async () => {
    const plain = account();
    const unconfirmed = createUser({ username: `young-${rnd()}` });
    PatreonLink.link({ userId: unconfirmed.id, patreonUserId: `p-${rnd()}`, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });

    expect((await state(plain)).body.data).toMatchObject({ tier: null, state: 'locked', window: null, turnLimitSeconds: null, percentUsed: null });
    expect((await state(unconfirmed)).body.data).toMatchObject({ tier: 'supporter', state: 'age-gate', window: null, turnLimitSeconds: null });
  });

  it('says paused when the proxy has no active model to send to', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, models: [], activeModel: null });

    expect((await state(supporter())).body.data).toMatchObject({ state: 'paused', window: null, turnLimitSeconds: null, model: null });
  });

  it('says paused while the day is paused, ahead of exhausted, and not once an admin lifts it', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, dailyCeiling: 0.01 });
    const user = supporter('supporter', 'p-paused');
    settledTurns('p-paused', [[10000]]);
    checkPause(new Date(), 10000);

    const paused = await state(user);
    await request(app).post(`${BASE}/pause/lift`).set(authHeader(account('admin')));
    const lifted = await state(user);

    expect(paused.body.data).toMatchObject({ state: 'paused', window: 2000, turnLimitSeconds: 600, percentUsed: 100 });
    expect(lifted.body.data.state).toBe('exhausted');
  });

  it('says warned from the first threshold and exhausted at the budget', async () => {
    const user = supporter('supporter', 'p-fill');

    settledTurns('p-fill', [[8000]]);
    expect((await state(user)).body.data).toMatchObject({ state: 'warned', percentUsed: 80 });

    settledTurns('p-fill', [[2000]]);
    expect((await state(user)).body.data).toMatchObject({ state: 'exhausted', percentUsed: 100, turnsLeft: 0 });
  });

  it('reads turns left from the average cost of recent turns, grouped by turn id', async () => {
    const user = supporter('supporter', 'p-avg');
    // Three turns of two calls each: 400 + 600 = 1,000 a turn, however many calls it took.
    settledTurns('p-avg', [[400, 600], [400, 600], [400, 600]]);

    const res = await state(user);

    // 3,000 spent of 10,000; 7,000 left at 1,000 a turn. Per call it would be 1,400 left a call.
    expect(res.body.data).toMatchObject({ percentUsed: 30, turnsLeft: 7 });
  });

  it('falls back to the tier figure with too few recent turns', async () => {
    const user = supporter('supporter', 'p-few');
    settledTurns('p-few', [[500], [500]]);

    // 1,000 spent; 9,000 left at the 2,000 fallback.
    expect((await state(user)).body.data).toMatchObject({ percentUsed: 10, turnsLeft: 4 });
  });

  it('leaves out a turn that still has a call open', async () => {
    const user = supporter('supporter', 'p-open');
    settledTurns('p-open', [[1000], [1000], [1000]]);
    db.prepare(`
      INSERT INTO hosted_usage (subject, turn_id, tier, prompt_type, estimated_prompt_tokens, cost_micros, started_at, status)
      VALUES ('p-open', 'still-going', 'supporter', 'narration', 1, 5000, ?, 'open')
    `).run(new Date().toISOString());

    // The open turn's 5,000 reservation counts against the budget but not toward the average.
    expect((await state(user)).body.data).toMatchObject({ percentUsed: 80, turnsLeft: 2 });
  });

  it('leaves out a turn whose only open call is not narration', async () => {
    const user = supporter('supporter', 'p-open-bg');
    settledTurns('p-open-bg', [[1000], [1000], [1000]]);
    const insert = db.prepare(`
      INSERT INTO hosted_usage (subject, turn_id, tier, prompt_type, estimated_prompt_tokens, cost_micros, started_at, status)
      VALUES ('p-open-bg', 'mixed', 'supporter', ?, 1, 100, ?, ?)
    `);
    insert.run('narration', new Date().toISOString(), 'ok');
    insert.run('summary', new Date().toISOString(), 'open');

    // 3,100 spent; the mixed turn is out of the sample, so the average stays 1,000.
    expect((await state(user)).body.data).toMatchObject({ turnsLeft: 6 });
  });

  it('averages only turns that hold a narration call, summing all their calls', async () => {
    const user = supporter('supporter', 'p-narr');
    settledTurns('p-narr', [[400, 600], [400, 600], [400, 600]]);
    // Cheap background turns, one with no type recorded, must not pull the average down.
    settledTurns('p-narr', [[10], [10], [10]], 'summary');
    settledTurns('p-narr', [[10], [10]], null);

    // 3,050 spent; 6,950 left at 1,000 a turn.
    expect((await state(user)).body.data).toMatchObject({ turnsLeft: 6 });
  });

  it('falls back to the tier figure when only non-narration turns exist', async () => {
    const user = supporter('supporter', 'p-nonarr');
    settledTurns('p-nonarr', [[100], [100], [100], [100]], 'summary');
    settledTurns('p-nonarr', [[100], [100], [100]], null);

    // 700 spent; 9,300 left at the 2,000 fallback.
    expect((await state(user)).body.data).toMatchObject({ turnsLeft: 4 });
  });
});

describe('warning acknowledgments', () => {
  const ack = (user, threshold) => request(app).post(`${BASE}/warnings/${threshold}/ack`).set(authHeader(user));

  it('records a warning for this week, for this account only', async () => {
    const user = supporter();
    const other = supporter();

    const res = await ack(user, 75);

    expect(res.status).toBe(200);
    expect((await state(user)).body.data.acknowledged).toEqual([75]);
    expect((await state(other)).body.data.acknowledged).toEqual([]);
  });

  it('is the same on a repeat and keeps both thresholds', async () => {
    const user = supporter();

    await ack(user, 90);
    await ack(user, 75);
    await ack(user, 75);

    expect((await state(user)).body.data.acknowledged).toEqual([75, 90]);
  });

  it('refuses a number that is not a warning threshold', async () => {
    const user = supporter();

    expect((await ack(user, 50)).status).toBe(400);
    expect((await ack(user, 'abc')).status).toBe(400);
    expect((await state(user)).body.data.acknowledged).toEqual([]);
  });

  it('returns a custom list and accepts exactly those values', async () => {
    Setting.set(HOSTED_AI, { ...SETTINGS, warnThresholds: [50, 60, 95] });
    const user = supporter('supporter', 'p-custom');

    expect((await state(user)).body.data.warnThresholds).toEqual([50, 60, 95]);
    for (const threshold of [50, 60, 95]) expect((await ack(user, threshold)).status).toBe(200);
    for (const threshold of [75, 90]) expect((await ack(user, threshold)).status).toBe(400);

    settledTurns('p-custom', [[5500]]);
    expect((await state(user)).body.data).toMatchObject({ state: 'warned', percentUsed: 55 });
  });

  it.each([null, []])('falls back to the default when the setting holds %j, so warned is reachable', async (unset) => {
    Setting.set(HOSTED_AI, { ...SETTINGS, warnThresholds: unset });
    const user = supporter('supporter', 'p-default');

    expect((await state(user)).body.data.warnThresholds).toEqual([75, 90]);
    expect((await ack(user, 75)).status).toBe(200);
    expect((await ack(user, 90)).status).toBe(200);
    expect((await ack(user, 50)).status).toBe(400);

    settledTurns('p-default', [[8000]]);
    expect((await state(user)).body.data).toMatchObject({ state: 'warned', percentUsed: 80 });
  });

  it('shows an earlier week as not acknowledged', async () => {
    const user = supporter();
    HostedGrant.acknowledge(user.id, '2020-01-06', 75);

    expect((await state(user)).body.data.acknowledged).toEqual([]);
  });

  it('applies an acknowledgment across a month change inside its week, and again the next Monday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const user = supporter();
    await ack(user, 90);

    vi.setSystemTime(new Date('2026-11-01T23:59:00Z'));
    const sameWeek = (await state(user)).body.data.acknowledged;
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    const nextWeek = (await state(user)).body.data.acknowledged;

    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await ack(user, 75);
    vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
    const sameMonthNextWeek = (await state(user)).body.data.acknowledged;

    expect(sameWeek).toEqual([90]);
    expect(nextWeek).toEqual([]);
    expect(sameMonthNextWeek).toEqual([]);
  });

  it('renames the old month column and leaves old monthly rows unmatched', async () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE hosted_warning_acks (
        user_id TEXT NOT NULL, month TEXT NOT NULL, threshold INTEGER NOT NULL, PRIMARY KEY (user_id, month, threshold)
      );
      INSERT INTO hosted_warning_acks VALUES ('u1', '2026-11', 75);
    `);

    const changed = warningAckWeek.apply(legacy);

    expect(changed).toBe(true);
    expect(legacy.prepare('SELECT user_id, week FROM hosted_warning_acks').all()).toEqual([{ user_id: 'u1', week: '2026-11' }]);
    expect(warningAckWeek.apply(legacy)).toBe(false);
  });
});

describe('usage after a call', () => {
  // 11 micro-dollars spent (5 prompt at 1, 2 output at 3) of a 50 micro-dollar budget.
  beforeEach(() => {
    Setting.set(HOSTED_AI, {
      ...SETTINGS,
      tiers: { ...SETTINGS.tiers, supporter: { window: 2000, budget: 0.00005, turnCost: 0.00001 } }
    });
  });

  it('streams a usage event after the settle and before [DONE]', async () => {
    const res = await send(supporter(), chat({ stream: true }));

    const at = res.text.indexOf('event: usage\ndata: ');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(res.text.indexOf('data: [DONE]'));
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const event = JSON.parse(res.text.slice(at).split('\n')[1].slice(6));
    // 11 of 50 is 22%; 39 left at the 10 fallback is 3 turns.
    expect(event).toEqual({ percentUsed: 22, turnsLeft: 3, resetAt: expect.any(String) });
  });

  it('sends the same state in a header on a non-streamed call, and exposes the header to browsers', async () => {
    const res = await send(supporter());

    expect(JSON.parse(res.headers['x-formamorph-usage'])).toEqual({ percentUsed: 22, turnsLeft: 3, resetAt: expect.any(String) });
    expect(res.headers['access-control-expose-headers']).toContain('X-Formamorph-Usage');
  });

  it('counts the call it reports', async () => {
    const user = supporter();

    const first = await send(user);
    const second = await send(user, chat(), first.headers[TURN]);

    expect(JSON.parse(first.headers['x-formamorph-usage']).percentUsed).toBe(22);
    expect(JSON.parse(second.headers['x-formamorph-usage']).percentUsed).toBe(44);
  });
});

describe('grants', () => {
  const create = (actor, body) => request(app).post(`${BASE}/admin/grants`).set(authHeader(actor)).send(body);

  it('lets a moderator create, list and revoke a grant with an end date', async () => {
    const mod = account('mod');
    const target = account();

    const made = await create(mod, { userId: target.id, tier: 'supporter_top', endsAt: futureIso() });
    const listed = await request(app).get(`${BASE}/admin/grants`).set(authHeader(mod));
    const revoked = await request(app).delete(`${BASE}/admin/grants/${made.body.data.id}`).set(authHeader(mod));

    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ userId: target.id, username: target.username, tier: 'supporter_top', revokedAt: null });
    expect(listed.body.data.map((grant) => grant.id)).toEqual([made.body.data.id]);
    expect(revoked.body.data.revokedAt).toEqual(expect.any(String));
    expect(JSON.stringify(listed.body)).not.toMatch(/cost|micro|spend/i);
  });

  it('refuses a normal account', async () => {
    const target = account();

    expect((await create(account(), { userId: target.id, tier: 'supporter', endsAt: futureIso() })).status).toBe(403);
    expect((await request(app).get(`${BASE}/admin/grants`).set(authHeader(account()))).status).toBe(403);
  });

  it('refuses a bad account, tier or end date', async () => {
    const mod = account('mod');
    const target = account();
    const past = new Date(Date.now() - 1000).toISOString();

    expect((await create(mod, { userId: 'nobody', tier: 'supporter', endsAt: futureIso() })).status).toBe(400);
    expect((await create(mod, { userId: target.id, tier: 'gold', endsAt: futureIso() })).status).toBe(400);
    expect((await create(mod, { userId: target.id, tier: 'supporter' })).status).toBe(400);
    expect((await create(mod, { userId: target.id, tier: 'supporter', endsAt: past })).status).toBe(400);
    expect((await request(app).delete(`${BASE}/admin/grants/9999`).set(authHeader(mod))).status).toBe(404);
  });

  it('entitles an account that has no pledge, and sums its spend by grant id', async () => {
    const target = account();
    const grant = HostedGrant.create({ userId: target.id, tier: 'supporter_plus', endsAt: futureIso(), createdBy: null });

    const res = await send(target);

    expect(res.status).toBe(200);
    expect((await state(target)).body.data).toMatchObject({ tier: 'supporter_plus', window: 4000 });
    expect(db.prepare('SELECT subject, tier FROM hosted_usage').all()).toEqual([{ subject: `grant:${grant.id}`, tier: 'supporter_plus' }]);

    const admin = account('admin');
    const spend = await request(app).get(`${BASE}/admin/spend/grant:${grant.id}`).set(authHeader(admin));
    expect(spend.body.data).toMatchObject({ subject: `grant:${grant.id}`, calls: 1, turns: 1, costMicros: 11 });
  });

  it('stops entitling at its end date', async () => {
    const target = account();
    const grant = HostedGrant.create({ userId: target.id, tier: 'supporter', endsAt: futureIso(), createdBy: null });
    expect((await send(target)).status).toBe(200);

    db.prepare('UPDATE hosted_grants SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), grant.id);

    const res = await send(target);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_entitled');
    expect((await state(target)).body.data.state).toBe('locked');
  });

  it('stops entitling when revoked', async () => {
    const mod = account('mod');
    const target = account();
    const made = await create(mod, { userId: target.id, tier: 'supporter', endsAt: futureIso() });
    expect((await send(target)).status).toBe(200);

    await request(app).delete(`${BASE}/admin/grants/${made.body.data.id}`).set(authHeader(mod));

    expect((await send(target)).body.code).toBe('not_entitled');
  });

  it('gives the higher tier when a grant and a pledge both exist, either way round', async () => {
    const up = supporter('supporter', 'p-up');
    HostedGrant.create({ userId: up.id, tier: 'supporter_top', endsAt: futureIso(), createdBy: null });
    const down = supporter('supporter_top', 'p-down');
    HostedGrant.create({ userId: down.id, tier: 'supporter', endsAt: futureIso(), createdBy: null });

    expect((await state(up)).body.data.tier).toBe('supporter_top');
    expect((await state(down)).body.data.tier).toBe('supporter_top');
  });

  it('keeps the pledge as the spend subject when a grant only matches it', async () => {
    const user = supporter('supporter_plus', 'p-same');
    HostedGrant.create({ userId: user.id, tier: 'supporter_plus', endsAt: futureIso(), createdBy: null });

    await send(user);

    expect(db.prepare('SELECT subject FROM hosted_usage').all()).toEqual([{ subject: 'p-same' }]);
  });

  it('goes with the account on erasure, and the usage rows stay with their subject', async () => {
    const target = account();
    const grant = HostedGrant.create({ userId: target.id, tier: 'supporter', endsAt: futureIso(), createdBy: null });
    await send(target);

    await eraseUser(target, { removeContent: true });

    expect(db.prepare('SELECT COUNT(*) AS n FROM hosted_grants').get().n).toBe(0);
    expect(db.prepare('SELECT subject, user_id FROM hosted_usage').all()).toEqual([{ subject: `grant:${grant.id}`, user_id: null }]);
  });
});

describe('the admin routes', () => {
  const asAdmin = () => account('admin');

  it('lets an admin edit the approved models and pick the active one, and keeps moderators out', async () => {
    const admin = asAdmin();
    const mod = account('mod');
    const edit = (actor, value) => request(app).put('/api/settings/hosted_ai').set(authHeader(actor)).send({ value });

    expect((await edit(mod, { ...SETTINGS, activeModel: 'second' })).status).toBe(403);
    expect((await edit(admin, { ...SETTINGS, activeModel: 'second' })).status).toBe(200);
    expect((await state(supporter())).body.data.model.id).toBe('second');
    expect((await edit(admin, { ...SETTINGS, models: [MODELS[0]], activeModel: 'second' })).status).toBe(400);
    expect((await edit(admin, { ...SETTINGS, models: [MODELS[1]], activeModel: 'first' })).status).toBe(400);
  });

  it('validates the warning thresholds, the turn sample and the turn cost', async () => {
    const admin = asAdmin();
    const edit = (value) => request(app).put('/api/settings/hosted_ai').set(authHeader(admin)).send({ value });

    expect((await edit({ ...SETTINGS, warnThresholds: [90, 75] })).status).toBe(400);
    expect((await edit({ ...SETTINGS, warnThresholds: [100] })).status).toBe(400);
    expect((await edit({ ...SETTINGS, turnSample: { recent: 2, min: 3 } })).status).toBe(400);
    expect((await edit({ ...SETTINGS, tiers: { supporter: { window: 1, budget: 1, turnCost: 0 } } })).status).toBe(400);
    expect((await edit({ ...SETTINGS, warnThresholds: null, turnSample: null })).status).toBe(200);
  });

  it('refuses a retention below 7 days, and accepts 7 or none', async () => {
    const admin = asAdmin();
    const edit = (retentionDays) => request(app).put('/api/settings/hosted_ai').set(authHeader(admin)).send({ value: { ...SETTINGS, retentionDays } });

    expect((await edit(6)).status).toBe(400);
    expect((await edit(1)).status).toBe(400);
    expect((await edit(7)).status).toBe(200);
    expect((await edit(null)).status).toBe(200);
  });

  it('reads a subject week spend for an admin only', async () => {
    settledTurns('p-spent', [[300, 200], [500]]);
    settledTurns('p-other', [[900]]);
    const path = `${BASE}/admin/spend/p-spent`;

    const res = await request(app).get(path).set(authHeader(asAdmin()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subject: 'p-spent', calls: 3, turns: 2, costMicros: 1000 });
    expect((await request(app).get(path).set(authHeader(account('mod')))).status).toBe(403);
    expect((await request(app).get(path).set(authHeader(account()))).status).toBe(403);
  });

  it('reports recorded spend per day, with the provider figure once it is stored', async () => {
    settledTurns('p-day', [[1000]]);
    const today = new Date().toISOString().slice(0, 10);
    const readAt = new Date().toISOString();

    const bare = await request(app).get(`${BASE}/admin/spend-report`).set(authHeader(asAdmin()));
    expect(bare.body.data.days).toEqual([{ day: today, calls: 1, costMicros: 1000, providerMicros: null }]);

    HostedProviderSpend.record({ day: today, providerMicros: 1200, recordedMicros: 1000, readAt });
    HostedProviderSpend.record({ day: '2000-01-01', providerMicros: 5, recordedMicros: 5, readAt });
    const full = await request(app).get(`${BASE}/admin/spend-report?days=7`).set(authHeader(asAdmin()));

    expect(full.body.data.days).toEqual([{ day: today, calls: 1, costMicros: 1000, providerMicros: 1200 }]);
    expect((await request(app).get(`${BASE}/admin/spend-report`).set(authHeader(account('mod')))).status).toBe(403);
    expect((await request(app).get(`${BASE}/admin/spend-report?days=0`).set(authHeader(asAdmin()))).status).toBe(400);
  });
});

describe('switching the model', () => {
  it('serves the next admitted turn on the new model and finishes an admitted turn on its old one', async () => {
    const user = supporter();
    const first = await send(user);
    expect(received[0].body.model).toBe('vendor/model-a');

    Setting.set(HOSTED_AI, { ...SETTINGS, activeModel: 'second' });

    const sameTurn = await send(user, chat(), first.headers[TURN]);
    const newTurn = await send(user);

    expect(received.map((entry) => entry.body.model)).toEqual(['vendor/model-a', 'vendor/model-a', 'vendor/model-b']);
    expect(sameTurn.headers[TURN]).toBe(first.headers[TURN]);
    expect(newTurn.headers[TURN]).not.toBe(first.headers[TURN]);
    expect(db.prepare('SELECT model FROM hosted_usage ORDER BY id').all().map((row) => row.model)).toEqual(['first', 'first', 'second']);
  });

  it('prices an admitted turn at its old model after the switch', async () => {
    const user = supporter();
    const first = await send(user);
    Setting.set(HOSTED_AI, { ...SETTINGS, activeModel: 'second' });

    await send(user, chat(), first.headers[TURN]);
    await send(user);

    // 5 prompt + 2 output at the first model's prices is 11; at the second's it is 22.
    expect(db.prepare('SELECT cost_micros FROM hosted_usage ORDER BY id').all().map((row) => row.cost_micros)).toEqual([11, 11, 22]);
  });

  it('falls back to the active model when the turn model was removed from the list', async () => {
    const user = supporter();
    const first = await send(user);
    Setting.set(HOSTED_AI, { ...SETTINGS, models: [MODELS[1]], activeModel: 'second' });

    const res = await send(user, chat(), first.headers[TURN]);

    expect(res.status).toBe(200);
    expect(received[1].body.model).toBe('vendor/model-b');
  });
});

describe('an unconfirmed pledge', () => {
  const DAY = 24 * 3_600_000;
  const MINUTE = 60_000;
  const CUTOFF = 7 * DAY;
  const confirmedAgo = (ms) => new Date(Date.now() - ms).toISOString();
  const pledged = (checkedAt, tier = 'supporter', patreonUserId = `p-${rnd()}`) => {
    const user = account();
    PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart: null, checkedAt });
    return { user, patreonUserId };
  };

  it('serves just inside 7 days and refuses just past it with pledge_unconfirmed', async () => {
    const inside = pledged(confirmedAgo(CUTOFF - MINUTE)).user;
    const past = pledged(confirmedAgo(CUTOFF + MINUTE)).user;

    expect((await send(inside)).status).toBe(200);
    const refused = await send(past);

    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ success: false, code: 'pledge_unconfirmed', error: REFUSALS.pledge_unconfirmed.error });
    expect(received).toHaveLength(1);
  });

  it('entitles at exactly 7 days and not one millisecond later', () => {
    const checkedAt = '2026-01-01T00:00:00.000Z';
    const { user } = pledged(checkedAt);
    const exact = new Date(Date.parse(checkedAt) + CUTOFF);

    expect(entitlement(user.id, exact)).toMatchObject({ source: 'pledge' });
    expect(entitlement(user.id, new Date(exact.getTime() + 1))).toBeNull();
  });

  it('counts a held tier with a null or unreadable checked_at as unconfirmed', async () => {
    for (const checkedAt of [null, 'not a date']) {
      const { user } = pledged(checkedAt);

      expect((await send(user)).body.code).toBe('pledge_unconfirmed');
    }
    expect(received).toHaveLength(0);
  });

  it('keeps answering not_entitled for a link that holds no tier', async () => {
    const { user } = pledged(null, null);

    expect((await send(user)).body.code).toBe('not_entitled');
  });

  it('reports the unconfirmed state with the held tier and nothing else', async () => {
    const { user } = pledged(null, 'supporter_plus');

    expect((await state(user)).body.data).toMatchObject({
      tier: 'supporter_plus', state: 'unconfirmed', window: null, model: null, percentUsed: null, turnsLeft: null
    });
  });

  it('puts the age gate ahead of the unconfirmed state', async () => {
    const minor = createUser({ username: `minor-${rnd()}` });
    PatreonLink.link({ userId: minor.id, patreonUserId: `p-${rnd()}`, tier: 'supporter', pledgeStart: null, checkedAt: null });

    expect((await state(minor)).body.data.state).toBe('age-gate');
  });

  it('still serves on a live grant, on the grant spend subject, and reports the normal state', async () => {
    const { user } = pledged(null, 'supporter');
    const grant = HostedGrant.create({ userId: user.id, tier: 'supporter_plus', endsAt: futureIso(), createdBy: null });

    const res = await send(user);

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT subject FROM hosted_usage').all()).toEqual([{ subject: `grant:${grant.id}` }]);
    expect((await state(user)).body.data).toMatchObject({ tier: 'supporter_plus', state: 'ready' });
  });

  it('leaves flair and the Supporters wall showing the tier', () => {
    const { user } = pledged(null, 'supporter_top');

    expect(PatreonLink.flairOf(user.id)).toMatchObject({ tier: 'supporter_top' });
    expect(PatreonLink.wall().map((entry) => entry.id)).toContain(user.id);
  });

  it('resumes on the next call after a successful read refreshes checked_at', async () => {
    const { user, patreonUserId } = pledged(confirmedAgo(8 * DAY));
    expect((await send(user)).body.code).toBe('pledge_unconfirmed');

    PatreonLink.setTier({ patreonUserId, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });

    expect((await send(user)).status).toBe(200);
    expect((await state(user)).body.data.state).toBe('ready');
  });
});
