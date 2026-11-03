import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const HostedProviderSpend = require('../src/models/HostedProviderSpend');
const { setMailTransport, resetMailTransport, captureTransport } = require('../src/utils/mail');
const { checkProviderBalance, recordProviderSpend } = require('../src/utils/hostedProvider');
const { HOSTED_AI, HOSTED_BALANCE_ALERTED } = require('../src/config/hostedAi');

/**
 * Formamorph AI limits, the daily ceiling and provider monitoring, over HTTP against one fake server that
 * plays the upstream, the balance endpoint and the usage endpoint. Nothing here reaches the network.
 *
 * Prices are dollars per million tokens, so one prompt token costs 1 micro-dollar and one output token 3.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const PAUSE = '/api/hosted-ai/pause';
const TURN = 'x-formamorph-turn';
const STAFF_ADDRESS = 'staff-alerts@example.test';

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const delta = (content) => event({ id: 'c1', choices: [{ delta: { content } }] });
const DONE = 'data: [DONE]\n\n';

// `script` answers chat calls; `balance` and `usage` answer the provider reads. Each read is kept in `reads`.
let script;
let received;
let held;
let balance;
let usage;
let reads;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  if (url.pathname === '/balance' || url.pathname === '/usage') {
    reads.push({ path: url.pathname, method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams) });
    const [status, body] = url.pathname === '/balance' ? balance : usage;
    return res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  return req.on('end', () => {
    const entry = { body: JSON.parse(raw), closed: false };
    res.on('close', () => { entry.closed = !res.writableFinished; });
    received.push(entry);
    script(req, res, entry);
  });
});

const answer = (...events) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
  res.end();
};
const plain = answer(delta('Hello'), DONE);
const hang = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(delta('Hel'));
  held.push(res);
};
const failing = (_req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{}');

const SETTINGS = {
  models: [{ id: 'main', model: 'vendor/model-a', prices: { prompt: 1, completion: 3 } }],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: {
    supporter: { window: 2000, budget: 1000 },
    supporter_plus: { window: 2000, budget: 1000 },
    supporter_top: { window: 2000, budget: 1000 }
  },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 50,
  retentionDays: 30,
  parallelLimit: 2,
  perMinuteLimit: 100,
  dailyCeiling: 1000,
  balanceThreshold: 5
};

const configure = (overrides) => Setting.set(HOSTED_AI, { ...SETTINGS, ...overrides });

const rnd = () => Math.random().toString(36).slice(2, 8);

const supporter = () => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${rnd()}`, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};
const staffer = (accountType) => createUser({ username: `${accountType}-${rnd()}`, accountType });

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100, stream: true, ...overrides });

const send = (user, body = chat(), turn = undefined) => {
  const req = request(app).post(ROUTE).set(authHeader(user));
  if (turn) req.set(TURN, turn);
  return req.send(body);
};
/** Start a call without waiting for it; supertest sends only once something awaits it. */
const fire = (...args) => {
  const req = send(...args);
  req.then(() => {}, () => {});
  return req;
};

const until = async (condition) => {
  for (let i = 0; i < 300; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('Timed out waiting');
};

const lastRow = () => db.prepare('SELECT * FROM hosted_usage ORDER BY id DESC LIMIT 1').get();

/** A usage row of `micros`, as another subject's call would leave. */
const spend = (micros, { status = 'ok', at = new Date().toISOString() } = {}) => db.prepare(`
  INSERT INTO hosted_usage (subject, user_id, turn_id, tier, estimated_prompt_tokens, cost_micros, started_at, status)
  VALUES ('other', NULL, ?, 'supporter', 1, ?, ?, ?)
`).run(`t-${rnd()}`, micros, at, status);

const inbox = (user) => db.prepare('SELECT subject, severity FROM messages WHERE recipient_id = ?').all(user.id);

let mail;

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.HOSTED_AI_UPSTREAM_URL = `${origin}/v1/chat/completions`;
  process.env.HOSTED_AI_BALANCE_URL = `${origin}/balance`;
  process.env.HOSTED_AI_USAGE_URL = `${origin}/usage`;
  process.env.HOSTED_AI_API_KEY = 'test-upstream-key';
  process.env.HOSTED_AI_USER_SECRET = 'test-user-secret';
  process.env.STAFF_ALERT_EMAIL = STAFF_ADDRESS;
});

