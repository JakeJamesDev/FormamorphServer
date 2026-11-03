import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const HostedPause = require('../src/models/HostedPause');
const { activeConfig, proxy } = require('../src/controllers/hostedAiController');
const { HOSTED_AI, REFUSALS } = require('../src/config/hostedAi');
const { entitlement } = require('../src/utils/hostedState');
const { setPatreonClient, resetPatreonClient } = require('../src/utils/patreon');

/** The Formamorph AI entitlement suite: every probe drives the real route or the real helper. */

const ROUTE = '/api/hosted-ai/chat/completions';
const TURN = 'X-Formamorph-Turn';

let script;
let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(raw) });
    script(req, res);
  });
});

const REPLY = { id: 'c1', choices: [{ message: { role: 'assistant', content: 'Hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const answerJson = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(REPLY));

const settings = (tiers) => ({
  models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 2 } }],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers,
  tokenRatio: 4,
  tokenMargin: 0,
  turnLimitSeconds: 600,
  turnCallCap: 50,
  retentionDays: 30,
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null
});

const ROOMY = Object.fromEntries(
  ['supporter', 'supporter_plus', 'supporter_top'].map((tier) => [tier, { window: 100_000, budget: 1000 }])
);

const rnd = () => Math.random().toString(36).slice(2, 8);

/** An 18+ account on a live pledge: the shape every admitted call has. */
const supporter = (tier = 'supporter') => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 200, ...overrides });
const send = (user, body, headers = {}) => request(app).post(ROUTE).set(authHeader(user)).set(headers).send(body);

beforeAll(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.HOSTED_AI_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
  process.env.HOSTED_AI_API_KEY = 'probe-upstream-key';
  process.env.HOSTED_AI_USER_SECRET = 'probe-user-secret';
});

afterAll(() => {
  upstream.closeAllConnections();
  return new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  migrate(db);
  Setting.set(HOSTED_AI, settings(ROOMY));
  script = answerJson;
  received = [];
});

afterEach(() => {
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM hosted_usage').run();
  db.prepare('DELETE FROM hosted_pause').run();
  db.prepare('DELETE FROM hosted_grants').run();
  resetPatreonClient();
});

