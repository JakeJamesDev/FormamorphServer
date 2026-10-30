import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import http from 'http';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader, fromAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Policy = require('../src/models/Policy');
const PatreonLink = require('../src/models/PatreonLink');
const { CLIENT_MINIMUMS } = require('../src/config/settings');
const { HOSTED_AI, REFUSAL_CODES, REFUSALS } = require('../src/config/hostedAi');

/**
 * Formamorph AI: the hosted chat-completions proxy, driven over HTTP against a fake upstream.
 */

const UPSTREAM_KEY = 'test-upstream-key';
const USER_SECRET = 'test-user-secret';
const ROUTE = '/api/hosted-ai/chat/completions';

const SSE = [
  'data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n'
];

/** The proxy's own usage event sits before [DONE]; every other byte is the upstream's. */
const withoutUsage = (text) => text.replace(/event: usage\ndata: .*\n\n/, '');

// The fake upstream: each test sets `script` to how it answers, and reads `received` for what it was sent.
let script;
let received;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const entry = { headers: req.headers, body: JSON.parse(raw), closed: false };
    res.on('close', () => { entry.closed = !res.writableFinished; });
    received.push(entry);
    script(req, res, entry);
  });
});

const REPLY = { id: 'c2', choices: [{ message: { role: 'assistant', content: 'Hi' } }], usage: { prompt_tokens: 3 } };

/** Answers as a real upstream does: SSE when asked to stream, one JSON body otherwise. */
const streamAll = (_req, res, entry) => {
  if (!entry.body.stream) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(REPLY));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of SSE) res.write(event);
  return res.end();
};

/** Sends the first event, then nothing: the shape of a stalled or slow upstream. */
const stallAfterFirst = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(SSE[0]);
};

const MODELS = {
  models: [
    {
      id: 'main',
      model: 'vendor/model-a',
      routing: { order: ['x'], allow_fallbacks: false },
      reasoning: { effort: 'low' },
      prices: { prompt: 1, completion: 2 }
    },
    { id: 'spare', model: 'vendor/model-b', prices: { prompt: 1, completion: 2 } }
  ],
  activeModel: 'main',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  // Room for every call this file makes; metering has its own file.
  tiers: Object.fromEntries(['supporter', 'supporter_plus', 'supporter_top'].map((tier) => [tier, { window: 100_000, budget: 1000 }])),
  tokenRatio: 4,
  tokenMargin: 0,
  turnLimitSeconds: 600,
  turnCallCap: 50,
  retentionDays: 30
};

const rnd = () => Math.random().toString(36).slice(2, 8);

/** An 18+ account on a Patreon tier, the shape every admitted call has. */
const supporter = (tier = 'supporter') => {
  const user = createUser({ username: `sup-${rnd()}` });
  Policy.accept(Policy.AGE_GATE, user.id);
  PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
  return user;
};

const chat = (overrides = {}) => ({
  model: 'client-chosen-model',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 200,
  ...overrides
});

const send = (user, body) => request(app).post(ROUTE).set(authHeader(user)).send(body);

beforeAll(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.HOSTED_AI_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
  process.env.HOSTED_AI_API_KEY = UPSTREAM_KEY;
  process.env.HOSTED_AI_USER_SECRET = USER_SECRET;
});

afterAll(() => {
  upstream.closeAllConnections();
  return new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  // The shared teardown clears policies; the age-gate row is seeded by the schema.
  migrate(db);
  Setting.set(HOSTED_AI, MODELS);
  script = streamAll;
  received = [];
});

afterEach(() => {
  db.prepare('DELETE FROM patreon_links').run();
});

describe('the refusal code list', () => {
  it('is pinned, with the status each code answers', () => {
    expect(REFUSAL_CODES).toEqual([
      'invalid_request', 'age_gate_required', 'not_entitled', 'service_paused', 'rate_limited',
      'turn_expired', 'budget_exhausted', 'window_exceeded', 'image_not_supported', 'upstream_error'
    ]);
    expect(Object.fromEntries(REFUSAL_CODES.map((code) => [code, REFUSALS[code].status]))).toEqual({
      invalid_request: 400,
      age_gate_required: 403,
      not_entitled: 403,
      service_paused: 503,
      rate_limited: 429,
      turn_expired: 409,
      budget_exhausted: 402,
      window_exceeded: 413,
      image_not_supported: 400,
      upstream_error: 502
    });
  });
});