afterAll(() => {
  delete process.env.STAFF_ALERT_EMAIL;
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  migrate(db);
  configure({});
  Setting.set(HOSTED_BALANCE_ALERTED, false);
  script = plain;
  received = [];
  held = [];
  reads = [];
  balance = [200, { usd_balance: '20.00' }];
  usage = [200, { byDay: [] }];
  mail = captureTransport();
  setMailTransport(mail);
});

afterEach(() => {
  vi.useRealTimers();
  resetMailTransport();
  for (const res of held) res.end();
  for (const table of ['patreon_links', 'hosted_usage', 'hosted_pause', 'hosted_provider_spend']) db.prepare(`DELETE FROM ${table}`).run();
});

describe('the parallel limit', () => {
  it('refuses a call past the limit with rate_limited, per account and not per address', async () => {
    script = hang;
    const user = supporter();
    fire(user);
    fire(user);
    await until(() => received.length === 2);

    const third = await send(user);
    script = plain;
    const neighbor = await send(supporter());

    expect(third.status).toBe(429);
    expect(third.body.code).toBe('rate_limited');
    expect(received).toHaveLength(3);
    expect(neighbor.status).toBe(200);
  });

  it('releases the slot when a call closes', async () => {
    configure({ parallelLimit: 1 });
    const user = supporter();

    const first = await send(user);
    const second = await send(user);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('releases the slot when the upstream fails', async () => {
    configure({ parallelLimit: 1 });
    const user = supporter();
    script = failing;

    const failed = await send(user);
    script = plain;
    const next = await send(user);

    expect(failed.body.code).toBe('upstream_error');
    expect(next.status).toBe(200);
  });

  it('releases the slot when the client aborts', async () => {
    configure({ parallelLimit: 1 });
    const user = supporter();
    script = hang;
    const call = fire(user);
    await until(() => received.length === 1);

    call.abort();
    await until(() => received[0].closed && lastRow().status !== 'open');
    script = plain;
    const next = await send(user);

    expect(lastRow().status).toBe('ok');
    expect(next.status).toBe(200);
  });

  it('releases the slot when the call is refused', async () => {
    configure({ parallelLimit: 1 });
    const user = supporter();

    const tooLong = await send(user, chat({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }] }));
    const malformed = await send(user, { messages: [{ role: 'user', content: 'Hi' }] });
    const next = await send(user);

    expect(tooLong.body.code).toBe('window_exceeded');
    expect(malformed.body.code).toBe('invalid_request');
    expect(next.status).toBe(200);
  });
});

describe('the per-minute limit', () => {
  it('refuses past the limit until a minute has passed, per account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    configure({ perMinuteLimit: 3 });
    const user = supporter();
    for (let i = 0; i < 3; i += 1) expect((await send(user)).status).toBe(200);

    const fourth = await send(user);
    const neighbor = await send(supporter());
    vi.setSystemTime(new Date('2026-10-30T12:00:59.900Z'));
    const early = await send(user);
    vi.setSystemTime(new Date('2026-10-30T12:01:00.100Z'));
    const later = await send(user);

    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('rate_limited');
    expect(neighbor.status).toBe(200);
    expect(early.status).toBe(429);
    expect(later.status).toBe(200);
  });

  it('releases the parallel slot when the minute refuses the call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    configure({ parallelLimit: 1, perMinuteLimit: 2 });
    const user = supporter();
    await send(user);
    await send(user);

    const refused = await send(user);
    vi.setSystemTime(new Date('2026-10-30T12:01:00Z'));
    const later = await send(user);

    expect(refused.body.code).toBe('rate_limited');
    expect(later.status).toBe(200);
  });

  it('counts a call refused later, at the window', async () => {
    configure({ perMinuteLimit: 2 });
    const user = supporter();

    await send(user, chat({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }] }));
    await send(user);
    const third = await send(user);

    expect(third.body.code).toBe('rate_limited');
  });

  it('refuses every call while unset, as an unconfigured proxy', async () => {
    configure({ perMinuteLimit: null });

    const res = await send(supporter());

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_paused');
  });
});

