import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { browserFamily } = require('../src/utils/browserFamily');
const { sweepSignals } = require('../src/utils/sweepSignals');
const { DAY_MS } = require('../src/config/time');
const deleteUser = require('../src/utils/deleteUser');

/**
 * Signals — the record that lets staff see four accounts arrive from one place.
 *
 * A ring of accounts has to repeat itself somewhere: it signs up, signs in, and then likes, publishes,
 * comments or follows. Each of those writes one row holding a salted hash of the address it came from and a
 * coarse browser family, and the rows expire after ninety days. Nothing acts on them — a shared household
 * is not an offense, and every consequence stays a person's decision.
 *
 * What has to be true: the six moments are recorded, the address is not readable back out of the record,
 * recording never costs the user the thing they did, and the ninety days are real.
 */

/**
 * Read an account's Signals.
 *
 * A test-only read of the table. The staff linked-accounts endpoint is a later ticket; when it lands this
 * becomes a request to it, because that is what a staff member actually observes.
 */
const signalsFor = (user) =>
  db.prepare('SELECT * FROM signals WHERE user_id = ? ORDER BY id').all(user.id);

/** Every request in a test carries an address, so a test can put two accounts in one place or two places. */
const from = (address, req) => req.set('CF-Connecting-IP', address);

const register = (username, address = '203.0.113.10') =>
  from(address, request(app).post('/api/auth/register')).send({ username, password: 'password123' });

const login = (user, address = '203.0.113.10') =>
  from(address, request(app).post('/api/auth/login')).send({ username: user.username, password: user.password });

const publish = (user, address = '203.0.113.10', over = {}) =>
  from(address, request(app).post('/api/worlds').set(authHeader(user))).send(worldPayload(over));

const update = (user, id, address = '203.0.113.10', over = {}) =>
  from(address, request(app).put(`/api/worlds/${id}`).set(authHeader(user))).send(worldPayload(over));

const like = (user, id, liked = true, address = '203.0.113.10') =>
  from(address, request(app).put(`/api/worlds/${id}/like`).set(authHeader(user))).send({ liked });

const comment = (user, id, address = '203.0.113.10') =>
  from(address, request(app).post(`/api/worlds/${id}/comments`).set(authHeader(user))).send({ content: 'Lovely work' });

const follow = (user, targetId, address = '203.0.113.10') =>
  from(address, request(app).put(`/api/users/${targetId}/follow`).set(authHeader(user))).send();

/** An author with one published listing, and somebody else to act on it. */
const seed = async () => {
  const author = createUser({ username: 'signal-author' });
  const reader = createUser({ username: 'signal-reader' });
  const id = (await publish(author)).body.data.id;

  db.prepare('DELETE FROM signals').run();

  return { author, reader, id };
};

/** Put a row this many days behind a reference instant, without waiting for the days. */
const age = (user, days, now) => {
  const at = new Date(new Date(now).getTime() - days * DAY_MS).toISOString();
  db.prepare(`
    INSERT INTO signals (user_id, event, address_hash, browser_family, created_at)
    VALUES (?, 'login', 'a-hash', 'Other/Other', ?)
  `).run(user.id, at);
};

describe('reading a user agent as a browser family', () => {
  // Real strings, because the point of the table is the lies they tell by inheritance: Edge, Opera and
  // Samsung all claim `Chrome/`, Chrome claims `Safari/`, Android claims `Linux`, and an iPad claims
  // `Mac OS X`. Each of those is one of these rows.
  const AGENTS = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Chrome/Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Chrome/macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0', 'Firefox/Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0', 'Firefox/Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15', 'Safari/macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1', 'Safari/iOS'],
    ['Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'Safari/iOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome/iOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', 'Chrome/Android'],
    ['Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0', 'Firefox/Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0', 'Edge/Windows'],
    ['Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0', 'Edge/Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0', 'Opera/Windows'],
    ['Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36', 'Samsung/Android']
  ];

  for (const [agent, family] of AGENTS) {
    it(`reads ${family}`, () => {
      expect(browserFamily(agent)).toBe(family);
    });
  }

  it('says Other/Other for something that is not a browser', () => {
    expect(browserFamily('curl/8.6.0')).toBe('Other/Other');
  });

  it('says Other/Other when nothing sent a user agent at all', () => {
    expect(browserFamily(undefined)).toBe('Other/Other');
  });

  it('answers a browser on a platform it does not know', () => {
    // A console browser. Half an answer beats none: the browser half still tells two people apart.
    expect(browserFamily('Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15'))
      .toBe('Safari/Other');
  });
});

