import { describe, it, expect, beforeEach } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader, fromAddress, fromItsOwnAddress } from './helpers.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { FUNNEL_STEPS, FUNNEL_LIMIT } = require('../src/config/funnel');

const today = () => new Date().toISOString().slice(0, 10);
const send = (step) => fromItsOwnAddress(request(app).post(`/api/funnel/${step}`));

beforeEach(() => {
  db.prepare('DELETE FROM funnel_totals').run();
});

describe('POST /api/funnel/:step', () => {
  it('adds one to today\'s total for each known step', async () => {
    for (const step of FUNNEL_STEPS) {
      expect((await send(step)).status).toBe(204);
    }
    expect((await send('see_levels')).status).toBe(204);

    const rows = db.prepare('SELECT day, step, count FROM funnel_totals ORDER BY step').all();
    expect(rows).toHaveLength(FUNNEL_STEPS.length);
    expect(rows.find((row) => row.step === 'see_levels')).toEqual({ day: today(), step: 'see_levels', count: 2 });
    expect(rows.filter((row) => row.step !== 'see_levels').every((row) => row.count === 1)).toBe(true);
  });

  it('accepts and counts every valid source and step pair', async () => {
    const pairs = [
      'setup_offer_shown', 'setup_see_levels', 'setup_patreon_click', 'setup_checklist_finished',
      'demo_offer_shown', 'demo_see_levels', 'demo_patreon_click', 'demo_checklist_finished',
      'engine_offer_shown', 'engine_see_levels', 'engine_patreon_click', 'engine_checklist_finished',
      'notice_see_levels', 'notice_patreon_click', 'notice_checklist_finished',
      'locked_see_levels', 'locked_patreon_click', 'locked_checklist_finished'
    ];
    for (const step of pairs) expect((await send(step)).status).toBe(204);

    const stored = db.prepare('SELECT step, count FROM funnel_totals ORDER BY step').all();
    expect(stored).toEqual(pairs.slice().sort().map((step) => ({ step, count: 1 })));
  });

  it('still accepts the sourceless names v3.6.2 clients send', async () => {
    for (const step of ['offer_shown', 'see_levels', 'patreon_click', 'checklist_finished']) {
      expect((await send(step)).status).toBe(204);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM funnel_totals').get().n).toBe(4);
  });

  it('refuses a pair the spec leaves out and stores nothing', async () => {
    for (const step of ['locked_offer_shown', 'notice_offer_shown', 'other_see_levels']) {
      expect((await send(step)).status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM funnel_totals').get().n).toBe(0);
  });

  it('refuses the retired local_offer_shown name and stores nothing', async () => {
    const res = await send('local_offer_shown');

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM funnel_totals').get().n).toBe(0);
  });

  it('refuses an unknown step and stores nothing', async () => {
    const res = await send('purchase');

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM funnel_totals').get().n).toBe(0);
  });

  it('counts a step sent to the doubled address 3.6.0 builds call', async () => {
    const res = await fromItsOwnAddress(request(app).post('/api/api/funnel/offer_shown'));

    expect(res.status).toBe(204);
    expect(db.prepare('SELECT day, step, count FROM funnel_totals').all()).toEqual([
      { day: today(), step: 'offer_shown', count: 1 }
    ]);
  });

  it('stores only the step, the day and the count, whoever sends it', async () => {
    const user = createUser();
    await fromAddress('198.51.100.9', request(app).post('/api/funnel/offer_shown'))
      .set(authHeader(user))
      .set('X-Formamorph-Install', 'install-abc-123')
      .set('User-Agent', 'FunnelProbe/1.0');

    expect(db.prepare('PRAGMA table_info(funnel_totals)').all().map((c) => c.name).sort()).toEqual(['count', 'day', 'step']);

    const stored = JSON.stringify(db.prepare('SELECT * FROM funnel_totals').all());
    for (const trace of ['198.51.100.9', 'install-abc-123', user.id, user.username, 'FunnelProbe']) {
      expect(stored).not.toContain(trace);
    }
    expect(JSON.parse(stored)).toEqual([{ day: today(), step: 'offer_shown', count: 1 }]);
  });

  it('gives each address a budget of its own and refuses the one past it', async () => {
    const spender = '192.0.2.201';
    const post = () => fromAddress(spender, request(app).post('/api/funnel/offer_shown'));

    const first = await post();
    expect(Number(first.headers['ratelimit-limit'])).toBe(FUNNEL_LIMIT);

    for (let i = 1; i < FUNNEL_LIMIT; i += 1) expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);

    expect((await fromAddress('192.0.2.202', request(app).post('/api/funnel/offer_shown'))).status).toBe(204);
    expect(db.prepare('SELECT count FROM funnel_totals').get().count).toBe(FUNNEL_LIMIT + 1);
  });
});

describe('GET /api/funnel', () => {
  const seed = (day, step, count) => db.prepare('INSERT INTO funnel_totals (day, step, count) VALUES (?, ?, ?)').run(day, step, count);

  it('returns the totals by day, newest first, with every step present', async () => {
    seed('2026-11-01', 'offer_shown', 5);
    seed('2026-11-02', 'offer_shown', 7);
    seed('2026-11-02', 'patreon_click', 2);

    const admin = createUser({ accountType: 'admin' });
    const res = await request(app).get('/api/funnel').set(authHeader(admin));

    expect(res.status).toBe(200);
    const days = res.body.data.days;
    expect(days.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-01']);
    expect(Object.keys(days[0].steps).sort()).toEqual([...FUNNEL_STEPS].sort());
    expect(days[0].steps).toMatchObject({ offer_shown: 7, patreon_click: 2, engine_offer_shown: 0, locked_checklist_finished: 0 });
    expect(days[1].steps).toMatchObject({ offer_shown: 5, patreon_click: 0 });
  });

  it('refuses a guest, a normal account and a moderator', async () => {
    expect((await request(app).get('/api/funnel')).status).toBe(401);
    for (const accountType of ['normal', 'moderator']) {
      const res = await request(app).get('/api/funnel').set(authHeader(createUser({ accountType })));
      expect(res.status).toBe(403);
    }
  });
});