describe('the daily ceiling', () => {
  // A 'Hello' call reserves 9 prompt tokens plus 100 output tokens at 3: 309 micro-dollars.

  it('pauses once the day, open rows included, reaches the ceiling; a started turn gets one more call', async () => {
    configure({ dailyCeiling: 0.001 });
    const user = supporter();
    const started = await send(user);
    spend(1000 - lastRow().cost_micros, { status: 'open' });

    const firstCall = await send(user);
    const turnCall = await send(user, chat(), started.headers[TURN]);
    const nextTurnCall = await send(user, chat(), started.headers[TURN]);

    expect(firstCall.status).toBe(503);
    expect(firstCall.body.code).toBe('service_paused');
    expect(turnCall.status).toBe(200);
    expect(nextTurnCall.status).toBe(503);
    expect(nextTurnCall.body.code).toBe('service_paused');
  });

  it('answers a pause before the rate limits, so a paused call never spends a minute slot', async () => {
    configure({ dailyCeiling: 0.001, perMinuteLimit: 1 });
    const user = supporter();
    spend(1000);

    const codes = [(await send(user)).body.code, (await send(user)).body.code];

    expect(codes).toEqual(['service_paused', 'service_paused']);
  });

  it("answers a refused continuation before the rate limits, so it cannot use up another turn's call", async () => {
    configure({ dailyCeiling: 0.001, perMinuteLimit: 4 });
    const user = supporter();
    const spentTurn = (await send(user)).headers[TURN];
    const otherTurn = (await send(user)).headers[TURN];
    spend(1000);
    // Past the pause's start, whatever the clock's resolution.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect((await send(user, chat(), spentTurn)).status).toBe(200);

    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await send(user, chat(), spentTurn)).body.code);
    const other = await send(user, chat(), otherTurn);

    expect(codes).toEqual(['service_paused', 'service_paused', 'service_paused']);
    expect(other.status).toBe(200);
  });

  it('gives a turn one more call when its own settled cost started the pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    configure({ dailyCeiling: 0.001 });
    const costly = answer(delta('Hi'), event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, cost: 0.002 } }), DONE);
    // The call settles a second after it started, so the pause begins after that call.
    script = (req, res) => {
      vi.setSystemTime(new Date('2026-10-30T12:00:01Z'));
      costly(req, res);
    };
    const user = supporter();
    const started = await send(user);
    script = plain;

    const grace = await send(user, chat(), started.headers[TURN]);
    const next = await send(user, chat(), started.headers[TURN]);

    expect(grace.status).toBe(200);
    expect(next.body.code).toBe('service_paused');
  });

  it('admits first calls while the day is under the ceiling', async () => {
    configure({ dailyCeiling: 0.001 });
    spend(999 - 309);

    const res = await send(supporter());

    expect(res.status).toBe(200);
  });

  it('pauses on the first-call reservation that would reach the ceiling, and refuses it', async () => {
    configure({ dailyCeiling: 0.0003 });
    const user = supporter();

    const crossing = await send(user);
    const next = await send(user);

    expect(crossing.body.code).toBe('service_paused');
    expect(next.body.code).toBe('service_paused');
    expect(received).toHaveLength(0);
    expect(lastRow()).toBeUndefined();
  });

  it('pauses when a settled cost reaches the ceiling, with no new turn', async () => {
    configure({ dailyCeiling: 0.001 });
    script = answer(delta('Hi'), event({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, cost: 0.002 } }), DONE);
    const admin = staffer('admin');

    await send(supporter());
    const state = await request(app).get(PAUSE).set(authHeader(admin));

    expect(state.body.data.paused).toBe(true);
  });

  it('alerts the admins once: an in-app message and a mail to the staff address', async () => {
    configure({ dailyCeiling: 0.001 });
    const admin = staffer('admin');
    const mod = staffer('mod');
    spend(1000);

    for (let i = 0; i < 3; i += 1) expect((await send(supporter())).body.code).toBe('service_paused');
    await until(() => mail.messages.length > 0);

    expect(inbox(admin)).toEqual([{ subject: 'Formamorph AI is paused', severity: 'urgent' }]);
    expect(inbox(mod)).toEqual([]);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe(STAFF_ADDRESS);
  });

  it('lets an admin lift the pause until 00:00 UTC, when the check restarts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T23:59:00Z'));
    configure({ dailyCeiling: 0.001 });
    const admin = staffer('admin');
    const user = supporter();
    spend(1000);
    expect((await send(user)).body.code).toBe('service_paused');

    const lift = await request(app).post(`${PAUSE}/lift`).set(authHeader(admin));
    const lifted = await send(user);
    vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
    const newDay = await request(app).get(PAUSE).set(authHeader(admin));
    const fresh = await send(user);
    spend(1000);
    const again = await send(user);

    expect(lift.status).toBe(200);
    expect(lift.body.data).toMatchObject({ paused: false, until: '2026-10-31T00:00:00.000Z' });
    expect(lifted.status).toBe(200);
    expect(newDay.body.data.paused).toBe(false);
    expect(fresh.status).toBe(200);
    expect(again.body.code).toBe('service_paused');
    expect(inbox(admin)).toHaveLength(2);
  });

  it('ends an unlifted pause at 00:00 UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T23:59:59Z'));
    configure({ dailyCeiling: 0.001 });
    const user = supporter();
    spend(1000);
    expect((await send(user)).body.code).toBe('service_paused');

    vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
    const res = await send(user);

    expect(res.status).toBe(200);
  });

  it('shows staff the pause with no dollar figures; moderators cannot lift it', async () => {
    configure({ dailyCeiling: 0.001 });
    const mod = staffer('mod');
    spend(1000);
    await send(supporter());

    const read = await request(app).get(PAUSE).set(authHeader(mod));
    const lift = await request(app).post(`${PAUSE}/lift`).set(authHeader(mod));
    const player = await request(app).get(PAUSE).set(authHeader(supporter()));

    expect(read.status).toBe(200);
    expect(Object.keys(read.body.data).sort()).toEqual(['liftedAt', 'paused', 'pausedAt', 'until']);
    expect(read.body.data.paused).toBe(true);
    expect(lift.status).toBe(403);
    expect((await send(supporter())).body.code).toBe('service_paused');
    expect(player.status).toBe(403);
  });

  it('answers 409 to a lift when nothing is paused', async () => {
    const res = await request(app).post(`${PAUSE}/lift`).set(authHeader(staffer('admin')));

    expect(res.status).toBe(409);
  });
});

