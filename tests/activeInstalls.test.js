import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, fromAddress, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const { ACTIVE_INSTALLS, ACTIVE_INSTALLS_LIMIT, NO_CLIENT } = require('../src/config/activeInstalls');
const { CODES } = require('../src/config/anonymousLikes');
const Signal = require('../src/models/Signal');
const ActiveInstall = require('../src/models/ActiveInstall');
const { sweepRetention } = require('../src/utils/sweepRetention');

const INSTALL_A = '0b5f6a3e-7c1d-4e2a-9f80-1a2b3c4d5e6f';
const INSTALL_B = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
const INSTALL_C = '11111111-2222-4333-8444-555555555555';

const send = (install = INSTALL_A, client = '3.7.0 windows') => {
  let req = fromItsOwnAddress(request(app).post('/api/active-installs'));
  if (install !== null) req = req.set('X-Formamorph-Install', install);
  if (client !== null) req = req.set('X-Formamorph-Client', client);
  return req;
};

const at = (iso) => vi.setSystemTime(new Date(iso));
const rows = () => db.prepare('SELECT day, platform, version FROM active_install_days ORDER BY day, platform, version').all();
const keyCount = () => db.prepare('SELECT COUNT(*) AS n FROM active_install_keys').get().n;

let adminUser;
const totals = (query = '') => request(app).get(`/api/active-installs${query}`).set(authHeader(adminUser));

beforeEach(() => {
  db.prepare('DELETE FROM active_install_totals').run();
  db.prepare('DELETE FROM active_install_days').run();
  db.prepare('DELETE FROM active_install_keys').run();
  Setting.set(ACTIVE_INSTALLS, true);
  adminUser = createUser({ accountType: 'admin' });
});

afterEach(() => {
  vi.useRealTimers();
  Setting.set(ACTIVE_INSTALLS, false);
});