describe('admission', () => {
  it('refuses a request with no token through protect', async () => {
    const res = await request(app).post(ROUTE).send(chat());

    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('answers through the per-route client minimum', async () => {
    Setting.set(CLIENT_MINIMUMS, { 'POST /api/hosted-ai': { minVersion: '3.0.0', feature: 'Formamorph AI' } });
    const user = supporter();

    const old = await send(user, chat()).set('X-Formamorph-Client', '2.9.0 web');
    const current = await send(user, chat()).set('X-Formamorph-Client', '3.0.0 web');

    expect(old.status).toBe(426);
    expect(old.body.code).toBe('CLIENT_UPDATE_REQUIRED');
    expect(current.status).toBe(200);
  });

  it('refuses an account that has not accepted the age gate', async () => {
    const user = createUser({ username: `minor-${rnd()}` });
    PatreonLink.link({ userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter_top', pledgeStart: null, checkedAt: null });

    const res = await send(user, chat());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, code: 'age_gate_required', error: REFUSALS.age_gate_required.error });
    expect(received).toHaveLength(0);
  });

  it('refuses when acceptance cannot be confirmed because the age-gate policy is gone', async () => {
    const user = supporter();
    db.prepare("DELETE FROM policies WHERE id = 'age_gate'").run();

    const res = await send(user, chat());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('age_gate_required');
  });

  it('refuses an account with no Patreon link, or a link with no tier', async () => {
    const unlinked = createUser({ username: `free-${rnd()}` });
    Policy.accept(Policy.AGE_GATE, unlinked.id);
    const lapsed = supporter();
    PatreonLink.setTier({ patreonUserId: `p-${lapsed.id}`, tier: null, pledgeStart: null, checkedAt: null });

    for (const user of [unlinked, lapsed]) {
      const res = await send(user, chat());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, code: 'not_entitled', error: REFUSALS.not_entitled.error });
    }
    expect(received).toHaveLength(0);
  });

  it('admits every Supporter tier', async () => {
    for (const tier of ['supporter', 'supporter_plus', 'supporter_top']) {
      expect((await send(supporter(tier), chat())).status).toBe(200);
    }
  });

  it('refuses with service_paused while no model is active or the upstream env is missing', async () => {
    const user = supporter();
    Setting.set(HOSTED_AI, { models: [], activeModel: null, maxTokensCap: null, idleLimitSeconds: null });
    const unconfigured = await send(user, chat());

    Setting.set(HOSTED_AI, MODELS);
    delete process.env.HOSTED_AI_API_KEY;
    const keyless = await send(user, chat());
    process.env.HOSTED_AI_API_KEY = UPSTREAM_KEY;

    for (const res of [unconfigured, keyless]) {
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('service_paused');
    }
    expect(received).toHaveLength(0);
  });

  it('is not counted by the global per-address rate limit', async () => {
    const address = '192.0.2.150';
    for (let i = 0; i < 1001; i += 1) {
      const res = await fromAddress(address, request(app).post(ROUTE).send({}));
      expect(res.status).toBe(401);
    }
  }, 30_000); // 1,001 sequential requests.
});

