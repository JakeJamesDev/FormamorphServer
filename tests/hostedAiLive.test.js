import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { db, scratchDir } from './context.js';

const require = createRequire(import.meta.url);
const { readLiveEnv, readLiveSettings, runLive } = require('../src/utils/hostedLive');
const { acquireSlot } = require('../src/utils/hostedLimits');

/**
 * The Formamorph AI live run, against a local stand-in for the provider. The real upstream is the one thing
 * these tests replace, so the key, body and failures are read at the point they would leave the machine.
 */

const TEST_KEY = 'testing-key';
const SETTINGS = {
  models: [{ id: 'live', model: 'vendor/live-model', prices: { prompt: 1, completion: 2 } }],
  activeModel: 'live',
  maxTokensCap: 1000,
  idleLimitSeconds: 5,
  tiers: { supporter: { window: 100000, budget: 100 } },
  tokenRatio: 4,
  tokenMargin: 50,
  turnLimitSeconds: 600,
  turnCallCap: 100,
  retentionDays: 30,
  parallelLimit: 4,
  perMinuteLimit: 60,
  dailyCeiling: 100,
  balanceThreshold: null
};
const USAGE = { prompt_tokens: 10, completion_tokens: 2 };
const REQUEST = { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 50 };

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** Answers each call by `behavior`, as a provider would, and records what reached it. */
const startProvider = async (behavior) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ authorization: req.headers.authorization, body });
      behavior(res, body);
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
};

const answers = (res, body) => {
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Whole reply' }, finish_reason: 'stop' }], usage: USAGE }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(frame({ choices: [{ delta: { reasoning: 'hmm' } }] }));
  res.write(frame({ choices: [{ delta: { content: 'Stream ' } }] }));
  res.write(frame({ choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }] }));
  res.write(frame({ choices: [], usage: USAGE }));
  res.end('data: [DONE]\n\n');
};

let provider;
const run = async (behavior, options = {}) => {
  provider = await startProvider(behavior);
  return runLive({ settings: SETTINGS, upstreamUrl: provider.url, apiKey: TEST_KEY, requestBody: REQUEST, ...options });
};

beforeEach(() => {
  process.env.HOSTED_AI_BALANCE_URL = 'http://127.0.0.1:1/balance';
  process.env.HOSTED_AI_USAGE_URL = 'http://127.0.0.1:1/usage';
});

afterEach(async () => {
  await provider?.close();
  provider = null;
  for (const table of ['patreon_links', 'hosted_usage']) db.prepare(`DELETE FROM ${table}`).run();
  for (const key of ['HOSTED_AI_UPSTREAM_URL', 'HOSTED_AI_API_KEY', 'HOSTED_AI_USER_SECRET', 'HOSTED_AI_BALANCE_URL', 'HOSTED_AI_USAGE_URL']) {
    delete process.env[key];
  }
});

