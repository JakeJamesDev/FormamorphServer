import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload, fromAddress, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const Signal = require('../src/models/Signal');
const AnonymousLike = require('../src/models/AnonymousLike');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME } = require('../src/config/anonymousLikes');
const { LIKE_LIMIT } = require('../src/config/likeLimit');
const { DAY_MS } = require('../src/config/time');
const { sweepRetention } = require('../src/utils/sweepRetention');

/**
 * Anonymous Likes — the heart a guest can press.
 *
 * A person who only downloads and plays has little reason to make an account, so the heart sends most of
 * them nowhere. This gives the press somewhere to land: a mark against the copy of the app they are
 * holding, counted in the same number an account Like is counted in.
 *
 * The feature ships switched off, because the privacy text has to state the collection first. Every test
 * that wants it on says so — `tests/setup.js` clears the settings table between tests, so off is the
 * state each one starts in.
 */

/** A fresh Install, as the app makes one: `crypto.randomUUID()`. */
const install = () => crypto.randomUUID();

const withInstall = (req, installId) => req.set(INSTALL_HEADER_NAME, installId);

const enable = () => Setting.set(ANONYMOUS_LIKES, true);

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

/** The guest route. `installId` of null sends no header at all. */
const anonLike = (id, installId, liked) => {
  const req = request(app).put(`/api/worlds/${id}/anonymous-like`).send({ liked });
  return installId === null ? req : withInstall(req, installId);
};

const accountLike = (user, id, liked) =>
  request(app).put(`/api/worlds/${id}/like`).set(authHeader(user)).send({ liked });

/** Two addresses from the documentation range, so neither is one anybody holds. */
const HOUSE = '198.51.100.7';
const ELSEWHERE = '198.51.100.8';

/**
 * Move every mark on a listing back in time, so a sweep with a fixed clock can reach them.
 *
 * Written straight to the row because nothing sets a mark's age: it is stamped on the press. The mark is
 * otherwise a real one, given through the route.
 */
const ageMarks = (worldId, days, now) => db.prepare(`
  UPDATE anonymous_likes SET created_at = ? WHERE world_id = ?
`).run(new Date(new Date(now).getTime() - days * DAY_MS).toISOString(), worldId);

/** Fill a listing's cap from one address, and answer with the three Installs that did it. */
const fillCap = async (worldId, address = HOUSE) => {
  const installs = [install(), install(), install()];
  for (const installId of installs) await fromAddress(address, anonLike(worldId, installId, true));

  return installs;
};

const list = (query = '') => request(app).get(`/api/worlds${query}`);

const readOne = (id) => request(app).get(`/api/worlds/${id}`);

const rowFor = (body, id) => body.data.find((w) => w.id === id);

/** One published listing, its author, and somebody else to do the liking. */
const seed = async (over = {}) => {
  const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
  const reader = createUser({ username: `reader-${Math.random().toString(36).slice(2, 8)}` });
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;

  return { author, reader, id };
};

describe('liking a listing while signed out', () => {
  it('sets the like and answers with the state and the new count', async () => {
    enable();
    const { id } = await seed();

    const res = await anonLike(id, install(), true);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });

  it('takes the like back', async () => {
    enable();
    const { id } = await seed();
    const me = install();
    await anonLike(id, me, true);

    const res = await anonLike(id, me, false);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: false, likes: 0 });
  });

  it('counts one Install once, however many times it presses', async () => {
    enable();
    const { id } = await seed();
    const me = install();

    await anonLike(id, me, true);
    const res = await anonLike(id, me, true);

    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });

  it('clears an Install that never liked without complaining', async () => {
    enable();
    const { id } = await seed();

    const res = await anonLike(id, install(), false);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: false, likes: 0 });
  });

  it('counts two Installs as two', async () => {
    enable();
    const { id } = await seed();

    await anonLike(id, install(), true);
    const res = await anonLike(id, install(), true);

    expect(res.body.data.likes).toBe(2);
  });

  it('needs no account, and ignores a token if one comes anyway', async () => {
    // The route is the guest's. A signed-in client uses the account route; if it reached this one, the
    // mark still belongs to the Install, so the answer must not depend on the token.
    enable();
    const { reader, id } = await seed();

    const res = await request(app)
      .put(`/api/worlds/${id}/anonymous-like`)
      .set(authHeader(reader))
      .set(INSTALL_HEADER_NAME, install())
      .send({ liked: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });
});

