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
    expect(rows).toEqual([
      { day: today(), step: 'checklist_finished', count: 1 },
      { day: today(), step: 'engine_offer_shown', count: 1 },
      { day: today(), step: 'offer_shown', count: 1 },
      { day: today(), step: 'patreon_click', count: 1 },
      { day: today(), step: 'see_levels', count: 2 }
    ]);
  });

  it('counts the built-in engine card step', async () => {
    expect((await send('engine_offer_shown')).status).toBe(204);
    expect(db.prepare('SELECT day, step, count FROM funnel_totals').all()).toEqual([
      { day: today(), step: 'engine_offer_shown', count: 1 }
    ]);
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
    expect(res.body.data.days).toEqual([
      { day: '2026-11-02', steps: { offer_shown: 7, engine_offer_shown: 0, see_levels: 0, patreon_click: 2, checklist_finished: 0 } },
      { day: '2026-11-01', steps: { offer_shown: 5, engine_offer_shown: 0, see_levels: 0, patreon_click: 0, checklist_finished: 0 } }
    ]);
  });

  it('refuses a guest, a normal account and a moderator', async () => {
    expect((await request(app).get('/api/funnel')).status).toBe(401);
    for (const accountType of ['normal', 'moderator']) {
      const res = await request(app).get('/api/funnel').set(authHeader(createUser({ accountType })));
      expect(res.status).toBe(403);
    }
  });
});
