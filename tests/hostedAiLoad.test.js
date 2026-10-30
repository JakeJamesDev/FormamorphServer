import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { db } from './context.js';

const require = createRequire(import.meta.url);
const { runLoad } = require('../src/utils/hostedLoad');

/**
 * The Formamorph AI load run, small. It drives the real app against its slow fake upstream and checks the
 * report: a clean run settles every row and frees every slot, and a refusal the flags did not plan fails it.
 */

const SMALL = { accounts: 3, turns: 2, parallel: 3, delayMs: 20 };

afterEach(() => {
  for (const table of ['patreon_links', 'hosted_usage']) db.prepare(`DELETE FROM ${table}`).run();
  for (const key of ['HOSTED_AI_UPSTREAM_URL', 'HOSTED_AI_API_KEY', 'HOSTED_AI_USER_SECRET']) delete process.env[key];
});

describe('the load run', () => {
  it('settles every row and frees every slot, with no failures', async () => {
    const report = await runLoad(SMALL);

    expect(report.calls).toBe(SMALL.accounts * SMALL.turns * SMALL.parallel);
    expect(report.rows).toBe(report.calls);
    expect(report.failures).toEqual({});
    expect(report.openRows).toBe(0);
    expect(report.slots).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.ttfbP50Ms).toBeGreaterThanOrEqual(SMALL.delayMs);
    expect(report.ttfbP90Ms).toBeGreaterThanOrEqual(report.ttfbP50Ms);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hosted_usage WHERE status != 'ok'").get().n).toBe(0);
  });

  it('fails a refusal the flags did not plan', async () => {
    const report = await runLoad({ ...SMALL, parallelLimit: 1 });

    expect(report.failures.rate_limited).toBeGreaterThan(0);
    expect(report.unplanned).toContain('rate_limited');
    expect(report.ok).toBe(false);
    expect(report.openRows).toBe(0);
    expect(report.slots).toBe(0);
  });

  it('passes a refusal the flags planned, still with no leak', async () => {
    const report = await runLoad({ ...SMALL, parallelLimit: 1, expect: ['rate_limited'] });

    expect(report.failures.rate_limited).toBeGreaterThan(0);
    expect(report.unplanned).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.openRows).toBe(0);
    expect(report.slots).toBe(0);
  });

  it('refuses an expected code the proxy does not have', async () => {
    await expect(runLoad({ ...SMALL, expect: ['made_up'] })).rejects.toThrow('Unknown refusal code');
  });
});