describe('what the guest route refuses', () => {
  it('refuses while the feature is switched off', async () => {
    const { id } = await seed();

    const res = await anonLike(id, install(), true);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('anonymous_likes_off');
  });

  it('refuses a listing the room cannot see', async () => {
    enable();
    const { id } = await seed({ visibility: 'unlisted', kind: 'entity' });

    const res = await anonLike(id, install(), true);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('listing_not_visible');
  });

  it('refuses a listing that does not exist', async () => {
    enable();

    const res = await anonLike(crypto.randomUUID(), install(), true);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('listing_not_visible');
  });

  it('refuses a request with no Install header', async () => {
    enable();
    const { id } = await seed();

    const res = await anonLike(id, null, true);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('install_header_invalid');
  });

  it('refuses an Install header that is not an id this app makes', async () => {
    enable();
    const { id } = await seed();

    const res = await anonLike(id, 'not-a-uuid', true);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('install_header_invalid');
  });

  it('refuses a body that does not say which way the heart went', async () => {
    enable();
    const { id } = await seed();

    const res = await anonLike(id, install(), 'yes');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('liked_invalid');
  });

  it('answers the switch before it answers anything else', async () => {
    // The emergency stop is the operator's, and it must not be probeable for what else is wrong.
    const { id } = await seed();

    const res = await anonLike(id, 'not-a-uuid', true);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('anonymous_likes_off');
  });
});

describe('the number the room sees', () => {
  it('sums account Likes and Anonymous Likes on a listing', async () => {
    enable();
    const { reader, id } = await seed();

    await accountLike(reader, id, true);
    await anonLike(id, install(), true);

    expect((await readOne(id)).body.data.likes).toBe(2);
    expect(rowFor((await list()).body, id).likes).toBe(2);
  });

  it('orders the Likes sort by the summed number', async () => {
    enable();
    const author = createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
    const reader = createUser({ username: `reader-${Math.random().toString(36).slice(2, 8)}` });
    const accountOnly = (await publish(author, { name: 'One Account Like' })).body.data.id;
    const anonymousOnly = (await publish(author, { name: 'Two Anonymous Likes' })).body.data.id;

    await accountLike(reader, accountOnly, true);
    await anonLike(anonymousOnly, install(), true);
    await anonLike(anonymousOnly, install(), true);

    const res = await list('?sort=likes&order=desc');

    expect(res.body.data.map((w) => w.id).slice(0, 2)).toEqual([anonymousOnly, accountOnly]);
  });

  it('adds Anonymous Likes to an author total', async () => {
    enable();
    const { author, reader, id } = await seed();

    await accountLike(reader, id, true);
    await anonLike(id, install(), true);

    const res = await request(app).get(`/api/users/${author.id}/profile`);

    expect(res.body.data.likes).toBe(2);
  });

  it('leaves an author total when the listing leaves the public catalog', async () => {
    // The public-only rule the totals already follow. An Anonymous Like follows it too.
    enable();
    const { author, id } = await seed();
    await anonLike(id, install(), true);

    db.prepare("UPDATE worlds SET visibility = 'unlisted' WHERE id = ?").run(id);

    const res = await request(app).get(`/api/users/${author.id}/profile`);

    expect(res.body.data.likes).toBe(0);
  });

  it('takes its Anonymous Likes with it when the listing goes', async () => {
    // Deleting the listing must leave nothing behind. A cascade is silently a no-op without the foreign
    // keys pragma, so the count is read back through a listing published afresh under the same id.
    enable();
    const { author, id } = await seed();
    await anonLike(id, install(), true);

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author));
    db.prepare(`
      INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file)
      VALUES (?, 'Sedge Landing', 'again', ?, 't.png', 'c.json')
    `).run(id, author.id);

    expect((await readOne(id)).body.data.likes).toBe(0);
  });

  it('keeps counting stored Anonymous Likes after the feature is switched off', async () => {
    // Switching off is a stop, not a delete: it refuses new marks and keeps the ones already given.
    enable();
    const { id } = await seed();
    await anonLike(id, install(), true);

    Setting.set(ANONYMOUS_LIKES, false);

    expect((await readOne(id)).body.data.likes).toBe(1);
  });
});

