import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import Database from 'better-sqlite3';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const HostedUsage = require('../src/models/HostedUsage');
const { usageOf } = require('../src/utils/hostedState');
const { weekStart } = require('../src/utils/hostedMeter');
const hostedUsageRetry = require('../src/schema/steps/hostedUsageRetry');
const { HOSTED_AI, REFUSALS } = require('../src/config/hostedAi');

/**
 * Formamorph AI stop and retry: an attempt that thinks with thinking off, or fails before any reply text, is
 * stopped and sent once more. Driven over HTTP against a fake upstream.
 *
 * Prices are dollars per million tokens, so here one prompt token costs 1 micro-dollar and one output token 2.
 */

const ROUTE = '/api/hosted-ai/chat/completions';
const TURN = 'x-formamorph-turn';

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const part = (delta) => event({ id: 'c1', choices: [{ delta }] });
const TEXT = part({ content: 'Hello' });
const THINK = part({ reasoning: 'Let me see.' });
const ROLE = part({ role: 'assistant', content: '' });
const TOOL = part({ tool_calls: [{ index: 0, function: { name: 'f', arguments: '{}' } }] });
const USAGE = event({ id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });
const DONE = 'data: [DONE]\n\n';
const ERROR_FRAME = event({ error: { message: 'host-detail-xyz', code: 500 } });
const REFUSED = { success: false, code: 'upstream_error', error: REFUSALS.upstream_error.error };

// The fake upstream: `scripts` answer the attempts in order, and the last one answers any more.
let scripts;
let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const entry = { body: JSON.parse(raw), closed: false };
    res.on('close', () => { entry.closed = !res.writableFinished; });
    received.push(entry);
    scripts[Math.min(received.length, scripts.length) - 1](req, res, entry);
  });
});

/** Streams the events, then ends. */
const stream = (...events) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
  res.end();
};

/** Streams the events one chunk at a time, so each reaches the client before the next is sent. */
const spaced = (...events) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  events.forEach((piece, i) => setTimeout(() => (i === events.length - 1 ? res.end(piece) : res.write(piece)), i * 40));
};

/** Sends the events, then stays silent. */
const stall = (...events) => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
};

/** Sends the events, then drops the connection without an end. */
const drop = (...events) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of events) res.write(piece);
  setTimeout(() => req.socket.destroy(), 30);
};

const whole = (message, extra = {}) => (_req, res) => res
  .writeHead(200, { 'Content-Type': 'application/json' })
  .end(JSON.stringify({ id: 'c2', choices: [{ message: { role: 'assistant', ...message } }], ...extra }));

const silent = () => {};
const replies = stream(ROLE, TEXT, USAGE, DONE);

const NO_THINKING = { effort: 'none' };
const WITH_THINKING = { effort: 'low' };

const settings = (reasoning = NO_THINKING, overrides = {}) => ({
  models: [{ id: 'main', model: 'vendor/model-a', ...(reasoning ? { reasoning } : {}), prices: { prompt: 1, completion: 2 } }],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: { supporter: { window: 100_000, budget: 1000 } },
  tokenRatio: 4,
  tokenMargin: 0,
  turnLimitSeconds: 600,
  turnCallCap: 50,
  retentionDays: 30,
  parallelLimit: 50,
  perMinuteLimit: 1000,
  dailyCeiling: 1000,
  balanceThreshold: null,
  ...overrides
});

const rnd = () => Math.random().toString(36).slice(2, 8);

const supporter = () => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const chat = (overrides = {}) => ({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 100, ...overrides });
const streamed = (overrides = {}) => chat({ stream: true, ...overrides });

const send = (user, body, turn) => {
  const req = request(app).post(ROUTE).set(authHeader(user));
  if (turn) req.set(TURN, turn);
  return req.send(body);
};

/** The usage event is the proxy's own; every other byte is the upstream's. */
const withoutUsage = (text) => text.replace(/event: usage\ndata: .*\n\n/, '');

const rows = () => db.prepare('SELECT status, retry, stopped, cost_micros AS cost, output_tokens AS output FROM hosted_usage ORDER BY id').all();
const flags = () => rows().map(({ status, retry, stopped }) => ({ status, retry, stopped }));

/** Open a raw client request. `seen` holds what the client has received so far. */
const openClient = (user, body) => {
  const seen = { response: null, text: '' };
  const payload = JSON.stringify(body);
  const req = http.request(new URL(ROUTE, request(app).post(ROUTE).url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...authHeader(user) }
  }, (res) => {
    seen.response = res;
    res.on('data', (chunk) => { seen.text += chunk; });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end(payload);
  return { req, seen };
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
  Setting.set(HOSTED_AI, settings());
  scripts = [replies];
  received = [];
});