describe('the upstream body', () => {
  it('keeps only allow-listed fields and sets model, routing, reasoning, usage and user itself', async () => {
    const user = supporter();

    const res = await send(user, chat({
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      stop: ['\n\n'],
      response_format: { type: 'json_schema', extra: 1, json_schema: { name: 'turn', schema: { type: 'object' }, cache_control: {} } },
      tool_choice: { type: 'function', extra: 1, function: { name: 'roll', cache_control: {} } },
      tools: [{ type: 'function', cache_control: { type: 'ephemeral' }, function: { name: 'roll', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Narrate.', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'Go', cache_control: { type: 'ephemeral' } },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', index: 0, cache_control: {}, function: { name: 'roll', arguments: '{}', extra: 1 } }]
        },
        { role: 'tool', tool_call_id: 't1', content: '4' }
      ],
      n: 4,
      user: 'player@example.test',
      provider: { order: ['cheap'] },
      route: 'fallback',
      models: ['other/model'],
      transforms: ['middle-out'],
      prompt_cache_key: 'k',
      cache_control: { type: 'ephemeral' },
      usage: { include: true },
      unknown_field: 1
    }));

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual({
      model: 'vendor/model-a',
      provider: { order: ['x'], allow_fallbacks: false },
      reasoning: { effort: 'low' },
      user: crypto.createHmac('sha256', USER_SECRET).update(`p-${user.id}`).digest('hex'),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 200,
      temperature: 0.7,
      top_p: 0.9,
      stop: ['\n\n'],
      response_format: { type: 'json_schema', json_schema: { name: 'turn', schema: { type: 'object' } } },
      tool_choice: { type: 'function', function: { name: 'roll' } },
      tools: [{ type: 'function', function: { name: 'roll', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Narrate.' }] },
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'roll', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: '4' }
      ]
    });
  });

  it('follows the active model entry, and a model without routing sends none', async () => {
    Setting.set(HOSTED_AI, { ...MODELS, activeModel: 'spare' });

    await send(supporter(), chat());

    expect(received[0].body.model).toBe('vendor/model-b');
    expect(received[0].body).not.toHaveProperty('provider');
    expect(received[0].body).not.toHaveProperty('reasoning');
  });

  it('requires max_tokens and caps it from settings', async () => {
    const user = supporter();

    const missing = await send(user, chat({ max_tokens: undefined }));
    const fraction = await send(user, chat({ max_tokens: 10.5 }));
    await send(user, chat({ max_tokens: 50_000 }));

    for (const res of [missing, fraction]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }
    expect(received).toHaveLength(1);
    expect(received[0].body.max_tokens).toBe(1000);
  });

  it('gives each spend subject its own stable anonymous id', async () => {
    const one = supporter();
    const two = supporter();

    await send(one, chat());
    await send(one, chat());
    await send(two, chat());

    const [a, b, c] = received.map((entry) => entry.body.user);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(one.id);
  });

  it('sends the key from the environment and never returns it', async () => {
    const res = await send(supporter(), chat());

    expect(received[0].headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(JSON.stringify(res.headers) + res.text).not.toContain(UPSTREAM_KEY);
  });

  it('refuses image content parts', async () => {
    for (const type of ['image_url', 'input_image']) {
      const res = await send(supporter(), chat({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type, image_url: { url: 'data:image/png;base64,AA' } }] }]
      }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, code: 'image_not_supported', error: REFUSALS.image_not_supported.error });
    }
    expect(received).toHaveLength(0);
  });

  it('refuses a body that is not a chat completion', async () => {
    const user = supporter();
    const bodies = [
      { max_tokens: 10 },
      chat({ messages: [] }),
      chat({ messages: ['hi'] }),
      chat({ messages: [{ role: 'narrator', content: 'Hi' }] }),
      chat({ tools: 'roll' }),
      chat({ tools: [{ type: 'retrieval', function: { name: 'roll' } }] }),
      chat({ tool_choice: { type: 'search' } }),
      chat({ response_format: { type: 'grammar' } }),
      chat({ temperature: '0.7' }),
      chat({ stop: [3] })
    ];
    for (const body of bodies) {
      const res = await send(user, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }
    expect(received).toHaveLength(0);
  });

  it('refuses a body over the route limit as invalid_request', async () => {
    const res = await send(supporter(), chat({ messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(received).toHaveLength(0);
  });
});

describe('streaming', () => {
  it('passes a stream through unchanged', async () => {
    const res = await send(supporter(), chat({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(withoutUsage(res.text)).toBe(SSE.join(''));
  });

  it('returns a non-streamed reply unchanged', async () => {
    const res = await send(supporter(), chat());

    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify(REPLY));
  });

  it('refuses with upstream_error and never forwards the upstream error body', async () => {
    script = (_req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"provider-detail-xyz"}');

    const res = await send(supporter(), chat({ stream: true }));

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, code: 'upstream_error', error: REFUSALS.upstream_error.error });
    expect(res.text).not.toContain('provider-detail-xyz');
  });

  it('passes events split across chunks through unchanged', async () => {
    const whole = SSE.join('');
    script = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const cuts = [7, 30, 61, 62, 100, whole.length];
      cuts.forEach((cut, i) => setTimeout(() => {
        const piece = whole.slice(i ? cuts[i - 1] : 0, cut);
        return i === cuts.length - 1 ? res.end(piece) : res.write(piece);
      }, i * 20));
    };

    const res = await send(supporter(), chat({ stream: true }));

    expect(withoutUsage(res.text)).toBe(whole);
  });

  it('replaces an upstream error inside a 200 reply, streamed or not, split or whole', async () => {
    const errorEvent = 'data: {"error":{"message":"host-detail-xyz","code":500}}\n\n';
    script = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(SSE[0] + errorEvent.slice(0, 20));
      setTimeout(() => res.end(errorEvent.slice(20) + SSE[3]), 30);
    };
    const user = supporter();

    const streamed = await send(user, chat({ stream: true }));
    script = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"error":{"message":"host-detail-xyz"}}');
    const whole = await send(user, chat());

    expect(streamed.text).toBe(`${SSE[0]}event: error\ndata: ${JSON.stringify({ success: false, code: 'upstream_error', error: REFUSALS.upstream_error.error })}\n\n`);
    expect(whole.status).toBe(502);
    expect(whole.body.code).toBe('upstream_error');
    expect(streamed.text + whole.text).not.toContain('host-detail-xyz');
  });

  it('ends with an SSE error event when the upstream fails after the headers', async () => {
    script = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(SSE[0]);
      setTimeout(() => req.socket.destroy(), 50);
    };

    const res = await send(supporter(), chat({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.text.startsWith(SSE[0])).toBe(true);
    expect(res.text.endsWith(`event: error\ndata: ${JSON.stringify({ success: false, code: 'upstream_error', error: REFUSALS.upstream_error.error })}\n\n`)).toBe(true);
  });

  it('aborts an upstream that is silent past the idle limit, mid-stream and before any reply', async () => {
    Setting.set(HOSTED_AI, { ...MODELS, idleLimitSeconds: 1 });
    script = stallAfterFirst;
    const user = supporter();

    const streamed = await send(user, chat({ stream: true }));
    script = () => {};
    const silent = await send(user, chat());

    expect(streamed.text).toBe(`${SSE[0]}event: error\ndata: ${JSON.stringify({ success: false, code: 'upstream_error', error: REFUSALS.upstream_error.error })}\n\n`);
    expect(silent.status).toBe(502);
    expect(silent.body.code).toBe('upstream_error');
    await vi.waitFor(() => expect(received.every((entry) => entry.closed)).toBe(true));
  }, 10_000);

  it('lets a slow upstream finish while each gap stays under the idle limit', async () => {
    Setting.set(HOSTED_AI, { ...MODELS, idleLimitSeconds: 1 });
    script = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      SSE.forEach((event, i) => setTimeout(() => (i === SSE.length - 1 ? res.end(event) : res.write(event)), (i + 1) * 400));
    };

    const res = await send(supporter(), chat({ stream: true }));

    expect(withoutUsage(res.text)).toBe(SSE.join(''));
  }, 10_000);

  it('aborts the upstream call when the client disconnects', async () => {
    script = stallAfterFirst;
    const user = supporter();
    const url = new URL(ROUTE, request(app).post(ROUTE).url);
    const payload = JSON.stringify(chat({ stream: true }));

    await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...authHeader(user) }
      }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.on('timeout', reject);
      req.end(payload);
    });

    await vi.waitFor(() => expect(received[0].closed).toBe(true));
  });
});

