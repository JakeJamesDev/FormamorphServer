import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const { HOSTED_AI, PROMPT_TYPES, PROMPT_TYPE_HEADER } = require('../src/config/hostedAi');

/**
 * Formamorph AI prompt types: stored on usage rows, kept from the upstream, and reported as shares of cost.
 */

const BASE = '/api/hosted-ai';
const CHAT = `${BASE}/chat/completions`;

let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
});

const SETTINGS = {
  models: [{ id: 'first', model: 'vendor/model-a', prices: { prompt: 1, completion: 3 } }],
  activeModel: 'first',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: { supporter: { window: 2000, budget: 1, turnCost: 0.002 } },
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

const account = (accountType = 'normal') => {
  const user = createUser({ username: `acct-${rnd()}`, accountType });
  Policy.accept(Policy.AGE_GATE, user.id);
  return user;
};

const supporter = (patreonUserId = `p-${rnd()}`) => {
  const user = account();
  PatreonLink.link({ userId: user.id, patreonUserId, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });
  return { user, subject: patreonUserId };
};

const chat = () => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100 });
const send = (user, promptType) => {
  const req = request(app).post(CHAT).set(authHeader(user));
  if (promptType !== undefined) req.set(PROMPT_TYPE_HEADER, promptType);
  return req.send(chat());
};

const storedTypes = () => db.prepare('SELECT prompt_type AS t FROM hosted_usage ORDER BY id').all().map((row) => row.t);

/** Insert one settled row for a subject with the given type and cost. */
const row = (subject, promptType, costMicros, tokens = {}) => db.prepare(`
  INSERT INTO hosted_usage
    (subject, turn_id, tier, prompt_type, estimated_prompt_tokens, prompt_tokens, cached_tokens, output_tokens, cost_micros, started_at, status, cost_source)
  VALUES (?, ?, 'supporter', ?, 1, ?, ?, ?, ?, ?, 'ok', 'computed')
`).run(subject, `turn-${rnd()}`, promptType, tokens.prompt ?? null, tokens.cached ?? null, tokens.output ?? null, costMicros, new Date().toISOString());

const state = (user) => request(app).get(`${BASE}/state`).set(authHeader(user));
const adminSpend = (subject) => request(app).get(`${BASE}/admin/spend/${subject}`).set(authHeader(account('admin')));

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
  received = [];
});

afterEach(() => {
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM hosted_usage').run();
});

describe('the prompt type list', () => {
  it('holds the 21 prompt types', () => {
    expect(new Set(PROMPT_TYPES)).toEqual(new Set([
      'narration', 'thinking', 'director', 'character', 'storyboard', 'choices',
      'statUpdates', 'locationChange', 'entityLocation', 'discoverEntity', 'timePassed', 'openingTime', 'sceneTags',
      'inventory', 'summary', 'milestoneSelect', 'diary',
      'help', 'descriptionSummary', 'descriptionBridge', 'imageTags'
    ]));
    expect(PROMPT_TYPES).toHaveLength(21);
  });
});