afterEach(() => {
  upstream.closeAllConnections();
  db.prepare('DELETE FROM patreon_links').run();
});

describe('holding a stream', () => {
  it('sends nothing until the first frame with reply text, then every held frame in order', async () => {
    let release;
    scripts = [(_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(ROLE);
      release = () => { res.write(TEXT); res.write(USAGE); res.end(DONE); };
    }];

    const { seen } = openClient(supporter(), streamed());
    await vi.waitFor(() => expect(release).toBeDefined());
    await wait(100);
    expect(seen.response).toBeNull();

    release();
    await vi.waitFor(() => expect(seen.text).toContain('[DONE]'));
    expect(seen.response.statusCode).toBe(200);
    expect(withoutUsage(seen.text)).toBe(ROLE + TEXT + USAGE + DONE);
    expect(received).toHaveLength(1);
  });

  it('ends the hold on a tool call', async () => {
    scripts = [stream(ROLE, TOOL, DONE)];

    const res = await send(supporter(), streamed());

    expect(withoutUsage(res.text)).toBe(ROLE + TOOL + DONE);
    expect(received).toHaveLength(1);
  });

  it('forwards a reply that arrives as an unterminated last fragment', async () => {
    const fragment = TEXT.trimEnd();
    scripts = [stream(fragment)];

    const res = await send(supporter(), streamed());

    expect(res.text.startsWith(fragment)).toBe(true);
    expect(received).toHaveLength(1);
  });
});

describe('thinking', () => {
  it.each([
    ['effort none', { effort: 'none' }],
    ['enabled false', { enabled: false }]
  ])('stops a stream that starts thinking with thinking off by %s, and the client sees one normal call', async (_name, reasoning) => {
    Setting.set(HOSTED_AI, settings(reasoning));
    scripts = [stall(ROLE, THINK), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(withoutUsage(res.text)).toBe(ROLE + TEXT + USAGE + DONE);
    expect(received).toHaveLength(2);
    expect(received[1].body).toEqual(received[0].body);
    await vi.waitFor(() => expect(received[0].closed).toBe(true));
    expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'ok', retry: 1, stopped: 0 }
    ]);
  });

  it('also stops on `reasoning_content`', async () => {
    scripts = [stall(part({ reasoning_content: 'Hmm.' })), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(received).toHaveLength(2);
  });

  it.each([
    ['thinking on', WITH_THINKING],
    ['no reasoning field', null]
  ])('forwards thinking at once with %s, and it ends the hold', async (_name, reasoning) => {
    Setting.set(HOSTED_AI, settings(reasoning));
    let release;
    scripts = [(_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(THINK);
      release = () => { res.write(TEXT); res.end(DONE); };
    }];

    const { seen } = openClient(supporter(), streamed());
    await vi.waitFor(() => expect(seen.text).toBe(THINK));
    release();
    await vi.waitFor(() => expect(seen.text).toContain('[DONE]'));

    expect(withoutUsage(seen.text)).toBe(THINK + TEXT + DONE);
    expect(received).toHaveLength(1);
    expect(flags()).toEqual([{ status: 'ok', retry: 0, stopped: 0 }]);
  });

  it('never retries after forwarded thinking on a model with thinking on: a failure ends as today', async () => {
    Setting.set(HOSTED_AI, settings(WITH_THINKING));
    scripts = [spaced(THINK, ERROR_FRAME)];

    const res = await send(supporter(), streamed());

    expect(res.text).toBe(`${THINK}event: error\ndata: ${JSON.stringify(REFUSED)}\n\n`);
    expect(received).toHaveLength(1);
  });

  it('does not stop on thinking that follows reply text', async () => {
    scripts = [stream(TEXT, THINK, DONE)];

    const res = await send(supporter(), streamed());

    expect(withoutUsage(res.text)).toBe(TEXT + THINK + DONE);
    expect(received).toHaveLength(1);
  });

  it('treats a frame with thinking and reply text as the reply', async () => {
    const both = part({ reasoning: 'Hmm.', content: 'Hi' });
    scripts = [stream(both, DONE)];

    const res = await send(supporter(), streamed());

    expect(withoutUsage(res.text)).toBe(both + DONE);
    expect(received).toHaveLength(1);
  });
});