describe('recording a Signal', () => {
  it('records the signup, so accounts made minutes apart are linkable from the start', async () => {
    const res = await register('fresh-signer');

    expect(res.status).toBe(201);
    expect(signalsFor(res.body.user).map((row) => row.event)).toEqual(['signup']);
  });

  it('records the login', async () => {
    const user = createUser({ username: 'returning' });

    const res = await login(user);

    expect(res.status).toBe(200);
    expect(signalsFor(user).map((row) => row.event)).toEqual(['login']);
  });

  it('records the publish', async () => {
    const author = createUser({ username: 'publisher' });

    const res = await publish(author);

    expect(res.status).toBe(201);
    expect(signalsFor(author).map((row) => row.event)).toEqual(['publish']);
  });

  it('records an edit as a publish too', async () => {
    const { author, id } = await seed();

    const res = await update(author, id);

    expect(res.status).toBe(200);
    expect(signalsFor(author).map((row) => row.event)).toEqual(['publish']);
  });

  it('records the like — the event a vote ring cannot avoid', async () => {
    const { reader, id } = await seed();

    const res = await like(reader, id);

    expect(res.status).toBe(200);
    expect(signalsFor(reader).map((row) => row.event)).toEqual(['like']);
  });

  it('records the comment', async () => {
    const { reader, id } = await seed();

    const res = await comment(reader, id);

    expect(res.status).toBe(201);
    expect(signalsFor(reader).map((row) => row.event)).toEqual(['comment']);
  });

  it('records the follow', async () => {
    const { author, reader } = await seed();

    const res = await follow(reader, author.id);

    expect(res.status).toBe(200);
    expect(signalsFor(reader).map((row) => row.event)).toEqual(['follow']);
  });

  it('records it against the account that acted, not the one acted on', async () => {
    const { author, reader, id } = await seed();

    await like(reader, id);

    expect(signalsFor(author)).toEqual([]);
    expect(signalsFor(reader)).toHaveLength(1);
  });

  it('stores the browser family the request arrived with', async () => {
    const user = createUser({ username: 'on-a-phone' });

    await from('203.0.113.10', request(app).post('/api/auth/login'))
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1')
      .send({ username: user.username, password: user.password });

    expect(signalsFor(user)[0].browser_family).toBe('Safari/iOS');
  });
});

describe('what a Signal stores about an address', () => {
  it('links two accounts that acted from one address', async () => {
    // The whole point: staff can see that two accounts came from one place.
    const one = createUser({ username: 'ring-one' });
    const two = createUser({ username: 'ring-two' });

    await login(one, '198.51.100.7');
    await login(two, '198.51.100.7');

    expect(signalsFor(one)[0].address_hash).toBe(signalsFor(two)[0].address_hash);
  });

  it('does not link two accounts that acted from different addresses', async () => {
    const one = createUser({ username: 'here' });
    const two = createUser({ username: 'elsewhere' });

    await login(one, '198.51.100.7');
    await login(two, '203.0.113.99');

    expect(signalsFor(one)[0].address_hash).not.toBe(signalsFor(two)[0].address_hash);
  });

  it('keeps no readable trace of the address itself', async () => {
    const user = createUser({ username: 'private' });

    await login(user, '198.51.100.7');

    const [row] = signalsFor(user);
    expect(row.address_hash).not.toContain('198.51.100');
    expect(JSON.stringify(row)).not.toContain('198.51.100');
  });

  it('is salted, so rotating the salt unlinks every row that came before', async () => {
    // The emergency lever. Without the salt in the hash, the same address would hash the same on any
    // server anywhere, and a rainbow table would read the addresses straight back out of a leaked table.
    const before = createUser({ username: 'before-rotation' });
    const after = createUser({ username: 'after-rotation' });
    const salt = process.env.SIGNAL_SALT;

    await login(before, '198.51.100.7');
    process.env.SIGNAL_SALT = 'a-rotated-salt';
    try {
      await login(after, '198.51.100.7');
    } finally {
      process.env.SIGNAL_SALT = salt;
    }

    expect(signalsFor(after)[0].address_hash).not.toBe(signalsFor(before)[0].address_hash);
  });

  it('reads the address the rate limiter reads, so the tunnel is handled once', async () => {
    // Every external request reaches this origin from loopback, so `req.ip` is the same for everybody.
    // A Signal that keyed on it would put the whole server in one place and link nobody to anybody.
    const one = createUser({ username: 'tunnelled-one' });
    const two = createUser({ username: 'tunnelled-two' });

    await login(one, '198.51.100.7');
    await request(app).post('/api/auth/login').send({ username: two.username, password: two.password });

    expect(signalsFor(two)[0].address_hash).not.toBe(signalsFor(one)[0].address_hash);
  });
});