describe('POST /api/active-installs', () => {
  it('counts a send once, and a repeated send that day still once', async () => {
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(204);

    expect(rows()).toHaveLength(1);
    const today = (await totals('?days=1')).body.data.days[0];
    expect(today.total).toBe(1);
  });

  it('refuses a missing or malformed Install id and stores nothing', async () => {
    for (const install of [null, 'install-abc-123', `${INSTALL_A}x`, '']) {
      const res = await send(install);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CODES.BAD_INSTALL);
    }

    expect(rows()).toEqual([]);
    expect(keyCount()).toBe(0);
  });

  it('refuses a send without a readable client header and stores nothing', async () => {
    for (const client of [null, 'banana windows', '3.7.0', '']) {
      const res = await send(INSTALL_A, client);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(NO_CLIENT.code);
    }

    expect(rows()).toEqual([]);
    expect(keyCount()).toBe(0);
  });

  it('stores a real version from an unrecognized platform as unknown', async () => {
    expect((await send(INSTALL_A, '3.7.0 toaster')).status).toBe(204);

    expect(rows()).toEqual([{ day: expect.any(String), platform: 'unknown', version: '3.7.0' }]);
  });

  it('counts an install that updates during the day under its first version', async () => {
    await send(INSTALL_A, '3.7.0 android');
    await send(INSTALL_A, '3.8.0 android');

    const [today] = (await totals('?days=1')).body.data.days;
    expect(today).toEqual({ day: today.day, total: 1, breakdown: [{ platform: 'android', version: '3.7.0', count: 1 }] });
  });

  it('takes the day from the server clock and ignores any body', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-03-31T23:59:30.000Z');

    await send().send({ day: '2020-01-01', installId: INSTALL_B });

    expect(rows()).toEqual([{ day: '2026-03-31', platform: 'windows', version: '3.7.0' }]);
  });

  it('makes one key on the first send of a month and reuses it after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-03-10T08:00:00.000Z');
    await send(INSTALL_A);
    const [first] = db.prepare('SELECT month, secret FROM active_install_keys').all();
    expect(first.month).toBe('2026-03');

    at('2026-03-20T08:00:00.000Z');
    await send(INSTALL_A);
    await send(INSTALL_B);
    expect(db.prepare('SELECT month, secret FROM active_install_keys').all()).toEqual([first]);

    at('2026-04-01T00:00:01.000Z');
    await send(INSTALL_A);
    expect(db.prepare('SELECT month FROM active_install_keys ORDER BY month').all()).toEqual([{ month: '2026-03' }, { month: '2026-04' }]);

    // One install's hash matches within a month and differs across months.
    const hashesOn = (day) => db.prepare('SELECT hash FROM active_install_days WHERE day = ?').all(day).map((row) => row.hash);
    const [march] = hashesOn('2026-03-10');
    expect(hashesOn('2026-03-20')).toContain(march);
    expect(hashesOn('2026-04-01')).not.toContain(march);
  });

  it('stores no account id, address or raw Install id', async () => {
    const user = createUser();
    await fromAddress('198.51.100.9', request(app).post('/api/active-installs'))
      .set(authHeader(user))
      .set('X-Formamorph-Install', INSTALL_A.toUpperCase())
      .set('X-Formamorph-Client', '3.7.0 web')
      .set('User-Agent', 'ActiveProbe/1.0');

    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
    expect(columns('active_install_days')).toEqual(['day', 'hash', 'platform', 'version']);
    expect(columns('active_install_keys')).toEqual(['month', 'secret']);

    const stored = JSON.stringify([
      db.prepare('SELECT * FROM active_install_days').all(),
      db.prepare('SELECT month, hex(secret) AS secret FROM active_install_keys').all()
    ]).toLowerCase();
    for (const trace of ['198.51.100.9', INSTALL_A, INSTALL_A.replace(/-/g, ''), user.id, user.username, 'activeprobe']) {
      expect(stored).not.toContain(trace.toLowerCase());
    }
    expect(rows()).toHaveLength(1);
  });

  it('answers 204 and stores nothing while the setting is off', async () => {
    Setting.set(ACTIVE_INSTALLS, false);

    expect((await send()).status).toBe(204);

    expect(rows()).toEqual([]);
    expect(keyCount()).toBe(0);
  });

  it('gives each address a daily budget of its own and refuses the one past it', async () => {
    const spender = '192.0.2.211';
    const post = (n) => fromAddress(spender, request(app).post('/api/active-installs'))
      .set('X-Formamorph-Install', `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
      .set('X-Formamorph-Client', '3.7.0 android');

    const first = await post(0);
    expect(Number(first.headers['ratelimit-limit'])).toBe(ACTIVE_INSTALLS_LIMIT);
    expect(Number(first.headers['ratelimit-reset'])).toBeGreaterThan(23 * 60 * 60);

    for (let i = 1; i < ACTIVE_INSTALLS_LIMIT; i += 1) expect((await post(i)).status).toBe(204);
    expect((await post(ACTIVE_INSTALLS_LIMIT)).status).toBe(429);

    expect((await send(INSTALL_B)).status).toBe(204);
    expect(rows()).toHaveLength(ACTIVE_INSTALLS_LIMIT + 1);
  });
});

describe('GET /api/active-installs', () => {
  it('returns DAU per day and MAU per month, newest first, with empty days at zero', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-02-27T10:00:00.000Z');
    await send(INSTALL_A, '3.6.0 windows');
    at('2026-03-01T10:00:00.000Z');
    await send(INSTALL_A, '3.7.0 windows');
    await send(INSTALL_B, '3.7.0 android');
    at('2026-03-02T10:00:00.000Z');
    await send(INSTALL_A, '3.8.0 windows');

    at('2026-03-03T12:00:00.000Z');
    const res = await totals('?days=5');

    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([
      { day: '2026-03-03', total: 0, breakdown: [] },
      { day: '2026-03-02', total: 1, breakdown: [{ platform: 'windows', version: '3.8.0', count: 1 }] },
      {
        day: '2026-03-01',
        total: 2,
        breakdown: [{ platform: 'android', version: '3.7.0', count: 1 }, { platform: 'windows', version: '3.7.0', count: 1 }]
      },
      { day: '2026-02-28', total: 0, breakdown: [] },
      { day: '2026-02-27', total: 1, breakdown: [{ platform: 'windows', version: '3.6.0', count: 1 }] }
    ]);
    expect(res.body.data.months).toEqual([
      {
        month: '2026-03',
        total: 2,
        breakdown: [{ platform: 'android', version: '3.7.0', count: 1 }, { platform: 'windows', version: '3.7.0', count: 1 }]
      },
      { month: '2026-02', total: 1, breakdown: [{ platform: 'windows', version: '3.6.0', count: 1 }] }
    ]);
  });

  it('counts one install on two days as 1 each day and 1 that month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-05-10T10:00:00.000Z');
    await send();
    at('2026-05-11T10:00:00.000Z');
    await send();

    const { days, months } = (await totals('?days=2')).body.data;
    expect(days.map((d) => d.total)).toEqual([1, 1]);
    expect(months.map((m) => [m.month, m.total])).toEqual([['2026-05', 1]]);
  });

  it('sorts a breakdown by count, biggest first', async () => {
    await send(INSTALL_A, '3.7.0 web');
    await send(INSTALL_B, '3.7.0 windows');
    await send(INSTALL_C, '3.7.0 windows');

    const [today] = (await totals('?days=1')).body.data.days;
    expect(today.breakdown).toEqual([
      { platform: 'windows', version: '3.7.0', count: 2 },
      { platform: 'web', version: '3.7.0', count: 1 }
    ]);
  });

  it('covers 14 days by default and refuses a days value out of range', async () => {
    expect((await totals()).body.data.days).toHaveLength(14);
    expect((await totals('?days=366')).body.data.days).toHaveLength(366);
    for (const days of ['0', '367', '2.5', 'many']) {
      expect((await totals(`?days=${days}`)).status).toBe(400);
    }
  });

  it('refuses a guest, a normal account and a moderator', async () => {
    expect((await request(app).get('/api/active-installs')).status).toBe(401);
    for (const accountType of ['normal', 'moderator']) {
      const res = await request(app).get('/api/active-installs').set(authHeader(createUser({ accountType })));
      expect(res.status).toBe(403);
    }
  });

  it('never answers with a hash, a key or an Install id', async () => {
    const sent = [await send(INSTALL_A), await send(INSTALL_B, '3.7.0 mac')];
    const report = await totals('?days=1');

    const stored = [
      ...db.prepare('SELECT hash FROM active_install_days').all().map((row) => row.hash),
      ...db.prepare('SELECT hex(secret) AS secret FROM active_install_keys').all().map((row) => row.secret.toLowerCase())
    ];
    expect(stored).toHaveLength(3);
    for (const res of [...sent, report]) {
      const body = JSON.stringify(res.body).toLowerCase() + JSON.stringify(res.headers).toLowerCase();
      for (const secret of [...stored, INSTALL_A, INSTALL_B]) expect(body).not.toContain(secret);
    }
  });
});

describe('Month Close', () => {
  const closedTotals = () => db.prepare('SELECT kind, period, platform, version, count FROM active_install_totals ORDER BY kind, period, platform, version').all();
  const keyMonths = () => db.prepare('SELECT month FROM active_install_keys ORDER BY month').all().map((row) => row.month);

  /** March: A updates between two days, B sends once. April: A sends on its first day. */
  const sendMarchAndApril = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-03-30T10:00:00.000Z');
    await send(INSTALL_A, '3.6.0 windows');
    at('2026-03-31T10:00:00.000Z');
    await send(INSTALL_A, '3.7.0 android');
    await send(INSTALL_B, '3.7.0 android');
    at('2026-04-01T00:30:00.000Z');
    await send(INSTALL_A, '3.7.0 android');
  };

  const MARCH_TOTALS = [
    { kind: 'day', period: '2026-03-30', platform: 'windows', version: '3.6.0', count: 1 },
    { kind: 'day', period: '2026-03-31', platform: 'android', version: '3.7.0', count: 2 },
    { kind: 'month', period: '2026-03', platform: 'android', version: '3.7.0', count: 1 },
    { kind: 'month', period: '2026-03', platform: 'windows', version: '3.6.0', count: 1 }
  ];

  afterEach(() => vi.restoreAllMocks());

  it('closes a past month into totals and deletes its rows and key', async () => {
    await sendMarchAndApril();

    expect(sweepRetention('2026-04-01T01:00:00.000Z').months).toBe(1);

    expect(closedTotals()).toEqual(MARCH_TOTALS);
    expect(rows()).toEqual([{ day: '2026-04-01', platform: 'android', version: '3.7.0' }]);
    expect(keyMonths()).toEqual(['2026-04']);
  });

  it('shows the admin the same numbers before and after the close', async () => {
    await sendMarchAndApril();
    at('2026-04-01T01:00:00.000Z');
    const before = (await totals('?days=3')).body.data;
    expect(before.months.map((m) => [m.month, m.total])).toEqual([['2026-04', 1], ['2026-03', 2]]);

    sweepRetention('2026-04-01T01:00:00.000Z');

    expect(rows()).toHaveLength(1);
    expect((await totals('?days=3')).body.data).toEqual(before);
  });

  it('writes the totals once when it runs twice, and never closes a closed month again', async () => {
    await sendMarchAndApril();
    sweepRetention('2026-04-01T01:00:00.000Z');

    expect(sweepRetention('2026-04-01T02:00:00.000Z').months).toBe(0);
    expect(closedTotals()).toEqual(MARCH_TOTALS);

    // A clock that ran back stores a row and a key in the closed month.
    at('2026-03-15T10:00:00.000Z');
    await send(INSTALL_C, '3.7.0 web');
    expect(keyMonths()).toEqual(['2026-03', '2026-04']);

    expect(sweepRetention('2026-04-01T03:00:00.000Z').months).toBe(0);
    expect(closedTotals()).toEqual(MARCH_TOTALS);
    expect(rows()).toEqual([{ day: '2026-04-01', platform: 'android', version: '3.7.0' }]);
    expect(keyMonths()).toEqual(['2026-04']);
  });

  it('produces the same totals when it runs days late', async () => {
    await sendMarchAndApril();
    at('2026-04-05T10:00:00.000Z');
    await send(INSTALL_B, '3.8.0 android');

    expect(sweepRetention('2026-04-09T12:00:00.000Z').months).toBe(1);

    expect(closedTotals()).toEqual(MARCH_TOTALS);
    expect(rows().map((row) => row.day)).toEqual(['2026-04-01', '2026-04-05']);
  });

  it('deletes a past month key that has no rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-04-02T10:00:00.000Z');
    await send();
    // No route leaves a key without rows; a direct insert stands in for one.
    db.prepare("INSERT INTO active_install_keys (month, secret) VALUES ('2026-02', randomblob(32))").run();

    expect(sweepRetention('2026-04-02T11:00:00.000Z').months).toBe(0);

    expect(keyMonths()).toEqual(['2026-04']);
    expect(rows()).toHaveLength(1);
  });

  it('leaves the current month live', async () => {
    await sendMarchAndApril();

    expect(sweepRetention('2026-03-31T23:59:59.000Z').months).toBe(0);

    expect(closedTotals()).toEqual([]);
    expect(rows()).toHaveLength(4);
    expect(keyMonths()).toEqual(['2026-03', '2026-04']);
  });

  it('closes even when the sweep cannot read its deadline', async () => {
    await sendMarchAndApril();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Signal, 'cutoff').mockImplementation(() => { throw new Error('no clock'); });

    expect(sweepRetention('2026-04-01T01:00:00.000Z')).toEqual({ signals: 0, marks: 0, kinds: 0, months: 1, mails: 0 });
    expect(closedTotals()).toEqual(MARCH_TOTALS);
  });

  it('keeps the rest of the sweep running when the close throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cutoff = vi.spyOn(Signal, 'cutoff');
    vi.spyOn(ActiveInstall, 'closeMonthsBefore').mockImplementation(() => { throw new Error('locked'); });

    expect(sweepRetention('2026-04-01T01:00:00.000Z').months).toBe(0);
    expect(cutoff).toHaveBeenCalled();
  });

  it('refuses a second total for one period, platform and version', () => {
    const insert = db.prepare("INSERT INTO active_install_totals (kind, period, platform, version, count) VALUES ('day', '2026-01-01', 'web', '3.7.0', 1)");
    insert.run();

    expect(() => insert.run()).toThrow(/UNIQUE/);
  });
});
