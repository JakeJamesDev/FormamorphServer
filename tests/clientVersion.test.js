import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { parseClientHeader, compareVersions } = require('../src/config/clientVersion');
const { CLIENT_MINIMUMS } = require('../src/config/settings');
const Setting = require('../src/models/Setting');

/**
 * The per-route minimum client version.
 *
 * A feature can need a client the room does not all have yet: a moderation screen that reads a field an
 * old build never sends, say. Raising a minimum on that one route refuses those callers with a code every
 * client turns into the same dialog, and leaves everything else — playing, browsing, saving — alone.
 *
 * Empty by default, so a server nobody has configured behaves exactly as it did before this existed.
 */

const rnd = () => Math.random().toString(36).slice(2, 8);
const mod = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });
const player = () => createUser({ username: `player-${rnd()}` });

/** Seed the map straight in, the way a test seeds likes: the settings route has tests of its own below. */
const gate = (minimums) => Setting.set(CLIENT_MINIMUMS, minimums);

/** A request carrying the build a client would send, or none at all when `client` is null. */
const as = (req, client) => (client ? req.set('X-Formamorph-Client', client) : req);

const REPORTING = { minVersion: '2.17.0', feature: 'Reporting' };

describe('the client identity header', () => {
  it('reads the version and the platform a client sends', () => {
    expect(parseClientHeader('2.17.0 android')).toEqual({ version: '2.17.0', platform: 'android' });
    expect(parseClientHeader('2.16.1-beta.2 web')).toEqual({ version: '2.16.1-beta.2', platform: 'web' });
  });

  it('treats a missing or malformed header as version zero on an unknown platform', () => {
    // Version zero is below every minimum, which is what makes a build too old to send the header at all
    // get the same reply as a build too old for the feature.
    for (const value of [undefined, '', '   ', '2.17.0', 'android', 'nonsense', '2.17.0 web extra']) {
      expect(parseClientHeader(value)).toEqual({ version: '0.0.0', platform: 'unknown' });
    }
  });

  it('keeps the version when only the platform is unrecognized', () => {
    // A platform added later must not read as version zero: that would gate every one of its builds out
    // of a feature until this server learned the word.
    expect(parseClientHeader('2.17.0 ios')).toEqual({ version: '2.17.0', platform: 'unknown' });
  });

  it('orders versions by number, and a release above its own prerelease', () => {
    expect(compareVersions('2.17.0', '2.16.9')).toBe(1);
    expect(compareVersions('2.9.0', '2.10.0')).toBe(-1);
    expect(compareVersions('2.17', '2.17.0')).toBe(0);
    expect(compareVersions('2.17.0-beta.1', '2.17.0')).toBe(-1);
    expect(compareVersions('0.0.0', '1.0.0')).toBe(-1);
    // Semver counts the identifiers, so beta.9 is below beta.10. Comparing the strings puts it above.
    expect(compareVersions('2.17.0-beta.9', '2.17.0-beta.10')).toBe(-1);
    expect(compareVersions('2.17.0-beta', '2.17.0-beta.1')).toBe(-1);
    expect(compareVersions('2.17.0-alpha', '2.17.0-beta')).toBe(-1);
  });
});

describe('a route with a minimum', () => {
  beforeEach(() => gate({ 'POST /api/reports': REPORTING }));

  it('refuses an older client with the code, the version and the feature', async () => {
    const res = await as(request(app).post('/api/reports'), '2.16.0 android')
      .set(authHeader(player()))
      .send({ category: 'other' });

    expect(res.status).toBe(426);
    expect(res.body).toMatchObject({
      code: 'CLIENT_UPDATE_REQUIRED',
      minVersion: '2.17.0',
      feature: 'Reporting'
    });
  });

  it('refuses a client that sends no header at all', async () => {
    const res = await request(app).post('/api/reports').set(authHeader(player())).send({ category: 'other' });

    expect(res.status).toBe(426);
    expect(res.body.code).toBe('CLIENT_UPDATE_REQUIRED');
  });

  it('lets a client on the minimum or newer through to the route', async () => {
    // The report carries no target, so the route refuses it for its own reasons. Pinning that 400 rather
    // than "not 426" is what makes the case fail if the gate ever answers with the wrong status.
    for (const version of ['2.17.0', '2.18.3']) {
      const res = await as(request(app).post('/api/reports'), `${version} android`)
        .set(authHeader(player()))
        .send({ category: 'other' });

      expect(res.status, version).toBe(400);
    }
  });

  it('covers the paths under it, so one entry gates a whole feature', async () => {
    const res = await as(request(app).post('/api/reports/abc/resolve'), '2.16.0 web')
      .set(authHeader(mod()))
      .send({});

    expect(res.status).toBe(426);
  });

  it('stops at a path boundary, so a longer name is not a path under it', async () => {
    // `/api/reportsomething` is not inside `/api/reports`, and a prefix match that forgot the separator
    // would gate it. Nothing routes there, so a 426 could only come from the gate.
    const res = await as(request(app).post('/api/reportsomething'), '2.16.0 web').send({});

    expect(res.status).toBe(404);
  });

  it('takes the longer entry where two cover one path', async () => {
    // One minimum over a feature, a higher one over the endpoint inside it that needs a newer build.
    gate({
      'POST /api/reports': REPORTING,
      'POST /api/reports/abc/resolve': { minVersion: '2.20.0', feature: 'Resolving a report' }
    });

    const covered = await as(request(app).post('/api/reports'), '2.18.0 web')
      .set(authHeader(player()))
      .send({ category: 'other' });
    const inner = await as(request(app).post('/api/reports/abc/resolve'), '2.18.0 web')
      .set(authHeader(mod()))
      .send({});

    expect(covered.status).toBe(400);
    expect(inner.status).toBe(426);
    expect(inner.body).toMatchObject({ minVersion: '2.20.0', feature: 'Resolving a report' });
  });

  it('leaves the same path under another method alone', async () => {
    const res = await as(request(app).get('/api/reports'), '2.16.0 web').set(authHeader(mod()));

    expect(res.status).toBe(200);
  });

  it('gates a HEAD by the minimum on the GET it is answered from', async () => {
    // Express serves HEAD out of the GET handler. Matching the method as sent would let anyone read a
    // gated catalog by asking for it with HEAD instead.
    gate({ 'GET /api/worlds': REPORTING });

    const stale = await as(request(app).head('/api/worlds'), '2.16.0 web');
    const current = await as(request(app).head('/api/worlds'), '2.17.0 web');

    expect(stale.status).toBe(426);
    expect(current.status).toBe(200);
  });

  it('never gates the settings routes, whatever the map says', async () => {
    // The lever cannot sit behind the gate. Staff who gated it — by naming it, or by naming a path above
    // it — would need a hand-edited database to get back, because no client could send the request that
    // lowers it.
    gate({
      'PUT /api': { minVersion: '9.0.0', feature: 'Nothing anyone runs' },
      'GET /api/settings': { minVersion: '9.0.0', feature: 'Nothing anyone runs' }
    });
    const staffer = mod();

    const read = await as(request(app).get(`/api/settings/${CLIENT_MINIMUMS}`), '2.16.0 web')
      .set(authHeader(staffer));
    const lowered = await as(request(app).put(`/api/settings/${CLIENT_MINIMUMS}`), '2.16.0 web')
      .set(authHeader(staffer))
      .send({ value: {} });

    expect(read.status).toBe(200);
    expect(lowered.status).toBe(200);
  });

  it('leaves every route without an entry alone', async () => {
    const catalog = await as(request(app).get('/api/worlds'), '1.0.0 web');
    const root = await as(request(app).get('/'), '1.0.0 windows');

    expect(catalog.status).toBe(200);
    expect(root.status).toBe(200);
  });
});