describe('logging', () => {
  it('writes no request or upstream text to any log, a parse error included', async () => {
    const lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); return true; };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'info').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    ];
    const user = supporter();
    script = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"secret-reply-text"}}]}\n\n');
    };

    try {
      await send(user, chat({ stream: true, messages: [{ role: 'user', content: 'secret-prompt-text' }] }));
      const malformed = await request(app).post(ROUTE).set(authHeader(user))
        .set('Content-Type', 'application/json').send('{"messages":[{"content":"secret-broken-text"');
      script = (_req, res) => res.writeHead(500).end('secret-upstream-error-text');
      await send(user, chat({ messages: [{ role: 'user', content: 'secret-prompt-two' }] }));

      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('invalid_request');
      expect(malformed.text).not.toContain('secret');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes('secret') || line.includes(UPSTREAM_KEY))).toEqual([]);
  });
});

describe('the hosted settings record', () => {
  const admin = () => createUser({ username: `admin-${rnd()}`, accountType: 'admin' });
  const mod = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });
  const read = (user) => request(app).get(`/api/settings/${HOSTED_AI}`).set(authHeader(user));
  const write = (user, value) => request(app).put(`/api/settings/${HOSTED_AI}`).set(authHeader(user)).send({ value });

  it('is admin-only: a moderator can neither read nor write it', async () => {
    const moderator = mod();

    const readRes = await read(moderator);
    const writeRes = await write(moderator, { ...MODELS, maxTokensCap: 5 });

    expect(readRes.status).toBe(403);
    expect(JSON.stringify(readRes.body)).not.toContain('vendor/model-a');
    expect(writeRes.status).toBe(403);
    expect(Setting.get(HOSTED_AI).maxTokensCap).toBe(1000);
  });

  it('holds the approved models and the active one, and an admin can switch it', async () => {
    const owner = admin();

    const saved = await write(owner, { ...MODELS, activeModel: 'spare' });
    const readBack = await read(owner);
    await send(supporter(), chat());

    expect(saved.status).toBe(200);
    expect(readBack.body.data.models.map((entry) => entry.id)).toEqual(['main', 'spare']);
    expect(readBack.body.data.activeModel).toBe('spare');
    expect(received[0].body.model).toBe('vendor/model-b');
  });

  it('refuses to remove the active entry', async () => {
    const res = await write(admin(), { ...MODELS, models: [MODELS.models[1]] });

    expect(res.status).toBe(400);
    expect(Setting.get(HOSTED_AI).models).toHaveLength(2);
  });

  it('has no place for the upstream key', async () => {
    const owner = admin();

    const res = await write(owner, { ...MODELS, apiKey: 'sk-should-not-store' });
    const readBack = await read(owner);

    expect(res.status).toBe(400);
    expect(JSON.stringify(readBack.body)).not.toContain(UPSTREAM_KEY);
  });
});