describe('the provider balance', () => {
  it('reads the balance with the server key and alerts once below the threshold', async () => {
    const admin = staffer('admin');
    balance = [200, { usd_balance: '4.50' }];

    const low = await checkProviderBalance();
    await checkProviderBalance();

    expect(low).toBe(4.5);
    expect(reads[0]).toMatchObject({ path: '/balance', method: 'POST' });
    expect(reads[0].headers['x-api-key']).toBe('test-upstream-key');
    expect(inbox(admin)).toEqual([{ subject: 'Formamorph AI provider balance is low', severity: 'urgent' }]);
    expect(mail.messages).toHaveLength(1);
  });

  it('alerts again after the balance was back above the threshold', async () => {
    const admin = staffer('admin');

    balance = [200, { usd_balance: '4.00' }];
    await checkProviderBalance();
    balance = [200, { usd_balance: '25.00' }];
    await checkProviderBalance();
    balance = [200, { usd_balance: '3.00' }];
    await checkProviderBalance();

    expect(inbox(admin)).toHaveLength(2);
  });

  it('skips the read with no threshold, and survives a failed read', async () => {
    configure({ balanceThreshold: null });
    const skipped = await checkProviderBalance();
    configure({});
    balance = [500, {}];
    const failed = await checkProviderBalance();

    expect(skipped).toBeNull();
    expect(failed).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it('raises no alert from a reply without a balance', async () => {
    const admin = staffer('admin');
    balance = [200, { balance: '1.00' }];

    const result = await checkProviderBalance();

    expect(result).toBeNull();
    expect(inbox(admin)).toEqual([]);
  });
});

describe('the provider daily spend', () => {
  it('stores the last two complete days of provider spend beside the recorded day sums', async () => {
    spend(9, { at: '2026-10-27T23:59:59.999Z' });
    spend(5, { at: '2026-10-28T00:00:00.000Z' });
    spend(1234, { at: '2026-10-29T00:00:00.000Z' });
    spend(1, { at: '2026-10-29T23:59:59.999Z' });
    spend(999, { at: '2026-10-30T00:10:00.000Z' });
    usage = [200, { byDay: [{ date: '2026-10-29', netCostUsd: 0.001 }, { date: '2026-10-29', netCostUsd: 0.0005 }] }];

    const stored = await recordProviderSpend(new Date('2026-10-30T00:30:00Z'));

    expect(stored).toBe(2);
    expect(reads[0].headers.authorization).toBe('Bearer test-upstream-key');
    expect(reads[0].query).toEqual({ from: '2026-10-28', to: '2026-10-29', group_by: 'day' });
    expect(HostedProviderSpend.between('2026-10-01', '2026-10-31')).toEqual([
      { day: '2026-10-28', provider_micros: 0, recorded_micros: 5, read_at: '2026-10-30T00:30:00.000Z' },
      { day: '2026-10-29', provider_micros: 1500, recorded_micros: 1235, read_at: '2026-10-30T00:30:00.000Z' }
    ]);
  });

  it('reads the last two days again, so a late figure or a late settle corrects them', async () => {
    usage = [200, { byDay: [{ date: '2026-10-29', netCostUsd: 0.001 }] }];
    await recordProviderSpend(new Date('2026-10-30T00:30:00Z'));
    usage = [200, { byDay: [{ date: '2026-10-29', netCostUsd: 0.003 }] }];
    spend(40, { at: '2026-10-29T23:50:00.000Z' });

    await recordProviderSpend(new Date('2026-10-30T01:30:00Z'));

    expect(reads).toHaveLength(2);
    expect(HostedProviderSpend.between('2026-10-29', '2026-10-29')).toEqual([
      { day: '2026-10-29', provider_micros: 3000, recorded_micros: 40, read_at: '2026-10-30T01:30:00.000Z' }
    ]);
  });

  it('catches up every day since the last stored one; a day the reply leaves out spent nothing', async () => {
    HostedProviderSpend.record({ day: '2026-10-26', providerMicros: 7, recordedMicros: 7, readAt: '2026-10-27T00:30:00.000Z' });
    usage = [200, { byDay: [{ date: '2026-10-27', netCostUsd: 0.25 }, { date: '2026-10-29', netCostUsd: 1 }] }];

    const stored = await recordProviderSpend(new Date('2026-10-30T00:30:00Z'));

    expect(stored).toBe(3);
    expect(reads[0].query).toMatchObject({ from: '2026-10-27', to: '2026-10-29' });
    expect(HostedProviderSpend.between('2026-10-27', '2026-10-29').map((row) => [row.day, row.provider_micros])).toEqual([
      ['2026-10-27', 250_000], ['2026-10-28', 0], ['2026-10-29', 1_000_000]
    ]);
  });

  it('stores nothing from a failed or malformed reply', async () => {
    usage = [500, {}];
    const failed = await recordProviderSpend(new Date('2026-10-30T00:30:00Z'));
    usage = [200, { byDay: [{ date: '2026-10-29', netCostUsd: null }] }];
    const malformed = await recordProviderSpend(new Date('2026-10-30T00:30:00Z'));

    expect(failed).toBe(0);
    expect(malformed).toBe(0);
    expect(HostedProviderSpend.lastDay()).toBeNull();
  });
});

describe('the hosted settings record', () => {
  const write = (value) => request(app).put(`/api/settings/${HOSTED_AI}`).set(authHeader(staffer('admin'))).send({ value });

  it('takes the limits, the ceiling and the threshold, and refuses bad ones', async () => {
    const saved = await write(SETTINGS);
    const negative = await write({ ...SETTINGS, dailyCeiling: -1 });
    const fractional = await write({ ...SETTINGS, parallelLimit: 1.5 });
    const zeroCeiling = await write({ ...SETTINGS, dailyCeiling: 0 });

    expect(saved.status).toBe(200);
    expect(negative.status).toBe(400);
    expect(fractional.status).toBe(400);
    expect(zeroCeiling.status).toBe(400);
  });
});