describe('when a Signal cannot be written', () => {
  afterEach(() => {
    // Put the table back however the test left it, so a failure here cannot cascade into the next file.
    const missing = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='signals_hidden'")
      .get().count;
    if (missing) db.exec('DROP TABLE IF EXISTS signals; ALTER TABLE signals_hidden RENAME TO signals');
  });

  /** Take the table out from under the recorder, the way a broken database would. */
  const breakTheTable = () => db.exec('ALTER TABLE signals RENAME TO signals_hidden');

  it('still gives the user the thing they did', async () => {
    // The like has already happened by the time the Signal is written. Failing the request would turn a
    // completed action into an error the client retries, which is worse than a gap in the record.
    const { reader, id } = await seed();
    breakTheTable();

    const res = await like(reader, id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });

  it('still creates the account', async () => {
    breakTheTable();

    const res = await register('unrecorded');

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('unrecorded');
  });

  it('still signs the user in', async () => {
    const { reader } = await seed();
    breakTheTable();

    const res = await login(reader);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('still publishes the listing', async () => {
    const { author } = await seed();
    breakTheTable();

    const res = await publish(author);

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
  });

  it('still posts the comment', async () => {
    const { reader, id } = await seed();
    breakTheTable();

    const res = await comment(reader, id);

    expect(res.status).toBe(201);
    expect(res.body.data.content).toBe('Lovely work');
  });

  it('still follows the account', async () => {
    const { reader, author } = await seed();
    breakTheTable();

    const res = await follow(reader, author.id);

    expect(res.status).toBe(200);
  });
});

describe('purging Signals after ninety days', () => {
  const NOW = '2026-09-03T12:00:00.000Z';

  it('deletes a row past retention and keeps one inside it', async () => {
    // Retention is a promise the privacy policy makes in writing, so it is kept by code that runs whether
    // anybody is reading or not.
    const old = createUser({ username: 'long-ago' });
    const recent = createUser({ username: 'last-month' });
    age(old, 91, NOW);
    age(recent, 89, NOW);

    const deleted = sweepSignals(NOW);

    expect(deleted).toBe(1);
    expect(signalsFor(old)).toEqual([]);
    expect(signalsFor(recent)).toHaveLength(1);
  });

  it('leaves a row written today alone', async () => {
    const user = createUser({ username: 'here-now' });
    await login(user);

    sweepSignals();

    expect(signalsFor(user)).toHaveLength(1);
  });
});

describe('erasing an account', () => {
  it('takes its Signals with it, and leaves everybody else theirs', async () => {
    // Erasure has to include these or the policy overstates what deleting an account does. Counted over
    // the whole table rather than by the departing account's id: a row that merely lost its owner is
    // still a row, and a query keyed on the id would report it as gone.
    const departing = createUser({ username: 'departing' });
    const staying = createUser({ username: 'staying' });
    await login(departing);
    await login(staying);
    expect(db.prepare('SELECT COUNT(*) AS count FROM signals').get().count).toBe(2);

    const result = await deleteUser('departing');

    expect(result.success, result.error).toBe(true);
    expect(db.prepare('SELECT * FROM signals').all()).toEqual([
      expect.objectContaining({ user_id: staying.id })
    ]);
  });
});
