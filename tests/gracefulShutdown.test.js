import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const { gracefulShutdown } = require('../src/utils/gracefulShutdown');

/**
 * Stopping the server while a keep-alive client, like the reverse proxy, keeps sending requests.
 */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

/** A server whose `/slow` sends headers at once and ends after 150 ms and whose `/stream` never ends, with its shutdown handler. */
async function start(graceMs) {
  const server = http.createServer((req, res) => {
    // Like the hosted-AI stream, which names keep-alive itself.
    if (req.url === '/slow') {
      res.writeHead(200, { Connection: 'keep-alive' });
      setTimeout(() => res.end('slow'), 150);
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('data: one\n\n');
      return;
    }
    res.end('ok');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const exits = [];
  const exited = new Promise((resolve) => {
    server.shutdown = gracefulShutdown(server, { graceMs, exit: (code) => { exits.push(code); resolve(code); }, log: () => {} });
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  cleanup.push(() => {
    agent.destroy();
    server.closeAllConnections();
    return new Promise((resolve) => { server.close(() => resolve()); });
  });
  return { server, agent, exits, exited, port: server.address().port };
}

function get(port, agent, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Resolves with the elapsed ms when `promise` settles, or null after `limitMs`. */
async function within(promise, limitMs) {
  const startedAt = Date.now();
  let timer;
  const result = await Promise.race([
    promise.then(() => Date.now() - startedAt),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), limitMs); }),
  ]);
  clearTimeout(timer);
  return result;
}

describe('graceful shutdown', () => {
  it('exits while a keep-alive client keeps sending requests', async () => {
    const { server, agent, exited, exits, port } = await start(60_000);
    await get(port, agent, '/');

    // The pooled connection is busy when the signal arrives, so closing idle connections misses it.
    const inFlight = get(port, agent, '/slow');
    await sleep(20);
    server.shutdown('SIGTERM');

    let sending = true;
    const answers = [];
    const load = (async () => {
      while (sending) {
        try { answers.push(await get(port, agent, '/')); } catch { break; }
        await sleep(10);
      }
    })();

    const slow = await inFlight;
    const elapsed = await within(exited, 2_000);
    sending = false;
    await load;

    expect(slow.body).toBe('slow');
    expect(elapsed).not.toBeNull();
    expect(exits).toEqual([0]);
    for (const answer of answers) expect(answer.connection).toBe('close');
  });

  it('cuts a stream still open when the grace runs out, then exits', async () => {
    const { server, exited, exits, port } = await start(200);
    const stream = new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/stream' }, (res) => {
        res.on('data', () => {});
        res.on('close', () => resolve('closed'));
        res.on('error', () => resolve('closed'));
      });
    });
    await sleep(50);
    server.shutdown('SIGTERM');

    expect(await within(exited, 100)).toBeNull();
    expect(await within(exited, 2_000)).not.toBeNull();
    expect(await stream).toBe('closed');
    expect(exits).toEqual([0]);
  });

  it('handles a second signal without closing twice', async () => {
    const { server, exited, exits } = await start(60_000);
    server.shutdown('SIGTERM');
    server.shutdown('SIGINT');
    await within(exited, 2_000);
    await sleep(20);
    expect(exits).toEqual([0]);
  });
});
