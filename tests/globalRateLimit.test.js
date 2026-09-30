import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { fromAddress } from './helpers.js';

/**
 * The loose global limit: one budget per client address, and a refusal a browser can read.
 */

const BUDGET = 1000;
const SPENDER = '192.0.2.77';

const hit = (address) => fromAddress(address, request(app).get('/api/no-such-route'));

describe('global rate limit', () => {
  it('refuses a spent address with a 429 a browser can read, and no header buys a new budget', async () => {
    for (let i = 0; i < BUDGET; i += 1) {
      expect((await hit(SPENDER)).status).not.toBe(429);
    }

    const refused = await hit(SPENDER).set('Origin', 'https://formamorph.ai');
    expect(refused.status).toBe(429);
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    expect(refused.headers['access-control-expose-headers']).toContain('Retry-After');
    expect(refused.headers['retry-after']).toBeDefined();

    expect((await hit(SPENDER).set('CF-Connecting-IP', '198.51.100.200')).status).toBe(429);
    expect((await hit('198.51.100.201')).status).not.toBe(429);
  });
});