describe('the staff lists', () => {
  it('leaves Anonymous Likes out of the Likers list', async () => {
    // Staff read accounts here. The anonymous share of the number is ticket 04's to show.
    enable();
    const staffUser = createUser({ username: `mod-${Math.random().toString(36).slice(2, 8)}`, accountType: 'mod' });
    const { reader, id } = await seed();
    await accountLike(reader, id, true);
    await anonLike(id, install(), true);

    const res = await request(app).get(`/api/worlds/${id}/likes`).set(authHeader(staffUser));

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.rows).toHaveLength(1);
  });

  it('leaves Anonymous Likes out of what an account has given', async () => {
    // The other half of the same rule: this list answers for one account, and a mark with no account
    // behind it belongs to nobody it could be listed under.
    enable();
    const staffUser = createUser({ username: `mod-${Math.random().toString(36).slice(2, 8)}`, accountType: 'mod' });
    const { reader, id } = await seed();
    await accountLike(reader, id, true);
    await anonLike(id, install(), true);

    const res = await request(app).get(`/api/users/${reader.id}/likes`).set(authHeader(staffUser));

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.rows).toHaveLength(1);
  });
});

describe('the heart a guest sees filled', () => {
  it('marks a listing this Install liked, on the detail view and the catalog alike', async () => {
    enable();
    const { id } = await seed();
    const me = install();
    await anonLike(id, me, true);

    expect((await withInstall(readOne(id), me)).body.data.liked).toBe(true);
    expect(rowFor((await withInstall(list(), me)).body, id).liked).toBe(true);
  });

  it('marks a listing this Install has not liked as not liked', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, install(), true);

    const res = await withInstall(readOne(id), install());

    expect(res.body.data.liked).toBe(false);
  });

  it('leaves the flag absent for a guest who sends no Install', async () => {
    // Somebody with no account and no Install has not decided against liking anything.
    enable();
    const { id } = await seed();
    await anonLike(id, install(), true);

    expect((await readOne(id)).body.data).not.toHaveProperty('liked');
    expect(rowFor((await list()).body, id)).not.toHaveProperty('liked');
  });

  it('lets the account answer for a signed-in reader who also sends an Install', async () => {
    enable();
    const { reader, id } = await seed();
    const me = install();
    await anonLike(id, me, true);

    const res = await withInstall(readOne(id), me).set(authHeader(reader));

    expect(res.body.data.liked).toBe(false);
  });
});

describe('the switch the client is told about', () => {
  it('reports the feature as off on the catalog and on a listing', async () => {
    const { id } = await seed();

    expect((await list()).body.anonymousLikes).toBe(false);
    expect((await readOne(id)).body.anonymousLikes).toBe(false);
  });

  it('reports the feature as on once the operator switches it on', async () => {
    enable();
    const { id } = await seed();

    expect((await list()).body.anonymousLikes).toBe(true);
    expect((await readOne(id)).body.anonymousLikes).toBe(true);
  });

  it('reports the same flag to a signed-in reader as to a guest', async () => {
    // It says what the server allows, never what this reader may do.
    enable();
    const { reader, id } = await seed();

    const res = await readOne(id).set(authHeader(reader));

    expect(res.body.anonymousLikes).toBe(true);
  });
});

describe('the switch itself', () => {
  const staffUser = () =>
    createUser({ username: `mod-${Math.random().toString(36).slice(2, 8)}`, accountType: 'mod' });

  const readSetting = (who) =>
    request(app).get(`/api/settings/${ANONYMOUS_LIKES}`).set(authHeader(who));

  const writeSetting = (who, value) =>
    request(app).put(`/api/settings/${ANONYMOUS_LIKES}`).set(authHeader(who)).send({ value });

  it('is off on a server nobody has configured', async () => {
    // The privacy text has to state the collection first, so nothing is stored until the operator says so.
    const res = await readSetting(staffUser());

    expect(res.status).toBe(200);
    expect(res.body.data).toBe(false);
  });

  it('takes only true or false', async () => {
    const who = staffUser();

    const res = await writeSetting(who, 'on');

    expect(res.status).toBe(400);
    expect((await readSetting(who)).body.data).toBe(false);
  });

  it('is the operator’s to turn on and off again', async () => {
    const who = staffUser();

    expect((await writeSetting(who, true)).body.data).toBe(true);
    expect((await writeSetting(who, false)).body.data).toBe(false);
  });

  it('stays staff-only to read', async () => {
    // There is no public settings read on this server; a client learns the state from the catalog.
    const res = await request(app).get(`/api/settings/${ANONYMOUS_LIKES}`);

    expect(res.status).toBe(401);
  });
});