describe('a stream that fails before any reply text', () => {
  it.each([
    ['an error frame', () => stream(ROLE, ERROR_FRAME, DONE)],
    ['an error frame split across chunks', () => stream(ERROR_FRAME.slice(0, 20), ERROR_FRAME.slice(20))],
    ['a clean end with no frames', () => stream()],
    ['[DONE] with no reply', () => stream(ROLE, USAGE, DONE)],
    ['a dropped connection', () => drop(ROLE)],
    ['a refused status', () => (_req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"host-detail-xyz"}')]
  ])('retries after %s, on any thinking setting', async (_name, failure) => {
    Setting.set(HOSTED_AI, settings(WITH_THINKING));
    scripts = [failure(), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(withoutUsage(res.text)).toBe(ROLE + TEXT + USAGE + DONE);
    expect(received).toHaveLength(2);
    expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'ok', retry: 1, stopped: 0 }
    ]);
  });

  it('answers a failed retry as upstream_error, after exactly two attempts, and hides the frames', async () => {
    scripts = [stream(ROLE, THINK), stream(ROLE, ERROR_FRAME)];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(res.text).not.toContain('host-detail-xyz');
    expect(received).toHaveLength(2);
    expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'error', retry: 1, stopped: 1 }
    ]);
  });

  it('answers as upstream_error when both attempts think', async () => {
    scripts = [stall(THINK)];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(2);
  });
});