describe('the live run', () => {
  it('sends both modes upstream on the testing key, with the setting\'s model', async () => {
    const report = await run(answers);

    expect(provider.seen.map((call) => call.authorization)).toEqual([`Bearer ${TEST_KEY}`, `Bearer ${TEST_KEY}`]);
    expect(provider.seen.map((call) => call.body.stream)).toEqual([true, false]);
    expect(provider.seen.every((call) => call.body.model === 'vendor/live-model')).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('reports each reply with its settled usage row and usage state', async () => {
    const { calls, openRows, slots } = await run(answers);

    expect(calls.map((call) => [call.mode, call.status, call.reply])).toEqual([
      ['stream', 200, 'Stream reply'],
      ['whole', 200, 'Whole reply']
    ]);
    expect(calls[0].thinkingChars).toBe(3);
    expect(calls.every((call) => call.usage !== null)).toBe(true);
    for (const call of calls) {
      expect(call.rows).toHaveLength(1);
      expect(call.rows[0]).toMatchObject({ status: 'ok', model: 'live', prompt_tokens: 10, output_tokens: 2, cost_source: 'computed', cost_micros: 14 });
    }
    expect(openRows).toBe(0);
    expect(slots).toBe(0);
  });

  it('sends only the requested mode', async () => {
    const report = await run(answers, { modes: ['whole'] });

    expect(report.calls.map((call) => call.mode)).toEqual(['whole']);
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0].body.stream).toBe(false);
  });

  it('fails when the provider refuses the key', async () => {
    const report = await run((res) => {
      res.writeHead(401);
      res.end();
    }, { modes: ['whole'] });

    expect(report.ok).toBe(false);
    expect(report.calls[0]).toMatchObject({ status: 502, code: 'upstream_error' });
    expect(report.calls[0].rows.at(-1)).toMatchObject({ status: 'error', failure: 'status_401' });
    expect(report.openRows).toBe(0);
    expect(report.slots).toBe(0);
  });

  it('fails a stream that errors after its reply starts', async () => {
    const report = await run((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame({ choices: [{ delta: { content: 'Partial' } }] }));
      setTimeout(() => res.end(frame({ error: { message: 'gone' } })), 50);
    }, { modes: ['stream'] });

    expect(report.ok).toBe(false);
    expect(report.calls[0]).toMatchObject({ status: 200, code: 'upstream_error', reply: 'Partial' });
  });

  it('fails a stream that errors before its reply starts, after the proxy retries it', async () => {
    const report = await run((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame({ error: { message: 'gone' } }));
    }, { modes: ['stream'] });

    expect(report.ok).toBe(false);
    expect(report.calls[0]).toMatchObject({ status: 502, code: 'upstream_error' });
    expect(provider.seen).toHaveLength(2);
    expect(report.calls[0].rows.map((row) => row.status)).toEqual(['error', 'error']);
  });

  it('fails a refusal, with no call upstream', async () => {
    const report = await run(answers, { tier: 'supporter_plus' });

    expect(report.ok).toBe(false);
    expect(report.calls.map((call) => call.code)).toEqual(['service_paused', 'service_paused']);
    expect(provider.seen).toEqual([]);
  });

  it('fails a usage row left open', async () => {
    db.prepare(`
      INSERT INTO hosted_usage (subject, turn_id, tier, estimated_prompt_tokens, cost_micros, started_at, status)
      VALUES ('stuck', 'stuck-turn', 'supporter', 1, 0, ?, 'open')
    `).run(new Date().toISOString());
    const report = await run(answers, { modes: ['whole'], drainMs: 20 });

    expect(report.calls[0].rows.at(-1).status).toBe('ok');
    expect(report.openRows).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('fails a parallel slot left held', async () => {
    const release = acquireSlot('stuck-account', 1);
    const report = await run(answers, { modes: ['whole'], drainMs: 20 });
    release();

    expect(report.calls[0].rows.at(-1).status).toBe('ok');
    expect(report.slots).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('turns the provider monitors off', async () => {
    await run(answers, { modes: ['whole'] });

    expect(process.env.HOSTED_AI_BALANCE_URL).toBeUndefined();
    expect(process.env.HOSTED_AI_USAGE_URL).toBeUndefined();
  });
});

describe('the live run\'s environment', () => {
  it('reads the testing key', () => {
    expect(readLiveEnv({ HOSTED_AI_UPSTREAM_URL: 'http://up', HOSTED_AI_TEST_API_KEY: TEST_KEY }))
      .toEqual({ upstreamUrl: 'http://up', apiKey: TEST_KEY });
  });

  it('never falls back to the real key', () => {
    expect(() => readLiveEnv({ HOSTED_AI_UPSTREAM_URL: 'http://up', HOSTED_AI_API_KEY: 'real-key' }))
      .toThrow('HOSTED_AI_TEST_API_KEY');
  });

  it('names a missing upstream URL', () => {
    expect(() => readLiveEnv({ HOSTED_AI_TEST_API_KEY: TEST_KEY })).toThrow('HOSTED_AI_UPSTREAM_URL');
  });
});

describe('the live run\'s settings copy', () => {
  const copy = (value) => {
    const file = path.join(scratchDir('fms-live-settings-'), 'settings.json');
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };

  it('reads a valid copy', () => {
    expect(readLiveSettings(copy(SETTINGS))).toEqual(SETTINGS);
  });

  it('refuses a copy an admin write would refuse', () => {
    expect(() => readLiveSettings(copy({ ...SETTINGS, activeModel: 'other' }))).toThrow('not in the approved list');
  });

  it('names a missing copy', () => {
    expect(() => readLiveSettings('no-such-file.json')).toThrow('No settings copy at no-such-file.json');
  });
});