describe('the prompt type header', () => {
  it('is stored for a known type, and null for an absent or unknown one, with every call admitted', async () => {
    const { user } = supporter();

    const statuses = [
      (await send(user, 'narration')).status,
      (await send(user, 'statUpdates')).status,
      (await send(user, 'notAType')).status,
      (await send(user)).status
    ];

    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(storedTypes()).toEqual(['narration', 'statUpdates', null, null]);
  });

  it('never reaches the upstream', async () => {
    await send(supporter().user, 'narration');

    expect(received).toHaveLength(1);
    expect(received[0].headers[PROMPT_TYPE_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('is allowed by CORS', async () => {
    const res = await request(app).options(CHAT)
      .set('Origin', 'https://formamorph.ai')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', `authorization,content-type,${PROMPT_TYPE_HEADER.toLowerCase()}`);

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain(PROMPT_TYPE_HEADER.toLowerCase());
  });
});

describe('the breakdown in the hosted state', () => {
  it('weights shares by cost, not tokens', async () => {
    const { user, subject } = supporter();
    // `choices` has fewer tokens than `narration` but the larger share: output tokens cost more.
    row(subject, 'narration', 100, { prompt: 1000, cached: 900, output: 10 });
    row(subject, 'choices', 300, { prompt: 50, cached: 0, output: 90 });

    const { breakdown } = (await state(user)).body.data;

    expect(breakdown).toEqual({ narration: 25, choices: 75 });
  });

  it('rounds to one decimal, folds a null type into other, and omits types with no cost', async () => {
    const { user, subject } = supporter();
    row(subject, 'narration', 1);
    row(subject, null, 1);
    row(subject, 'diary', 1);
    row(subject, 'inventory', 0);

    const { breakdown } = (await state(user)).body.data;

    expect(breakdown).toEqual({ narration: 33.3, other: 33.3, diary: 33.3 });
  });

  it('counts only this week and only this subject', async () => {
    const { user, subject } = supporter();
    row(subject, 'narration', 100);
    row('p-someone-else', 'choices', 900);
    db.prepare("INSERT INTO hosted_usage (subject, turn_id, tier, prompt_type, estimated_prompt_tokens, cost_micros, started_at, status) VALUES (?, 'old', 'supporter', 'diary', 1, 900, '2000-01-03T00:00:00.000Z', 'ok')").run(subject);

    expect((await state(user)).body.data.breakdown).toEqual({ narration: 100 });
  });

  it('is null in a state with no usage figure', async () => {
    const plain = account();

    expect((await state(plain)).body.data).toMatchObject({ state: 'locked', breakdown: null, breakdownThreshold: null });
  });

  it('holds no dollar amount', async () => {
    const { user, subject } = supporter();
    row(subject, 'narration', 100);

    expect(JSON.stringify((await state(user)).body)).not.toMatch(/cost|price|budget|micro|dollar|spend/i);
  });

  it('reads the threshold from the setting, 10 while it is unset', async () => {
    const { user } = supporter();
    const admin = account('admin');
    const edit = (value) => request(app).put('/api/settings/hosted_ai').set(authHeader(admin)).send({ value });

    expect((await state(user)).body.data.breakdownThreshold).toBe(10);
    expect((await edit({ ...SETTINGS, breakdownThreshold: 25 })).status).toBe(200);
    expect((await state(user)).body.data.breakdownThreshold).toBe(25);
    expect((await edit({ ...SETTINGS, breakdownThreshold: null })).status).toBe(200);
    expect((await state(user)).body.data.breakdownThreshold).toBe(10);
  });

  it('validates the threshold as a whole percent from 1 to 100', async () => {
    const admin = account('admin');
    const edit = (breakdownThreshold) => request(app).put('/api/settings/hosted_ai').set(authHeader(admin)).send({ value: { ...SETTINGS, breakdownThreshold } });

    for (const bad of [0, 101, 12.5, '10', -1]) expect((await edit(bad)).status).toBe(400);
    for (const good of [1, 100, null]) expect((await edit(good)).status).toBe(200);
  });
});

describe('the breakdown in the admin spend read', () => {
  it('lists every type with its share, zero included, and no threshold', async () => {
    const { subject } = supporter();
    row(subject, 'narration', 750);
    row(subject, null, 250);

    const { data } = (await adminSpend(subject)).body;

    expect(Object.keys(data.breakdown)).toEqual([...PROMPT_TYPES, 'other']);
    expect(data.breakdown.narration).toBe(75);
    expect(data.breakdown.other).toBe(25);
    expect(data.breakdown.choices).toBe(0);
    expect(data).not.toHaveProperty('breakdownThreshold');
  });

  it('folds a stored type the server no longer knows into other', async () => {
    const { subject } = supporter();
    row(subject, 'narration', 500);
    row(subject, 'retiredType', 500);

    const { data } = (await adminSpend(subject)).body;

    expect(data.breakdown.narration).toBe(50);
    expect(data.breakdown.other).toBe(50);
  });

  it('lists every type at zero for an empty week', async () => {
    const { data } = (await adminSpend('p-nobody')).body;

    expect(Object.values(data.breakdown).every((share) => share === 0)).toBe(true);
    expect(Object.keys(data.breakdown)).toHaveLength(22);
  });
});
