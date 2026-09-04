import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { browserFamily } = require('../src/utils/browserFamily');
const { sweepSignals } = require('../src/utils/sweepSignals');
const Signal = require('../src/models/Signal');
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
 * Rows on the table itself.
 *
 * Only for the two things no endpoint can show: that a row is actually gone, and that the address was
 * never readable off it. Everything a staff member can observe is read through the endpoint below.
 */
const rowsFor = (user) =>
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

/** Names are unique per test, and several helpers make an account of their own. */
let made = 0;

/** Staff to read the moderation endpoint with. It never acts, so it never turns up in its own answer. */
const staffViewer = () => createUser({ username: `signal-staff-${++made}`, accountType: 'admin' });

/** Ask the staff endpoint which accounts share an address with this one. */
const linked = (viewer, userId) =>
  request(app).get(`/api/users/${userId}/linked`).set(authHeader(viewer));

/** The accounts the endpoint links to this one, by name, newest match first. */
const linksOf = async (subject) =>
  (await linked(staffViewer(), subject.id)).body.data.accounts.map((row) => row.username);

/**
 * Somebody else recorded at the same address, so the subject's own moments have something to surface
 * through. Follows rather than signs in: the credential routes are rate limited per address, and the
 * tests that are actually about signing in need that budget.
 */
const witnessAt = async (subject, address) => {
  const witness = createUser({ username: `signal-witness-${++made}` });
  await follow(witness, subject.id, address);

  return witness;
};

/**
 * The moments one account is recorded as having acted in, as staff read them.
 *
 * Read through the endpoint rather than off the table, because that is what a staff member observes —
 * and there is deliberately no view of an account's Signals on their own. The record exists to link
 * accounts, so it only ever surfaces through another account it links to; a witness at the same address
 * is what makes the subject's own moments visible. Newest first, as the endpoint orders them.
 *
 * @param subject - The account to read
 * @param address - Where the witness acts from, which is where the subject acted too
 */
const signalsFor = async (subject, address = '203.0.113.10') => {
  const witness = await witnessAt(subject, address);
  const match = (await linked(staffViewer(), subject.id)).body.data.accounts
    .find((row) => row.id === witness.id);

  return match ? match.subjectEvents : [];
};

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
    expect((await signalsFor(res.body.user)).map((row) => row.event)).toEqual(['signup']);
  });

  it('records the login', async () => {
    const user = createUser({ username: 'returning' });

    const res = await login(user);

    expect(res.status).toBe(200);
    expect((await signalsFor(user)).map((row) => row.event)).toEqual(['login']);
  });

  it('records the publish', async () => {
    const author = createUser({ username: 'publisher' });

    const res = await publish(author);

    expect(res.status).toBe(201);
    expect((await signalsFor(author)).map((row) => row.event)).toEqual(['publish']);
  });

  it('records an edit as a publish too', async () => {
    const { author, id } = await seed();

    const res = await update(author, id);

    expect(res.status).toBe(200);
    expect((await signalsFor(author)).map((row) => row.event)).toEqual(['publish']);
  });

  it('records the like — the event a vote ring cannot avoid', async () => {
    const { reader, id } = await seed();

    const res = await like(reader, id);

    expect(res.status).toBe(200);
    expect((await signalsFor(reader)).map((row) => row.event)).toEqual(['like']);
  });

  it('records the comment', async () => {
    const { reader, id } = await seed();

    const res = await comment(reader, id);

    expect(res.status).toBe(201);
    expect((await signalsFor(reader)).map((row) => row.event)).toEqual(['comment']);
  });

  it('records the follow', async () => {
    const { author, reader } = await seed();

    const res = await follow(reader, author.id);

    expect(res.status).toBe(200);
    expect((await signalsFor(reader)).map((row) => row.event)).toEqual(['follow']);
  });

  it('records it against the account that acted, not the one acted on', async () => {
    const { author, reader, id } = await seed();

    await like(reader, id);

    expect(await signalsFor(author)).toEqual([]);
    expect(await signalsFor(reader)).toHaveLength(1);
  });

  it('stores the browser family the request arrived with', async () => {
    const user = createUser({ username: 'on-a-phone' });

    await from('203.0.113.10', request(app).post('/api/auth/login'))
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1')
      .send({ username: user.username, password: user.password });

    expect((await signalsFor(user))[0].browserFamily).toBe('Safari/iOS');
  });
});

