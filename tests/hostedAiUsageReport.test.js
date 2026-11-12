import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const PatreonLink = require('../src/models/PatreonLink');
const HostedGrant = require('../src/models/HostedGrant');
const HostedProviderSpend = require('../src/models/HostedProviderSpend');
const FunnelTotal = require('../src/models/FunnelTotal');
const { HOSTED_AI } = require('../src/config/hostedAi');
const { DAY_MS } = require('../src/config/time');

const ROUTE = '/api/hosted-ai/admin/usage-report';
const SETTINGS = { tiers: { supporter: { window: 1000, budget: 1 }, supporter_plus: { window: 2000, budget: 2 } } };

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
const dayOf = (iso) => iso.slice(0, 10);

/** Insert one settled call. Each test names only what it reads. */
const call = (fields = {}) => {
  const row = {
    subject: 'subject-a', user_id: null, turn_id: 'turn-a', tier: 'supporter', model: 'm', prompt_type: 'narration',
    estimated_prompt_tokens: 1, prompt_tokens: null, cached_tokens: null, output_tokens: null, cost_micros: 100,
    cost_source: 'upstream', started_at: new Date().toISOString(), duration_ms: null, status: 'ok', retry: 0, stopped: 0,
    first_token_ms: null, max_gap_ms: null, finish_reason: null, failure: null, ...fields
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO hosted_usage (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(row);
};

const read = async (days = 7) => {
  const res = await request(app).get(`${ROUTE}?days=${days}`).set(authHeader(createUser({ accountType: 'admin' })));
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeEach(() => {
  migrate(db);
  db.prepare('DELETE FROM hosted_usage').run();
  db.prepare('DELETE FROM hosted_provider_spend').run();
  db.prepare('DELETE FROM funnel_totals').run();
  db.prepare('DELETE FROM hosted_grants').run();
  db.prepare('DELETE FROM patreon_links').run();
  db.prepare('DELETE FROM active_install_days').run();
  db.prepare('DELETE FROM active_install_totals').run();
  Setting.set(HOSTED_AI, SETTINGS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fix the clock at an instant, for reads that depend on the budget week or the calendar month. */
const at = (iso) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

const install = (day, hash, platform = 'windows') => {
  db.prepare('INSERT INTO active_install_days (day, hash, platform, version) VALUES (?, ?, ?, ?)').run(day, hash, platform, '3.6.2');
};

describe('GET /api/hosted-ai/admin/usage-report', () => {
  it('refuses everyone but an admin, and a range it cannot read', async () => {
    expect((await request(app).get(ROUTE)).status).toBe(401);
    for (const accountType of ['normal', 'mod', 'dev']) {
      expect((await request(app).get(ROUTE).set(authHeader(createUser({ accountType })))).status).toBe(403);
    }
    const admin = authHeader(createUser({ accountType: 'admin' }));
    for (const days of ['0', '367', '1.5', 'week']) {
      expect((await request(app).get(`${ROUTE}?days=${days}`).set(admin)).status).toBe(400);
    }
  });

  it('never names an account, a subject or a turn', async () => {
    const user = createUser({ username: 'report-private-name' });
    call({ subject: 'private-subject-id', user_id: user.id, turn_id: 'private-turn-id', first_token_ms: 500, max_gap_ms: 100, duration_ms: 1500, output_tokens: 10 });

    const stored = JSON.stringify(await read());

    for (const trace of ['private-subject-id', user.id, 'report-private-name', 'private-turn-id']) {
      expect(stored).not.toContain(trace);
    }
  });

  it('fills every day of the range and leaves out the days before it', async () => {
    call({ started_at: daysAgo(1), turn_id: 't1', subject: 's1', cost_micros: 100 });
    call({ started_at: daysAgo(1), turn_id: 't1', subject: 's1', cost_micros: 200 });
    call({ started_at: daysAgo(1), turn_id: 't2', subject: 's2', cost_micros: 300 });
    call({ started_at: daysAgo(3), cost_micros: 999 });
    HostedProviderSpend.record({ day: dayOf(daysAgo(1)), providerMicros: 650, recordedMicros: 600, readAt: new Date().toISOString() });

    const report = await read(2);

    expect(report.days).toEqual([
      { day: dayOf(daysAgo(1)), calls: 3, turns: 2, accounts: 2, costMicros: 600, providerMicros: 650, installs: null },
      { day: dayOf(daysAgo(0)), calls: 0, turns: 0, accounts: 0, costMicros: 0, providerMicros: null, installs: null }
    ]);
    expect(report.totals).toMatchObject({ calls: 3, turns: 2, accounts: 2, costMicros: 600, providerMicros: 650 });
  });

  it('counts a stopped attempt in spend, since the provider bills it', async () => {
    call({ cost_micros: 100 });
    call({ cost_micros: 40, stopped: 1 });

    expect((await read()).totals.costMicros).toBe(140);
  });

  it('sums each prompt type, with medians and a high percentile from its own calls', async () => {
    call({ prompt_type: 'summary', cost_micros: 5, first_token_ms: 9000, max_gap_ms: 9000, duration_ms: 10000, output_tokens: 10 });
    for (const [firstToken, gap] of [[100, 10], [200, 20], [300, 30], [400, 40], [500, 500]]) {
      call({
        cost_micros: 10, prompt_tokens: 100, cached_tokens: 25, output_tokens: 20, first_token_ms: firstToken, max_gap_ms: gap,
        duration_ms: firstToken + 1000
      });
    }
    call({ status: 'error', failure: 'idle_limit', cost_micros: 10, prompt_tokens: null, output_tokens: null });

    const { promptTypes } = await read();
    const narration = promptTypes.find((row) => row.promptType === 'narration');

    expect(promptTypes.map((row) => row.promptType)).toEqual(['narration', 'summary']);
    expect(narration).toEqual({
      promptType: 'narration', calls: 6, costMicros: 60, avgPromptTokens: 100, avgOutputTokens: 20, cachedShare: 0.25, failed: 1,
      firstTokenP50Ms: 300, tokensPerSecondP50: 20, maxGapP90Ms: 500
    });
  });

  it('gives no speed for a type with no timed call, and no cached share with no prompt tokens', async () => {
    call({ prompt_type: 'help' });

    expect((await read()).promptTypes[0]).toMatchObject({ firstTokenP50Ms: null, tokensPerSecondP50: null, maxGapP90Ms: null, cachedShare: null });
  });

  it('counts how calls ended and why they failed', async () => {
    call();
    call();
    call({ status: 'aborted' });
    call({ status: 'error', failure: 'thinking' });
    call({ status: 'error', failure: 'thinking' });
    call({ status: 'error', failure: 'status_503' });

    const report = await read();

    expect(report.endings).toEqual(expect.arrayContaining([{ status: 'ok', calls: 2 }, { status: 'aborted', calls: 1 }, { status: 'error', calls: 3 }]));
    expect(report.failures).toEqual([{ failure: 'thinking', calls: 2 }, { failure: 'status_503', calls: 1 }]);
    expect(report.totals.failed).toBe(3);
  });

  it('orders the slowest calls by their worst wait and holds no more than five', async () => {
    for (let index = 1; index <= 6; index += 1) {
      call({ first_token_ms: index * 100, max_gap_ms: 10, duration_ms: index * 100 + 1000, output_tokens: 50 });
    }
    call({ prompt_type: 'summary', first_token_ms: 50, max_gap_ms: 9000, duration_ms: 10050, output_tokens: 100 });
    call({ prompt_type: 'help' });

    const { slowest } = await read();

    expect(slowest).toHaveLength(5);
    expect(slowest.map((row) => row.maxGapMs === 9000 ? 'gap' : row.firstTokenMs)).toEqual(['gap', 600, 500, 400, 300]);
    expect(slowest[0]).toMatchObject({ promptType: 'summary', tokensPerSecond: 10, status: 'ok', failure: null });
    expect(Object.keys(slowest[0]).sort()).toEqual(['failure', 'firstTokenMs', 'maxGapMs', 'promptType', 'startedAt', 'status', 'tokensPerSecond']);
  });

  it('counts the entitled per tier once each, with the highest tier winning', async () => {
    const link = (user, tier, patreonUserId) => PatreonLink.link({ userId: user.id, patreonUserId, tier, pledgeStart: null, checkedAt: new Date().toISOString() });
    const both = createUser();
    link(both, 'supporter', 'p-both');
    HostedGrant.create({ userId: both.id, tier: 'supporter_plus', endsAt: daysAgo(-5), createdBy: null });
    link(createUser(), 'supporter', 'p-plain');
    const revoked = createUser();
    HostedGrant.revoke(HostedGrant.create({ userId: revoked.id, tier: 'supporter_top', endsAt: daysAgo(-5), createdBy: null }).id);

    const { tiers } = await read();

    expect(tiers.map((row) => [row.tier, row.entitled])).toEqual([['supporter', 1], ['supporter_plus', 1], ['supporter_top', 0]]);
  });

  it('reports each tier and the heaviest accounts against the weekly budget', async () => {
    call({ subject: 's-low', turn_id: 't1', cost_micros: 100_000 });
    call({ subject: 's-high', turn_id: 't2', cost_micros: 400_000 });
    call({ subject: 's-high', turn_id: 't3', cost_micros: 100_000, stopped: 1 });
    call({ subject: 's-plus', turn_id: 't4', tier: 'supporter_plus', cost_micros: 200_000 });

    const report = await read();

    expect(report.tiers[0]).toEqual({ tier: 'supporter', entitled: 0, active: 2, turns: 3, costMicros: 600_000, topBudgetShare: 0.4 });
    expect(report.tiers[1]).toMatchObject({ tier: 'supporter_plus', topBudgetShare: 0.1 });
    expect(report.tiers[2]).toMatchObject({ tier: 'supporter_top', active: 0, topBudgetShare: null });
    expect(report.heaviest).toEqual([
      { tier: 'supporter', turns: 2, costMicros: 500_000, budgetShare: 0.4 },
      { tier: 'supporter_plus', turns: 1, costMicros: 200_000, budgetShare: 0.1 },
      { tier: 'supporter', turns: 1, costMicros: 100_000, budgetShare: 0.1 }
    ]);
  });

  it('measures an account that upgraded mid-week against its latest tier', async () => {
    const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    call({ subject: 's-up', turn_id: 't1', started_at: at(2), cost_micros: 600_000 });
    call({ subject: 's-up', turn_id: 't2', started_at: at(1), tier: 'supporter_plus', cost_micros: 600_000 });

    const report = await read();

    expect(report.heaviest).toEqual([{ tier: 'supporter_plus', turns: 2, costMicros: 1_200_000, budgetShare: 0.6 }]);
    expect(report.tiers.map((row) => [row.tier, row.topBudgetShare])).toEqual([['supporter', null], ['supporter_plus', 0.6], ['supporter_top', null]]);
  });

  it('lists at most five heaviest accounts', async () => {
    for (let index = 0; index < 7; index += 1) call({ subject: `s${index}`, cost_micros: 100 + index });

    expect((await read()).heaviest).toHaveLength(5);
  });

  it('sums the offer steps inside the range and lists every step', async () => {
    db.prepare('INSERT INTO funnel_totals (day, step, count) VALUES (?, ?, ?)').run(dayOf(daysAgo(0)), 'offer_shown', 4);
    db.prepare('INSERT INTO funnel_totals (day, step, count) VALUES (?, ?, ?)').run(dayOf(daysAgo(1)), 'offer_shown', 3);
    db.prepare('INSERT INTO funnel_totals (day, step, count) VALUES (?, ?, ?)').run(dayOf(daysAgo(5)), 'offer_shown', 50);
    FunnelTotal.increment(dayOf(daysAgo(0)), 'see_levels');
    FunnelTotal.increment(dayOf(daysAgo(0)), 'engine_offer_shown');

    const offer = (await read(2)).offer;
    const counts = Object.fromEntries(offer.map((row) => [row.step, row.count]));

    expect(offer).toHaveLength(22);
    expect(counts).toMatchObject({ offer_shown: 7, engine_offer_shown: 1, see_levels: 1, patreon_click: 0, checklist_finished: 0, setup_offer_shown: 0, locked_patreon_click: 0, notice_see_levels: 0 });
    expect(offer.map((row) => row.step)).toContain('locked_see_levels');
    expect(offer.map((row) => row.step)).not.toContain('locked_offer_shown');
  });

  it('answers an empty range with zeros, not a failure', async () => {
    const report = await read(1);

    expect(report.totals).toMatchObject({ calls: 0, costMicros: 0, cachedShare: null, providerMicros: 0 });
    expect(report.promptTypes).toEqual([]);
    expect(report.slowest).toEqual([]);
    expect(report.heaviest).toEqual([]);
  });

  it('counts the heaviest accounts and tiers from the week start, while the range totals keep the days before it', async () => {
    // Wednesday; the week began Monday 2026-11-09.
    at('2026-11-11T12:00:00.000Z');
    call({ subject: 's-a', turn_id: 'old-1', started_at: '2026-11-08T12:00:00.000Z', cost_micros: 900_000 });
    call({ subject: 's-a', turn_id: 'old-2', started_at: '2026-11-08T13:00:00.000Z', cost_micros: 900_000 });
    call({ subject: 's-a', turn_id: 'new-1', started_at: '2026-11-09T00:00:00.000Z', cost_micros: 100_000 });
    call({ subject: 's-b', turn_id: 'new-2', started_at: '2026-11-10T00:00:00.000Z', cost_micros: 300_000 });

    const report = await read(7);

    expect(report.week).toEqual({ since: '2026-11-09T00:00:00.000Z', resetAt: '2026-11-16T00:00:00.000Z' });
    expect(report.totals).toMatchObject({ turns: 4, costMicros: 2_200_000 });
    expect(report.heaviest).toEqual([
      { tier: 'supporter', turns: 1, costMicros: 300_000, budgetShare: 0.3 },
      { tier: 'supporter', turns: 1, costMicros: 100_000, budgetShare: 0.1 }
    ]);
    expect(report.tiers[0]).toMatchObject({ tier: 'supporter', active: 2, turns: 2, costMicros: 400_000, topBudgetShare: 0.3 });
  });

  it('counts installs per day in the range', async () => {
    at('2026-11-11T12:00:00.000Z');
    install('2026-11-10', 'h1');
    install('2026-11-10', 'h2', 'web');
    install('2026-11-11', 'h1');

    const { days } = await read(2);

    expect(days.map((day) => [day.day, day.installs])).toEqual([['2026-11-10', 2], ['2026-11-11', 1]]);
  });

  it('gives no install count before the first counted day, and zero for an empty day after it', async () => {
    at('2026-11-11T12:00:00.000Z');
    install('2026-11-09', 'h1');
    install('2026-11-11', 'h1');

    const { days } = await read(4);

    expect(days.map((day) => [day.day, day.installs])).toEqual([
      ['2026-11-08', null], ['2026-11-09', 1], ['2026-11-10', 0], ['2026-11-11', 1]
    ]);
  });

  it('starts install counts at a closed day when the first counted month has closed', async () => {
    at('2026-11-02T12:00:00.000Z');
    db.prepare("INSERT INTO active_install_totals (kind, period, platform, version, count) VALUES ('day', '2026-10-31', 'web', '3.6.2', 4)").run();

    const { days } = await read(4);

    expect(days.map((day) => [day.day, day.installs])).toEqual([
      ['2026-10-30', null], ['2026-10-31', 4], ['2026-11-01', 0], ['2026-11-02', 0]
    ]);
  });

  it('breaks active installs down by platform and version, most this month first', async () => {
    at('2026-11-11T12:00:00.000Z');
    install('2026-10-31', 'old', 'linux');
    install('2026-11-09', 'h1');
    install('2026-11-10', 'h1');
    install('2026-11-10', 'h2', 'web');
    install('2026-11-10', 'h3', 'web');
    install('2026-11-11', 'h2', 'web');

    const { activeUsers } = await read(7);

    expect(activeUsers.builds).toEqual([
      { platform: 'web', version: '3.6.2', today: 1, yesterday: 2, month: 2 },
      { platform: 'windows', version: '3.6.2', today: 0, yesterday: 1, month: 1 }
    ]);
  });

  it('reports daily and monthly active installs and accounts for the calendar month', async () => {
    at('2026-11-11T12:00:00.000Z');
    // Last month: out of the month figure and the mean.
    install('2026-10-31', 'old');
    call({ subject: 's-old', turn_id: 'o', started_at: '2026-10-31T12:00:00.000Z' });
    // Counting starts on the 8th, so the mean covers the 8th to the 10th.
    install('2026-11-08', 'h1');
    install('2026-11-08', 'h2');
    install('2026-11-10', 'h1');
    install('2026-11-10', 'h2');
    install('2026-11-10', 'h3');
    install('2026-11-11', 'h1');
    call({ subject: 's-a', turn_id: 'a1', started_at: '2026-11-09T12:00:00.000Z' });
    call({ subject: 's-a', turn_id: 'a2', started_at: '2026-11-10T12:00:00.000Z' });
    call({ subject: 's-b', turn_id: 'b1', started_at: '2026-11-10T13:00:00.000Z' });
    call({ subject: 's-a', turn_id: 'a3', started_at: '2026-11-11T01:00:00.000Z' });

    const { activeUsers } = await read(7);

    expect(activeUsers).toMatchObject({
      installs: { today: 1, yesterday: 3, month: 3, averageDay: 5 / 3 },
      accounts: { today: 1, yesterday: 2, month: 2, averageDay: 3 / 2 }
    });
  });

  it('gives yesterday from last month on the first, and no mean with no full day counted', async () => {
    at('2026-12-01T06:00:00.000Z');
    install('2026-11-30', 'h1');
    install('2026-12-01', 'h1');

    const { activeUsers } = await read(1);

    expect(activeUsers.installs).toEqual({ today: 1, yesterday: 1, month: 1, averageDay: null });
    expect(activeUsers.accounts).toEqual({ today: 0, yesterday: 0, month: 0, averageDay: null });
  });
});