describe('the Install header across origins', () => {
  it('is allowed by a preflight', async () => {
    const res = await request(app)
      .options('/api/worlds')
      .set('Origin', 'https://formamorph.ai')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', INSTALL_HEADER_NAME);

    expect(res.headers['access-control-allow-headers'].toLowerCase())
      .toContain(INSTALL_HEADER_NAME.toLowerCase());
  });

  it('is named in the Vary of every response that reads it', async () => {
    const { id } = await seed();

    for (const res of [await list(), await readOne(id)]) {
      expect(res.headers.vary.toLowerCase()).toContain(INSTALL_HEADER_NAME.toLowerCase());
    }
  });
});

describe('the budget on the like routes', () => {
  it('gives both like routes a budget of their own, under the server-wide one', async () => {
    // Keyed on the address, so one client cannot hammer the heart inside the global limit.
    enable();
    const { reader, id } = await seed();

    const guest = await fromItsOwnAddress(anonLike(id, install(), true));
    const account = await fromItsOwnAddress(accountLike(reader, id, true));

    for (const res of [guest, account]) {
      expect(Number(res.headers['ratelimit-limit'])).toBe(LIKE_LIMIT);
    }
  });

  it('gives each address its own budget rather than one bucket for everyone', async () => {
    // Keyed on the client address: a busy household must not spend the budget of the next person to
    // press, and one client must not be able to hide behind another's quiet.
    enable();
    const { id } = await seed();

    const first = await fromItsOwnAddress(anonLike(id, install(), true));
    const second = await fromItsOwnAddress(anonLike(id, install(), true));

    expect(Number(first.headers['ratelimit-remaining'])).toBe(LIKE_LIMIT - 1);
    expect(Number(second.headers['ratelimit-remaining'])).toBe(LIKE_LIMIT - 1);
  });
});

describe('the cap on how many Anonymous Likes one address may give a listing', () => {
  // An Install is free to make: clearing local storage makes a new one. The address behind them is the
  // one thing that is harder to change, so the count is held against that. Three rather than one,
  // because a household and a dorm both look like one address and a family is not a ring. Nothing
  // beyond the refusal happens to a shared address.

  it('refuses the fourth Install on one address and names why', async () => {
    enable();
    const { id } = await seed();
    await fillCap(id);

    const res = await fromAddress(HOUSE, anonLike(id, install(), true));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('anonymous_likes_address_cap');
  });

  it('keeps the count at three when the fourth is refused', async () => {
    enable();
    const { id } = await seed();
    await fillCap(id);

    await fromAddress(HOUSE, anonLike(id, install(), true));

    expect((await readOne(id)).body.data.likes).toBe(3);
  });

  it('lets a refused Install like a different listing', async () => {
    // The cap is per listing. A household that liked one world to its limit has not spent anything on
    // the next one.
    enable();
    const first = await seed();
    const second = await seed({ name: 'Somewhere Else' });
    await fillCap(first.id);
    const refused = install();
    await fromAddress(HOUSE, anonLike(first.id, refused, true));

    const res = await fromAddress(HOUSE, anonLike(second.id, refused, true));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });

  it('counts the address rather than the Installs', async () => {
    // Three marks on the listing already, and a fourth press that is allowed: the guard is not counting
    // rows, it is counting the ones that came from the same place.
    enable();
    const { id } = await seed();
    await fillCap(id);

    const res = await fromAddress(ELSEWHERE, anonLike(id, install(), true));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 4 });
  });

  it('lets an Install that holds one of the three places press again', async () => {
    // Its own mark must not be one of the three standing in its way, or the third house to press
    // could never press twice and a client retrying a lost answer would see a refusal.
    enable();
    const { id } = await seed();
    const [mine] = await fillCap(id);

    const res = await fromAddress(HOUSE, anonLike(id, mine, true));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 3 });
  });

  it('lets an Install at the cap take its like back and give it again', async () => {
    // Its own mark is never what stands in its way, so a mistaken press costs nothing even in a house
    // that has used every place.
    enable();
    const { id } = await seed();
    const [mine] = await fillCap(id);
    await fromAddress(HOUSE, anonLike(id, mine, false));

    const res = await fromAddress(HOUSE, anonLike(id, mine, true));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 3 });
  });

  it('never refuses a press that takes a like back', async () => {
    // Clearing a mark that is not there is a no-op, not a refusal: a client whose heart is out of step
    // must always be able to put it right.
    enable();
    const { id } = await seed();
    await fillCap(id);

    const res = await fromAddress(HOUSE, anonLike(id, install(), false));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: false, likes: 3 });
  });
});