describe('the turn header as an admission input', () => {
  it('does not let an invented turn id skip the daily pause', async () => {
    const user = supporter();
    HostedPause.start(new Date().toISOString().slice(0, 10), new Date().toISOString());

    // No header: the pause refuses the call.
    expect((await send(user, chat())).body.code).toBe('service_paused');

    // An invented turn id gets the same answer, so the refusal tells nothing about which ids exist.
    const forged = await send(user, chat(), { [TURN]: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect(forged.body.code).toBe('service_paused');
    expect(received).toHaveLength(0);
  });

  it('stops a continued turn at the call cap', async () => {
    Setting.set(HOSTED_AI, { ...settings(ROOMY), turnCallCap: 3 });
    const user = supporter();
    const turnId = (await send(user, chat())).headers['x-formamorph-turn'];

    const codes = [];
    for (let i = 0; i < 4; i++) {
      const res = await send(user, chat(), { [TURN]: turnId });
      codes.push(res.status === 200 ? 'ok' : res.body.code);
    }
    expect(codes).toEqual(['ok', 'ok', 'turn_expired', 'turn_expired']);
  });

  it('cannot borrow another subject\'s turn id', async () => {
    const mine = supporter();
    const other = supporter();
    const theirs = (await send(other, chat())).headers['x-formamorph-turn'];

    const stolen = await send(mine, chat(), { [TURN]: theirs });
    expect(stolen.body.code).toBe('turn_expired');
  });
});

describe('tier strings that are not tiers', () => {
  // A tier of `__proto__` would resolve to Object.prototype and make the budget comparisons NaN.
  // The database CHECKs and the grant route stop the value existing; `activeConfig` is the structural guard.
  it('gets no config and a paused service when a tier outside the known tiers reaches the read', async () => {
    const user = supporter();
    expect(activeConfig('supporter')).not.toBeNull();

    for (const tier of ['__proto__', 'constructor', 'toString', 'platinum', null, undefined]) {
      expect(activeConfig(tier)).toBeNull();
    }

    // `entitlement` already drops an unknown tier, so hand the proxy the bad tier it would never be given.
    let status;
    let body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    const req = {
      user, hosted: { subject: 'p-bad', tier: '__proto__' }, body: chat(), get: () => undefined, on() {}, once() {}
    };
    await proxy(req, res);

    expect(body.code).toBe('service_paused');
    expect(status).toBe(REFUSALS.service_paused.status);
    expect(received).toHaveLength(0);
  });

  it('cannot be stored as a grant tier', () => {
    const user = createUser({ username: `proto-${rnd()}` });
    for (const tier of ['__proto__', 'constructor', 'platinum']) {
      expect(() => db
        .prepare('INSERT INTO hosted_grants (user_id, tier, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, tier, new Date(Date.now() + 86_400_000).toISOString(), user.id, new Date().toISOString()))
        .toThrow(/CHECK constraint failed/);
    }
  });

  it('cannot be stored as a pledge tier', () => {
    const user = createUser({ username: `badtier-${rnd()}` });
    PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: null, checkedAt: null });
    for (const tier of ['__proto__', 'constructor', 'platinum']) {
      expect(() => db.prepare('UPDATE patreon_links SET tier = ? WHERE user_id = ?').run(tier, user.id))
        .toThrow(/CHECK constraint failed/);
    }
  });

  it('is refused by the grant route', async () => {
    const staff = createUser({ username: `mod-${rnd()}`, accountType: 'mod' });
    const target = createUser({ username: `t-${rnd()}` });
    for (const tier of ['__proto__', 'constructor', 'platinum']) {
      const res = await request(app).post('/api/hosted-ai/admin/grants').set(authHeader(staff))
        .send({ userId: target.id, tier, endsAt: new Date(Date.now() + 86_400_000).toISOString() });
      expect(res.status).toBe(400);
    }
    expect(entitlement(target.id)).toBeNull();
  });

  it('entitles nothing when a pledge row somehow holds no tier', async () => {
    const user = createUser({ username: `null-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, user.id);
    PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier: null, pledgeStart: null, checkedAt: null });

    expect(entitlement(user.id)).toBeNull();
    expect((await send(user, chat())).body.code).toBe('not_entitled');
  });
});

describe('what a request can say about itself', () => {
  it('ignores a tier, subject or entitlement named in the body or the headers', async () => {
    const user = createUser({ username: `plain-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, user.id);

    const refused = await send(user, chat({
      tier: 'supporter_top',
      subject: 'p-anything',
      entitlement: { tier: 'supporter_top' },
      hosted: { tier: 'supporter_top' },
      user: 'someone-else'
    }), {
      'X-Formamorph-Client': 'desktop/99.99.99',
      'X-Hosted-Tier': 'supporter_top',
      'X-Formamorph-Prompt-Type': 'narration'
    });

    expect(refused.body.code).toBe('not_entitled');
    expect(received).toHaveLength(0);
  });

  it('never returns the upstream key, and sends its own user id', async () => {
    const user = supporter();
    const served = await send(user, chat({ user: 'attacker-chosen' }));

    expect(served.status).toBe(200);
    expect(JSON.stringify(served.body) + JSON.stringify(served.headers)).not.toContain('probe-upstream-key');
    expect(received[0].body.user).not.toBe('attacker-chosen');
    expect(received[0].body.user).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a suspended supporter', async () => {
    const user = supporter();
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);

    expect((await send(user, chat())).status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('keeps protect in front of the route under a trailing slash and mixed case', async () => {
    for (const path of [ROUTE, `${ROUTE}/`, '/api/hosted-ai/CHAT/COMPLETIONS']) {
      const res = await request(app).post(path).send(chat());
      expect(res.status).toBe(401);
      expect(res.body.code).toBeUndefined();
    }
    expect(received).toHaveLength(0);
  });
});

describe('the pending Patreon link', () => {
  it('refuses a token confirmed by an account it does not name, and spends it', async () => {
    const victim = supporter();
    const attacker = createUser({ username: `atk-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, attacker.id);

    setPatreonClient({
      identify: async () => 'p-paying-member',
      members: async () => [{ patreonUserId: 'p-paying-member', tierIds: ['tier-top'], pledgeStart: null }]
    });

    // The victim starts a link and approves on Patreon; the callback hands their browser the token.
    const started = await request(app).post('/api/users/me/patreon/link').set(authHeader(victim));
    const state = new URL(started.body.data.url).searchParams.get('state');
    const back = await request(app).get('/api/patreon/callback').query({ code: 'c', state });
    const token = new URL(back.headers.location).searchParams.get('token');

    // The attacker, holding the token, cannot land the paying Patreon id on their own account.
    const stolen = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(attacker)).send({ token });
    expect(stolen.status).toBe(400);
    expect(entitlement(attacker.id)).toBeNull();

    // And the token is spent, so the victim cannot finish either: one-shot, not account-scoped.
    const retry = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(victim)).send({ token });
    expect(retry.status).toBe(400);
  });

  it('refuses a guessed or absent token', async () => {
    const user = supporter();
    for (const token of [undefined, null, '', 1, {}, 'x'.repeat(43), { toString: () => 'x' }]) {
      const res = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send({ token });
      expect(res.status).toBe(400);
    }
  });
});

describe('a link whose tier read failed', () => {
  it('entitles nothing when the member list is unreadable at confirm time', async () => {
    const user = createUser({ username: `fail-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, user.id);

    setPatreonClient({
      identify: async () => 'p-unreadable',
      members: async () => { throw new Error('Patreon refused /members (401)'); }
    });

    const started = await request(app).post('/api/users/me/patreon/link').set(authHeader(user));
    const state = new URL(started.body.data.url).searchParams.get('state');
    const back = await request(app).get('/api/patreon/callback').query({ code: 'c', state });
    const token = new URL(back.headers.location).searchParams.get('token');
    const confirmed = await request(app).post('/api/users/me/patreon/confirm').set(authHeader(user)).send({ token });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({ linked: true, tier: null });
    expect(entitlement(user.id)).toBeNull();
    expect((await send(user, chat())).body.code).toBe('not_entitled');
  });
});