describe('after reply text has reached the client', () => {
  it.each([
    ['an error frame', () => spaced(TEXT, ERROR_FRAME)],
    ['a dropped connection', () => drop(TEXT)]
  ])('does not retry after %s and ends with the SSE error event', async (_name, failure) => {
    scripts = [failure(), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(res.text).toBe(`${TEXT}event: error\ndata: ${JSON.stringify(REFUSED)}\n\n`);
    expect(received).toHaveLength(1);
    expect(flags()).toEqual([{ status: 'error', retry: 0, stopped: 0 }]);
  });

  it('still retries when reply text and an error arrive in one chunk, since no text reached the client', async () => {
    scripts = [(_req, res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(TEXT + ERROR_FRAME), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(withoutUsage(res.text)).toBe(ROLE + TEXT + USAGE + DONE);
    expect(received).toHaveLength(2);
  });

  it('forwards a clean end as today', async () => {
    scripts = [stream(TEXT)];

    const res = await send(supporter(), streamed());

    expect(res.text.startsWith(TEXT)).toBe(true);
    expect(received).toHaveLength(1);
  });
});

describe('a non-streamed call', () => {
  it('retries once when it returns thinking with no reply text', async () => {
    scripts = [whole({ content: null, reasoning: 'Hmm.' }), whole({ content: 'Hi' })];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(received).toHaveLength(2);
    expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'ok', retry: 1, stopped: 0 }
    ]);
  });

  it('answers upstream_error when the retry returns thinking again', async () => {
    scripts = [whole({ content: '', reasoning: 'Hmm.' })];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(2);
  });

  it.each([
    ['thinking on', WITH_THINKING, { content: null, reasoning: 'Hmm.' }],
    ['no reasoning field', null, { content: null, reasoning: 'Hmm.' }],
    ['a reply alongside thinking', NO_THINKING, { content: 'Hi', reasoning: 'Hmm.' }],
    ['a tool call alongside thinking', NO_THINKING, { content: null, reasoning: 'Hmm.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] }]
  ])('does not retry with %s', async (_name, reasoning, message) => {
    Setting.set(HOSTED_AI, settings(reasoning));
    scripts = [whole(message)];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('does not retry an upstream refusal: only thinking retries a non-streamed call', async () => {
    scripts = [(_req, res) => res.writeHead(500).end('{}')];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(502);
    expect(received).toHaveLength(1);
    expect(flags()).toEqual([{ status: 'error', retry: 0, stopped: 0 }]);
  });
});

describe('a non-streamed retry that fails', () => {
  it.each([
    ['a refused status', (_req, res) => res.writeHead(500).end('{}')],
    ['an error body', (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"error":{"message":"host-detail-xyz"}}')],
    ['a dropped connection', (req) => req.socket.destroy()]
  ])('answers upstream_error and marks the attempt stopped after %s', async (_name, failure) => {
    scripts = [whole({ content: null, reasoning: 'Hmm.' }), failure];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(2);
    expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'error', retry: 1, stopped: 1 }
    ]);
  });
});

describe('a non-streamed call that fails outright', () => {
  it('answers upstream_error with no retry when the connection drops', async () => {
    scripts = [(req) => req.socket.destroy(), whole({ content: 'Hi' })];

    const res = await send(supporter(), chat());

    expect(res.status).toBe(502);
    expect(received).toHaveLength(1);
    expect(flags()).toEqual([{ status: 'error', retry: 0, stopped: 0 }]);
  });
});

describe('limits', () => {
  it('holds the same parallel slot through the retry, and frees it after', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { parallelLimit: 1 }));
    let release;
    scripts = [stall(THINK), (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(ROLE);
      release = () => { res.write(TEXT); res.end(DONE); };
    }, replies];
    const user = supporter();

    const { seen } = openClient(user, streamed());
    await vi.waitFor(() => expect(release).toBeDefined());
    const during = await send(user, streamed());
    expect(during.status).toBe(429);
    expect(during.body.code).toBe('rate_limited');

    release();
    await vi.waitFor(() => expect(seen.text).toContain('[DONE]'));
    const after = await send(user, streamed());
    expect(after.status).toBe(200);
  });

  it('takes one per-minute count for a retried call', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { perMinuteLimit: 2 }));
    scripts = [stall(THINK), replies];
    const user = supporter();

    const first = await send(user, streamed());
    const second = await send(user, streamed());
    const third = await send(user, streamed());

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
  });

  it('takes one turn-cap slot for a retried call', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { turnCallCap: 2 }));
    scripts = [stall(THINK), replies];
    const user = supporter();

    const first = await send(user, streamed());
    const turn = first.headers[TURN];
    const second = await send(user, streamed(), turn);
    const third = await send(user, streamed(), turn);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 409]);
    expect(third.body.code).toBe('turn_expired');
  });

  it('keeps the turn-cap slot when both attempts fail', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { turnCallCap: 1 }));
    scripts = [stall(THINK)];
    const user = supporter();

    const failed = await send(user, streamed());
    const next = await send(user, streamed(), failed.headers[TURN]);

    expect(failed.status).toBe(502);
    expect(next.status).toBe(409);
    expect(next.body.code).toBe('turn_expired');
  });

  it('gives each attempt a fresh idle clock', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { idleLimitSeconds: 1 }));
    scripts = [silent, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => { res.write(TEXT); res.end(DONE); }, 700);
    }];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(200);
    expect(withoutUsage(res.text)).toBe(TEXT + DONE);
    expect(received).toHaveLength(2);
    expect(received[0].closed).toBe(true);
  }, 10_000);

  it('applies the idle clock to the retry too', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { idleLimitSeconds: 1 }));
    scripts = [silent];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(2);
    await vi.waitFor(() => expect(received.every((entry) => entry.closed)).toBe(true));
  }, 10_000);

  it('sends no retry past the turn limit and answers upstream_error', async () => {
    Setting.set(HOSTED_AI, settings(NO_THINKING, { idleLimitSeconds: 1, turnLimitSeconds: 1 }));
    scripts = [silent, replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(1);
    expect(flags()).toEqual([{ status: 'error', retry: 0, stopped: 1 }]);
  }, 10_000);

  it('sends no retry on a day its reservation would pause, and answers upstream_error', async () => {
    // Each reservation is 200 output micro-dollars plus the prompt. The first fits; with the stopped cost, the second does not.
    Setting.set(HOSTED_AI, settings(NO_THINKING, { dailyCeiling: 0.00025 }));
    const usage = event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 0 } });
    scripts = [stream(usage, THINK), replies];

    const res = await send(supporter(), streamed());

    expect(res.status).toBe(502);
    expect(res.body).toEqual(REFUSED);
    expect(received).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hosted_pause').get().n).toBe(1);
  });
});

describe('a client disconnect', () => {
  it('aborts the first attempt during the hold and sends no retry', async () => {
    scripts = [stall(ROLE), replies];

    const { req } = openClient(supporter(), streamed());
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await wait(50);
    req.destroy();

    await vi.waitFor(() => expect(received[0].closed).toBe(true));
    await wait(50);
    expect(received).toHaveLength(1);
    await vi.waitFor(() => expect(flags()).toEqual([{ status: 'aborted', retry: 0, stopped: 0 }]));
  });

  it('aborts the retry when the client leaves during it', async () => {
    scripts = [stream(THINK), stall(ROLE)];

    const { req } = openClient(supporter(), streamed());
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await wait(50);
    req.destroy();

    await vi.waitFor(() => expect(received[1].closed).toBe(true));
    await vi.waitFor(() => expect(flags()).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'aborted', retry: 1, stopped: 0 }
    ]));
    expect(received).toHaveLength(2);
  });
});