describe('letting go of an address after ninety days', () => {
  const NOW = '2026-09-03T12:00:00.000Z';

  afterEach(() => { vi.restoreAllMocks(); });

  /** These tests make a step fail on purpose, and the sweep says so on the console by design. */
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('keeps the like and stops it holding a place once its hash is gone', async () => {
    // Retention is a promise the privacy policy makes in writing: the address goes at ninety days. The
    // like is not the operator's to take away with it, so the number stays and only the cap lets go.
    enable();
    const { id } = await seed();
    await fillCap(id);
    ageMarks(id, 91, NOW);

    const swept = sweepRetention(NOW);
    const res = await fromAddress(HOUSE, anonLike(id, install(), true));

    expect(swept.hashes).toBe(3);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 4 });
  });

  it('leaves a mark inside retention holding its place', async () => {
    enable();
    const { id } = await seed();
    await fillCap(id);
    ageMarks(id, 89, NOW);

    const swept = sweepRetention(NOW);
    const res = await fromAddress(HOUSE, anonLike(id, install(), true));

    expect(swept.hashes).toBe(0);
    expect(res.status).toBe(403);
  });

  it('reports nothing the second time over the same marks', async () => {
    enable();
    const { id } = await seed();
    await fillCap(id);
    ageMarks(id, 91, NOW);
    sweepRetention(NOW);

    expect(sweepRetention(NOW).hashes).toBe(0);
  });

  it('empties the hashes even when the Signal purge throws', async () => {
    // Two steps that share a deadline and nothing else. A table that will not write must not keep the
    // other one from expiring, or one broken purge quietly holds addresses past what was promised.
    enable();
    const { id } = await seed();
    await fillCap(id);
    ageMarks(id, 91, NOW);
    quiet();
    vi.spyOn(Signal, 'deleteBefore').mockImplementation(() => { throw new Error('the table is locked'); });

    const swept = sweepRetention(NOW);

    expect(swept).toEqual({ signals: 0, hashes: 3 });
  });

  it('purges the Signals even when emptying the hashes throws', async () => {
    // The other direction of the same bargain. The hash step runs second, so nothing about the order
    // protects the purge; only the catch around each step does.
    const user = createUser({ username: 'long-ago' });
    db.prepare(`
      INSERT INTO signals (user_id, event, address_hash, browser_family, created_at)
      VALUES (?, 'login', 'a-hash', 'Other/Other', ?)
    `).run(user.id, new Date(new Date(NOW).getTime() - 91 * DAY_MS).toISOString());
    quiet();
    vi.spyOn(AnonymousLike, 'blankHashesBefore').mockImplementation(() => {
      throw new Error('the table is locked');
    });

    const swept = sweepRetention(NOW);

    expect(swept).toEqual({ signals: 1, hashes: 0 });
  });

  it('answers with nothing swept rather than throwing when the deadline cannot be read', async () => {
    // `hourly` calls this with no argument and never looks at what comes back, so a throw here would
    // be an unhandled rejection on a timer nobody is watching.
    quiet();
    vi.spyOn(Signal, 'cutoff').mockImplementation(() => { throw new Error('no clock'); });

    expect(sweepRetention(NOW)).toEqual({ signals: 0, hashes: 0 });
  });
});