describe('what a Signal stores about an address', () => {
  it('links two accounts that acted from one address, from either side', async () => {
    // The whole point: staff can see that two accounts came from one place, whichever one they opened.
    const one = createUser({ username: 'ring-one' });
    const two = createUser({ username: 'ring-two' });

    await login(one, '198.51.100.7');
    await login(two, '198.51.100.7');

    expect(await linksOf(one)).toEqual(['ring-two']);
    expect(await linksOf(two)).toEqual(['ring-one']);
  });

  it('does not link two accounts that acted from different addresses', async () => {
    const one = createUser({ username: 'here' });
    const two = createUser({ username: 'elsewhere' });

    await login(one, '198.51.100.8');
    await login(two, '203.0.113.99');

    expect(await linksOf(one)).toEqual([]);
  });

  it('keeps no readable trace of the address itself', async () => {
    // Read off the table on purpose. Every other property here is what staff observe; this one is about
    // what is written down, and a response that happens to omit the address would prove nothing.
    const user = createUser({ username: 'private' });

    await login(user, '198.51.100.9');

    const [row] = rowsFor(user);
    expect(row.address_hash).not.toContain('198.51.100');
    expect(JSON.stringify(row)).not.toContain('198.51.100');
  });

  it('is salted, so rotating the salt unlinks every row that came before', async () => {
    // The emergency lever. Without the salt in the hash, the same address would hash the same on any
    // server anywhere, and a rainbow table would read the addresses straight back out of a leaked table.
    const before = createUser({ username: 'before-rotation' });
    const after = createUser({ username: 'after-rotation' });
    const salt = process.env.SIGNAL_SALT;

    await login(before, '198.51.100.11');
    process.env.SIGNAL_SALT = 'a-rotated-salt';
    try {
      await login(after, '198.51.100.11');
    } finally {
      process.env.SIGNAL_SALT = salt;
    }

    expect(await linksOf(before)).toEqual([]);
  });

  it('reads the address the rate limiter reads, so the tunnel is handled once', async () => {
    // Every external request reaches this origin from loopback, so `req.ip` is the same for everybody.
    // A Signal that keyed on it would put the whole server in one place and link nobody to anybody.
    const one = createUser({ username: 'tunnelled-one' });
    const two = createUser({ username: 'tunnelled-two' });

    await login(one, '198.51.100.12');
    await request(app).post('/api/auth/login').send({ username: two.username, password: two.password });

    expect(await linksOf(one)).toEqual([]);
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

describe('reading the accounts one account is linked to', () => {
  /** The audit log, filtered to the action this endpoint writes. */
  const viewings = async (viewer) =>
    (await request(app).get('/api/audit?action=signals_viewed').set(authHeader(viewer))).body.data;

  it('leaves out a match that fell outside retention', async () => {
    // Ninety days is a promise in writing, so the read cuts at the edge itself. The sweeper runs hourly;
    // a row an hour past its ninety days must not still be linking two accounts on a staff screen.
    const subject = createUser({ username: 'still-here' });
    const recent = createUser({ username: 'shared-last-month' });
    const longAgo = createUser({ username: 'shared-last-year' });
    const now = new Date().toISOString();
    age(subject, 1, now);
    age(recent, 89, now);
    age(longAgo, 91, now);

    expect(await linksOf(subject)).toEqual(['shared-last-month']);
  });

  it('names the moments that made the link, on both sides', async () => {
    // A link reads as two stories or not at all. What each account did from the shared address is what
    // separates a ring from two people in one house, and that judgment stays a person's.
    const { author, reader, id } = await seed();
    await like(reader, id, true, '198.51.100.21');
    await comment(reader, id, '198.51.100.21');
    await follow(author, reader.id, '198.51.100.21');

    const [match] = (await linked(staffViewer(), author.id)).body.data.accounts;

    expect(match.events.map((row) => row.event)).toEqual(['comment', 'like']);
    expect(match.subjectEvents.map((row) => row.event)).toEqual(['follow']);
    expect(match.events[0].at).toBeTruthy();
  });

  it('says what the other account is and when it was made', async () => {
    // Enough to judge the account without leaving the row: a suspended account and a signup an hour
    // before the likes started are both the shape somebody is looking for.
    const subject = createUser({ username: 'subject' });
    const other = createUser({
      username: 'brand-new', status: 'suspended', createdAt: '2026-01-02T03:04:05.000Z'
    });
    const now = new Date().toISOString();
    age(subject, 1, now);
    age(other, 2, now);

    const [match] = (await linked(staffViewer(), subject.id)).body.data.accounts;

    expect(match).toMatchObject({
      id: other.id,
      username: 'brand-new',
      status: 'suspended',
      createdAt: '2026-01-02T03:04:05.000Z'
    });
  });

  it('answers zero for an account nobody shares an address with', async () => {
    const alone = createUser({ username: 'alone' });
    await follow(alone, createUser({ username: 'never-acted' }).id, '198.51.100.23');

    const res = await linked(staffViewer(), alone.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accounts: [] });
  });

  it('caps the moments it lists and still says how many there are', async () => {
    // Two accounts on one address for three months have hundreds of them. Staff read the first few and
    // decide, so the true count travels beside the rows rather than the rows growing without limit.
    const subject = createUser({ username: 'busy-one' });
    const other = createUser({ username: 'busy-two' });
    const now = new Date().toISOString();
    age(subject, 1, now);
    for (let i = 0; i < Signal.MATCH_EVENT_LIMIT + 3; i++) age(other, 2, now);

    const [match] = (await linked(staffViewer(), subject.id)).body.data.accounts;

    expect(match.events).toHaveLength(Signal.MATCH_EVENT_LIMIT);
    expect(match.eventsTotal).toBe(Signal.MATCH_EVENT_LIMIT + 3);
  });

  it('writes an audit row every time it is opened, not only the first', async () => {
    // Reading linkage data is the one act in here that says where a person was, so it is accountable
    // itself. A row written once per account would leave the second look — the one somebody went back
    // for — unrecorded.
    const root = createUser({ username: 'root-admin', accountType: 'admin' });
    const subject = createUser({ username: 'looked-at' });

    await linked(root, subject.id);
    await linked(root, subject.id);

    const entries = await viewings(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'signals_viewed',
      actor: { username: 'root-admin' },
      targetUser: { username: 'looked-at' }
    });
  });

  it('writes the row even when the account is linked to nobody', async () => {
    // The record is of the look, not of what it found. A search that came back empty is still a search.
    const root = createUser({ username: 'root-admin', accountType: 'admin' });

    await linked(root, createUser({ username: 'unremarkable' }).id);

    expect(await viewings(root)).toHaveLength(1);
  });

  it('is refused to an ordinary account', async () => {
    const subject = createUser({ username: 'subject' });

    expect((await linked(createUser({ username: 'nosy' }), subject.id)).status).toBe(403);
  });

  it('is refused to a signed-out visitor', async () => {
    const subject = createUser({ username: 'subject' });

    expect((await request(app).get(`/api/users/${subject.id}/linked`)).status).toBe(401);
  });

  it('answers 404 for an account that is not there', async () => {
    expect((await linked(staffViewer(), 'no-such-account')).status).toBe(404);
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
    expect(rowsFor(old)).toEqual([]);
    expect(rowsFor(recent)).toHaveLength(1);
  });

  it('leaves a row written today alone', async () => {
    const user = createUser({ username: 'here-now' });
    await login(user);

    sweepSignals();

    expect(rowsFor(user)).toHaveLength(1);
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