describe('with no minimum set', () => {
  it('lets the oldest client there is reach a route that would otherwise be gated', async () => {
    const res = await request(app).post('/api/reports').set(authHeader(player())).send({ category: 'other' });

    expect(res.status).toBe(400);
  });

  it('keeps serving when the settings table is missing, rather than refusing every request', async () => {
    // `server.js` starts after a failed migration on purpose, so an operator has a running server to
    // diagnose from. This is read on every request, so a throw here would turn that into a total outage.
    db.exec('DROP TABLE settings');

    try {
      const res = await request(app).get('/api/worlds');

      expect(res.status).toBe(200);
    } finally {
      migrate(db);
    }
  });
});

describe('the request line', () => {
  /** Morgan writes to stdout, which is where an operator reads it from the journal. */
  const logOf = async (send) => {
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      lines.push(String(chunk));

      return write(chunk, ...rest);
    };

    try {
      await send();
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      process.stdout.write = write;
    }

    return lines.join('');
  };

  it('names the platform and the version, so staff can count what the room runs', async () => {
    const logged = await logOf(() => as(request(app).get('/'), '2.17.0 android'));

    expect(logged).toContain('android/2.17.0');
  });

  it('names a client that sent no header as unknown on version zero', async () => {
    const logged = await logOf(() => request(app).get('/'));

    expect(logged).toContain('unknown/0.0.0');
  });
});

describe('the minimums setting', () => {
  const read = (who) => request(app).get(`/api/settings/${CLIENT_MINIMUMS}`).set(authHeader(who));
  const write = (who, value) =>
    request(app).put(`/api/settings/${CLIENT_MINIMUMS}`).set(authHeader(who)).send({ value });

  it('is empty until staff write one', async () => {
    const res = await read(mod());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });

  it('takes effect on the next request once staff save it', async () => {
    const saved = await write(mod(), { 'POST /api/reports': REPORTING });
    expect(saved.status).toBe(200);

    const refused = await as(request(app).post('/api/reports'), '2.16.0 android')
      .set(authHeader(player()))
      .send({ category: 'other' });

    expect(refused.status).toBe(426);
    expect((await read(mod())).body.data).toEqual({ 'POST /api/reports': REPORTING });
  });

  it('is not readable or writable by an ordinary account', async () => {
    const someone = player();

    expect((await read(someone)).status).toBe(403);
    expect((await write(someone, {})).status).toBe(403);
  });

  it('refuses a map staff could not have meant', async () => {
    const rejected = [
      [],
      { '/api/reports': REPORTING },
      { 'POST /api/reports': { minVersion: 'soon', feature: 'Reporting' } },
      { 'POST /api/reports': { minVersion: '2.17.0' } },
      { 'POST /api/reports': { minVersion: '2.17.0', feature: '  ' } }
    ];

    for (const value of rejected) {
      const res = await write(mod(), value);
      expect(res.status, JSON.stringify(value)).toBe(400);
    }

    // and the map is still what it was
    expect((await read(mod())).body.data).toEqual({});
  });

  it('does not answer for a key it has never heard of', async () => {
    const res = await request(app).get('/api/settings/whatever').set(authHeader(mod()));

    expect(res.status).toBe(404);
  });
});