describe('spend', () => {
  // One prompt token costs 1 micro-dollar, so this stopped attempt costs 20,000: twice the budget below.
  const costly = event({ choices: [], usage: { prompt_tokens: 20_000, completion_tokens: 0 } });
  const budgeted = () => settings(NO_THINKING, { tiers: { supporter: { window: 100_000, budget: 0.01, turnCost: 0.001 } } });
  const subject = (user) => db.prepare('SELECT subject FROM hosted_usage WHERE user_id = ? LIMIT 1').get(user.id).subject;

  it('counts a stopped attempt on the day and off the allowance', async () => {
    Setting.set(HOSTED_AI, budgeted());
    scripts = [stream(costly, THINK), replies];
    const user = supporter();

    const first = await send(user, streamed());
    expect(first.status).toBe(200);

    const [stopped, retried] = rows();
    expect(stopped.cost).toBe(20_000);
    expect(retried.cost).toBe(5 + 2 * 2);

    const now = new Date();
    const since = weekStart(now);
    const who = subject(user);
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    expect(HostedUsage.totalBetween(dayStart, '9999')).toBe(20_009);
    expect(HostedUsage.daySums(dayStart)).toEqual([expect.objectContaining({ costMicros: 20_009 })]);
    expect(HostedUsage.spendSince(who, since)).toBe(9);
    expect(HostedUsage.turnSpendSince(who, first.headers[TURN], since)).toBe(9);
    expect(HostedUsage.summarySince(who, since)).toEqual({ calls: 1, turns: 1, costMicros: 9 });
    expect(HostedUsage.costByType(who, since)).toEqual([{ promptType: null, costMicros: 9 }]);
    expect(usageOf(who, { limits: { budget: 0.01 }, turnSample: null }, now).percentUsed).toBeLessThan(1);

    // The budget would refuse this call had the stopped attempt counted.
    scripts = [replies];
    const next = await send(user, streamed());
    expect(next.status).toBe(200);
  });

  it('leaves a failed retry off the allowance too, and on the day', async () => {
    Setting.set(HOSTED_AI, budgeted());
    scripts = [stream(costly, THINK), stream(costly, ERROR_FRAME)];
    const user = supporter();

    const res = await send(user, streamed());

    expect(res.status).toBe(502);
    const who = subject(user);
    expect(HostedUsage.spendSince(who, weekStart(new Date()))).toBe(0);
    expect(HostedUsage.totalBetween('2000', '9999')).toBe(40_000);
  });

  it('keeps stopped attempts out of the recent turn costs', async () => {
    scripts = [stream(costly, THINK), replies];
    const user = supporter();

    const res = await send(user, streamed()).set('X-Formamorph-Prompt-Type', 'narration');

    expect(res.status).toBe(200);
    expect(HostedUsage.recentTurnCosts(subject(user), 5)).toEqual([9]);
  });

  it('settles the retry from its own usage and output, not the stopped attempt\'s', async () => {
    scripts = [stream(part({ reasoning: 'x'.repeat(4000) })), stream(TEXT, DONE)];

    await send(supporter(), streamed());

    const [stopped, retried] = rows();
    expect(stopped.cost).toBeGreaterThan(retried.cost);
    expect(retried.output).toBeNull();
    const estimatedPrompt = db.prepare('SELECT estimated_prompt_tokens AS n FROM hosted_usage LIMIT 1').get().n;
    expect(retried.cost).toBe(estimatedPrompt + 2 * Math.ceil('Hello'.length / 4));
  });

  it('settles the stopped attempt before the retry reserves', async () => {
    let during;
    scripts = [stream(THINK), (_req, res) => {
      during = flags();
      replies(_req, res);
    }];

    await send(supporter(), streamed());

    expect(during).toEqual([
      { status: 'error', retry: 0, stopped: 1 },
      { status: 'open', retry: 1, stopped: 0 }
    ]);
  });
});

describe('the schema step', () => {
  it('adds the columns to a table built without them, and rows default to neither', () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE hosted_usage (id INTEGER PRIMARY KEY)');
    old.exec('INSERT INTO hosted_usage (id) VALUES (1)');

    expect(hostedUsageRetry.apply(old)).toBe(true);
    expect(old.prepare('SELECT retry, stopped FROM hosted_usage').get()).toEqual({ retry: 0, stopped: 0 });
    expect(hostedUsageRetry.apply(old)).toBe(false);
    old.close();
  });
});
