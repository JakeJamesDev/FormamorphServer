import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { DAY_MS } = require('../src/config/time');
const Setting = require('../src/models/Setting');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME } = require('../src/config/anonymousLikes');

/**
 * The likes audit — four accounts, one address, one contest entry.
 *
 * The case this was built for: accounts made minutes apart from one place, each liking the same listing
 * seconds after it existed. The plain like list already shows how old each account was; what it cannot
 * show is that the accounts are one person. This endpoint answers that by grouping Likers whose Signals
 * share an address, and by marking the ones who share one with the author.
 *
 * Nothing here decides anything. A group of four is a question for a staff member, and the like-removal
 * tool beside it is the answer — which is why both are on the one screen.
 */

const rnd = () => Math.random().toString(36).slice(2, 8);

const user = (name = 'liker', over = {}) => createUser({ username: `${name}-${rnd()}`, ...over });
const mod = () => createUser({ username: `mod-${rnd()}`, accountType: 'mod' });

/** One address a ring acts from, and one somebody unrelated acts from. */
const HOME = '203.0.113.10';
const ELSEWHERE = '198.51.100.7';

const from = (address, req) => req.set('CF-Connecting-IP', address);

const publish = (author, address = ELSEWHERE, over = {}) =>
  from(address, request(app).post('/api/worlds').set(authHeader(author))).send(worldPayload(over));

const like = (who, id, address = ELSEWHERE) =>
  from(address, request(app).put(`/api/worlds/${id}/like`).set(authHeader(who))).send({ liked: true });

/** Puts an account at a second address without spending the credential routes' per-address budget. */
const follow = (who, targetId, address) =>
  from(address, request(app).put(`/api/users/${targetId}/follow`).set(authHeader(who))).send();

const withAuth = (req, who) => (who ? req.set(authHeader(who)) : req);

const audit = (who, id) => withAuth(request(app).get(`/api/worlds/${id}/likes/audit`), who);

const removeLike = (who, worldId, userId) =>
  withAuth(request(app).delete(`/api/worlds/${worldId}/likes/${userId}`), who);

const logEntries = async (who, query = '') =>
  (await request(app).get(`/api/audit${query}`).set(authHeader(who))).body.data;

/** Like timestamps carry milliseconds; a pause between two likes keeps their order unambiguous. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The audit rows keyed by username, so a test names accounts rather than counting positions. */
const rowsByName = async (who, id) => {
  const res = await audit(who, id);

  return Object.fromEntries(res.body.data.rows.map((row) => [row.username, row]));
};

/** A published listing and its author, the author acting from `address`. */
const seed = async (address = ELSEWHERE) => {
  const author = user('author');
  const id = (await publish(author, address, { name: 'Sedge Landing' })).body.data.id;

  return { author, id };
};

/**
 * Move every Signal an account has behind the retention edge.
 *
 * The row is a real one, written by the like it describes; only its instant moves. Ninety days cannot be
 * waited for, and inserting a fake row would test the insert rather than the cut.
 */
const ageOut = (who) => {
  const at = new Date(Date.now() - 91 * DAY_MS).toISOString();
  db.prepare('UPDATE signals SET created_at = ? WHERE user_id = ?').run(at, who.id);
};

describe('grouping likers by the address they liked from', () => {
  it('makes four accounts from one address one group, and leaves a fifth on its own', async () => {
    const { id } = await seed();
    const ring = [user('ring1'), user('ring2'), user('ring3'), user('ring4')];
    const stranger = user('stranger');

    for (const account of ring) {
      await like(account, id, HOME);
      await tick();
    }
    await like(stranger, id, ELSEWHERE);

    const rows = await rowsByName(mod(), id);
    const groups = ring.map((account) => rows[account.username].groupId);

    // One group id across all four, and a real one rather than the absence of a group.
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBeNull();
    // Alone at their own address, so there is no group to be in.
    expect(rows[stranger.username].groupId).toBeNull();
  });

  it('leaves every liker ungrouped when they each came from their own address', async () => {
    const { id } = await seed();
    const alice = user('alice');
    const bob = user('bob');

    await like(alice, id, HOME);
    await like(bob, id, ELSEWHERE);

    const rows = await rowsByName(mod(), id);

    expect(rows[alice.username].groupId).toBeNull();
    expect(rows[bob.username].groupId).toBeNull();
  });

  it('gives two separate pairs two different group ids', async () => {
    const { id } = await seed();
    const [a, b, c, d] = [user('a'), user('b'), user('c'), user('d')];

    await like(a, id, HOME);
    await like(b, id, HOME);
    await like(c, id, ELSEWHERE);
    await like(d, id, ELSEWHERE);

    const rows = await rowsByName(mod(), id);

    expect(rows[a.username].groupId).toBe(rows[b.username].groupId);
    expect(rows[c.username].groupId).toBe(rows[d.username].groupId);
    expect(rows[a.username].groupId).not.toBe(rows[c.username].groupId);
  });

  it('joins two addresses into one group through the account that used both', async () => {
    const { id } = await seed();
    const home = user('home');
    const both = user('both');
    const away = user('away');

    await like(home, id, HOME);
    await like(both, id, HOME);
    // The same account acting from a second address, which is what makes the two places one person.
    await follow(both, home.id, ELSEWHERE);
    await like(away, id, ELSEWHERE);

    const rows = await rowsByName(mod(), id);
    const groups = [home, both, away].map((account) => rows[account.username].groupId);

    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBeNull();
  });

  it('drops a liker out of the group once their signal passes the retention edge', async () => {
    const { id } = await seed();
    const stays = user('stays');
    const expires = user('expires');

    await like(stays, id, HOME);
    await like(expires, id, HOME);
    // A third account still inside retention, so the group survives the one that leaves it.
    await like(user('third'), id, HOME);
    ageOut(expires);

    const rows = await rowsByName(mod(), id);

    expect(rows[stays.username].groupId).not.toBeNull();
    // Ninety days is the promise the privacy policy makes; an hour past it must not still link anybody.
    expect(rows[expires.username].groupId).toBeNull();
  });
});

describe('marking a liker who shares an address with the author', () => {
  it('marks the one who acted from the author address and leaves the rest alone', async () => {
    const { id } = await seed(HOME);
    const sock = user('sock');
    const stranger = user('stranger');

    await like(sock, id, HOME);
    await like(stranger, id, ELSEWHERE);

    const rows = await rowsByName(mod(), id);

    expect(rows[sock.username].linkedToAuthor).toBe(true);
    expect(rows[stranger.username].linkedToAuthor).toBe(false);
  });

  it('never has the author to mark, because liking your own listing is refused', async () => {
    const { author, id } = await seed(HOME);

    // The mark means "shares an address with the author". The author trivially would, so the row that
    // would carry it meaninglessly is the one the like route already refuses to create.
    expect((await like(author, id, HOME)).status).toBe(400);

    const rows = await rowsByName(mod(), id);

    expect(rows[author.username]).toBeUndefined();
  });

  it('stops marking once the author signal passes the retention edge', async () => {
    const { author, id } = await seed(HOME);
    const sock = user('sock');

    await like(sock, id, HOME);
    ageOut(author);

    const rows = await rowsByName(mod(), id);

    expect(rows[sock.username].linkedToAuthor).toBe(false);
  });
});

describe('what an audit row carries', () => {
  it('carries every field the plain list has, and the two the audit adds', async () => {
    const { id } = await seed();
    // Four minutes between the signup and the like: the gap this screen exists to make visible.
    const fresh = user('fresh', {
      createdAt: new Date(Date.now() - 4 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    });

    await like(fresh, id, HOME);

    const rows = await rowsByName(mod(), id);

    expect(rows[fresh.username]).toEqual({
      id: fresh.id,
      username: fresh.username,
      avatarUrl: null,
      status: 'normal',
      createdAt: expect.any(String),
      likedAt: expect.any(String),
      // Given as an account rather than moved off an Install, so there is no claim to mark.
      claimedAt: null,
      accountAgeAtLikeSeconds: expect.any(Number),
      groupId: null,
      linkedToAuthor: false
    });
    // Under an hour, so the phrase the client builds from it is a count of minutes.
    expect(rows[fresh.username].accountAgeAtLikeSeconds).toBeLessThan(3_600);
  });

  it('answers with the full like count beside the rows', async () => {
    const { id } = await seed();
    await like(user('one'), id, HOME);
    await like(user('two'), id, HOME);

    const res = await audit(mod(), id);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.rows).toHaveLength(2);
  });

  it('answers with an empty list for a listing nobody has liked', async () => {
    const { id } = await seed();

    const res = await audit(mod(), id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ total: 0, rows: [], anonymous: 0, anonymousRows: [] });
  });
});

describe('acting on what the audit shows', () => {
  it('drops a removed like out of the next audit', async () => {
    const { id } = await seed();
    const sock = user('sock');
    const other = user('other');
    await like(sock, id, HOME);
    await like(other, id, HOME);
    const moderator = mod();

    expect((await removeLike(moderator, id, sock.id)).status).toBe(200);

    const res = await audit(moderator, id);

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.rows.map((row) => row.username)).toEqual([other.username]);
  });
});

describe('who may read the audit, and what reading it records', () => {
  it('writes no audit entry, because reading likes is routine staff work', async () => {
    const { id } = await seed();
    const moderator = mod();
    await like(user('sock'), id, HOME);

    expect((await audit(moderator, id)).status).toBe(200);

    expect(await logEntries(moderator, '?action=signals_viewed')).toEqual([]);
  });

  it('refuses an ordinary account, and writes nothing when it does', async () => {
    const { id } = await seed();
    const ordinary = user('ordinary');

    expect((await audit(ordinary, id)).status).toBe(403);
    expect(await logEntries(mod(), '?action=signals_viewed')).toEqual([]);
  });

  it('refuses a caller with no session', async () => {
    const { id } = await seed();

    expect((await audit(null, id)).status).toBe(401);
  });

  it('answers 404 for a listing that is not there', async () => {
    expect((await audit(mod(), 'no-such-listing')).status).toBe(404);
  });
});

/**
 * The guest half of the same screen.
 *
 * A listing's number is account Likes and Anonymous Likes added together, so an audit that read only the
 * account side would miss a flood entirely. These marks carry no account, so the only thing that can link
 * one to anything else is the address it came from — which is what the grouping already works in. A mark
 * joins a group through its hash, beside the accounts that share it.
 *
 * Staff never see that hash, and never see the Install id. What they get is an `addressKey`: a digest of
 * the hash and the listing together, enough to press a removal button with and useless anywhere else.
 */

const anonRows = async (who, id) => (await audit(who, id)).body.data.anonymousRows;

/** One Install's mark, given from an address. The feature is off until a test turns it on. */
const anonLike = (id, address, installId = crypto.randomUUID()) =>
  from(address, request(app).put(`/api/worlds/${id}/anonymous-like`).set(INSTALL_HEADER_NAME, installId))
    .send({ liked: true });

const enable = () => Setting.set(ANONYMOUS_LIKES, true);

const likers = (who, id) => withAuth(request(app).get(`/api/worlds/${id}/likes`), who);

const clearAnonymous = (who, id) =>
  withAuth(request(app).delete(`/api/worlds/${id}/anonymous-likes`), who);

const removeAddress = (who, id, addressKey) =>
  withAuth(request(app).delete(`/api/worlds/${id}/anonymous-likes/address/${addressKey}`), who);

const claim = (who, installId) =>
  request(app).post('/api/users/me/anonymous-likes/claim')
    .set(authHeader(who)).set(INSTALL_HEADER_NAME, installId).send();

/**
 * Take the address off every mark on a listing, as the retention sweep does at ninety days.
 *
 * Written straight to the row because the sweep is a clock away rather than a route. The marks are real
 * ones, given through the route; only the hash they carry changes.
 */
const blankHashes = (worldId) =>
  db.prepare("UPDATE anonymous_likes SET address_hash = '' WHERE world_id = ?").run(worldId);

describe('grouping anonymous marks with the accounts beside them', () => {
  it('puts two marks and two accounts from one address in the same group', async () => {
    enable();
    const { id } = await seed();

    await like(user('a'), id, HOME);
    await like(user('b'), id, HOME);
    await anonLike(id, HOME);
    await anonLike(id, HOME);

    const res = await audit(mod(), id);
    const accountGroups = res.body.data.rows.map((row) => row.groupId);
    const markGroups = res.body.data.anonymousRows.map((row) => row.groupId);

    expect(new Set([...accountGroups, ...markGroups]).size).toBe(1);
    expect(markGroups[0]).not.toBeNull();
  });

  it('leaves a mark from its own address out of the accounts group', async () => {
    enable();
    const { id } = await seed();

    await like(user('a'), id, HOME);
    await like(user('b'), id, HOME);
    await anonLike(id, ELSEWHERE);

    const res = await audit(mod(), id);

    expect(res.body.data.rows[0].groupId).not.toBeNull();
    // One mark, one address, nobody else there: a group of one is not a group.
    expect(res.body.data.anonymousRows[0].groupId).toBeNull();
  });

  it('groups two marks from one address with no account in sight', async () => {
    enable();
    const { id } = await seed();

    await anonLike(id, HOME);
    await anonLike(id, HOME);
    await anonLike(id, ELSEWHERE);

    const grouped = (await anonRows(mod(), id)).filter((row) => row.groupId !== null);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].groupId).toBe(grouped[1].groupId);
  });

  it('lists a mark whose hash the sweep has taken, and never groups it', async () => {
    enable();
    const { id } = await seed();

    await anonLike(id, HOME);
    await anonLike(id, HOME);
    blankHashes(id);

    const rows = await anonRows(mod(), id);

    expect(rows).toHaveLength(2);
    // Two marks that were one address an hour ago. Past retention the server no longer knows that, and
    // saying so would be inventing evidence it threw away.
    expect(rows.map((row) => row.groupId)).toEqual([null, null]);
    expect(rows.map((row) => row.addressKey)).toEqual([null, null]);
  });

  it('gives a mark a key that means nothing on another listing', async () => {
    enable();
    const author = user('author');
    const first = (await publish(author, ELSEWHERE, { name: 'Sedge Landing' })).body.data.id;
    const second = (await publish(author, ELSEWHERE, { name: 'Harrow Mill' })).body.data.id;

    await anonLike(first, HOME);
    await anonLike(second, HOME);

    const moderator = mod();
    const [one] = await anonRows(moderator, first);
    const [two] = await anonRows(moderator, second);

    expect(one.addressKey).toEqual(expect.any(String));
    expect(one.addressKey).not.toBe(two.addressKey);
  });
});

describe('marking a mark that came from the author address', () => {
  it('reports a lone mark from the author address, though it is in no group', async () => {
    enable();
    const { id } = await seed(HOME);

    await anonLike(id, HOME);
    await anonLike(id, ELSEWHERE);

    const rows = await anonRows(mod(), id);
    const sock = rows.find((row) => row.linkedToAuthor);

    expect(sock).toBeDefined();
    // The whole point of the flag: one mark, no group to put it in, and still what staff want to see.
    expect(sock.groupId).toBeNull();
    expect(rows.filter((row) => row.linkedToAuthor)).toHaveLength(1);
  });

  it('stops marking once the author signal passes the retention edge', async () => {
    enable();
    const { author, id } = await seed(HOME);

    await anonLike(id, HOME);
    ageOut(author);

    expect((await anonRows(mod(), id))[0].linkedToAuthor).toBe(false);
  });
});

describe('what an anonymous audit row carries', () => {
  it('carries the press, the browser family, the group and the key, and nothing that names the Install', async () => {
    enable();
    const { id } = await seed();

    await anonLike(id, HOME);

    const [row] = await anonRows(mod(), id);

    expect(row).toEqual({
      likedAt: expect.any(String),
      browserFamily: expect.any(String),
      groupId: null,
      linkedToAuthor: false,
      addressKey: expect.any(String)
    });
  });

  it('counts the marks beside the account rows, on the audit and on the plain list', async () => {
    enable();
    const { id } = await seed();

    await like(user('reader'), id, ELSEWHERE);
    await anonLike(id, HOME);
    await anonLike(id, HOME);

    const moderator = mod();
    const audited = (await audit(moderator, id)).body.data;
    const listed = (await likers(moderator, id)).body.data;

    expect(audited.total).toBe(1);
    expect(audited.anonymous).toBe(2);
    expect(listed.total).toBe(1);
    expect(listed.anonymous).toBe(2);
  });

  it('says a like arrived by a claim, and keeps the instant the heart was first pressed', async () => {
    enable();
    const { id } = await seed();
    const installId = crypto.randomUUID();
    const plain = user('plain');

    await anonLike(id, HOME, installId);
    await like(plain, id, ELSEWHERE);
    const claimer = user('claimer');
    expect((await claim(claimer, installId)).status).toBe(200);

    const rows = await rowsByName(mod(), id);

    // The mark was pressed before the account claimed it, and the row still says when.
    expect(rows[claimer.username].claimedAt).toEqual(expect.any(String));
    expect(rows[claimer.username].likedAt <= rows[claimer.username].claimedAt).toBe(true);
    // A like given as an account carries no claim time, which is how the marker reads as a marker.
    expect(rows[plain.username].claimedAt).toBeNull();
  });
});

describe('removing one address group of marks', () => {
  it('takes that address off the listing and leaves the rest of the number alone', async () => {
    enable();
    const { id } = await seed();

    // The honest mark is at the reader's address, so it is grouped too. The pair from the third address
    // is what a staff member would press, and naming it by the key two marks share is how they would
    // get there — the group number reads down the screen and says nothing about which address it is.
    await like(user('reader'), id, ELSEWHERE);
    await anonLike(id, HOME);
    await anonLike(id, HOME);
    expect((await anonLike(id, ELSEWHERE)).status).toBe(200);

    const moderator = mod();
    const rows = await anonRows(moderator, id);
    const key = rows.find((row) => rows.filter((other) => other.addressKey === row.addressKey).length === 2)
      .addressKey;

    const res = await removeAddress(moderator, id, key);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: 2, likes: 2, anonymous: 1 });
    // The honest mark and the account like are both still there.
    expect(await anonRows(moderator, id)).toHaveLength(1);
  });

  it('takes two presses to clear a group the audit drew across two addresses', async () => {
    enable();
    const { id } = await seed();
    const bridge = user('bridge');

    // One account at both addresses is what makes them one group. The marks never met each other.
    await like(bridge, id, HOME);
    await follow(bridge, user('somebody').id, ELSEWHERE);
    await anonLike(id, HOME);
    await tick();
    await anonLike(id, ELSEWHERE);

    const moderator = mod();
    const [newer, older] = await anonRows(moderator, id);

    expect(newer.groupId).toBe(older.groupId);
    expect(newer.groupId).not.toBeNull();
    // One group on the screen, two addresses under it. Removing by address is why this takes two.
    expect(newer.addressKey).not.toBe(older.addressKey);

    expect((await removeAddress(moderator, id, newer.addressKey)).body.data)
      .toEqual({ removed: 1, likes: 2, anonymous: 1 });
    expect((await removeAddress(moderator, id, older.addressKey)).body.data)
      .toEqual({ removed: 1, likes: 1, anonymous: 0 });
  });

  it('writes one audit entry naming the listing and how many went', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, HOME);
    const moderator = mod();
    const [row] = await anonRows(moderator, id);

    await removeAddress(moderator, id, row.addressKey);

    const entries = await logEntries(moderator, '?action=anonymous_likes_removed');

    expect(entries).toHaveLength(1);
    expect(entries[0].target.name).toBe('Sedge Landing');
    expect(entries[0].snippet).toContain('1');
  });

  it('writes nothing for a key that matches no mark, and answers the counts as they are', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, HOME);
    const moderator = mod();

    const res = await removeAddress(moderator, id, 'a'.repeat(64));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: 0, likes: 1, anonymous: 1 });
    // The log records corrections, not attempts.
    expect(await logEntries(moderator, '?action=anonymous_likes_removed')).toEqual([]);
  });

  it('refuses an ordinary account and a caller with no session, and removes nothing', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, HOME);
    const moderator = mod();
    const [row] = await anonRows(moderator, id);

    expect((await removeAddress(user('ordinary'), id, row.addressKey)).status).toBe(403);
    expect((await removeAddress(null, id, row.addressKey)).status).toBe(401);
    expect(await anonRows(moderator, id)).toHaveLength(1);
  });

  it('answers 404 for a listing that is not there', async () => {
    expect((await removeAddress(mod(), 'no-such-listing', 'a'.repeat(64))).status).toBe(404);
  });
});

describe('removing every mark on a listing', () => {
  it('clears the marks the sweep has already blanked, which no address can reach', async () => {
    enable();
    const { id } = await seed();

    await like(user('reader'), id, ELSEWHERE);
    await anonLike(id, HOME);
    await anonLike(id, ELSEWHERE);
    blankHashes(id);

    const moderator = mod();
    const res = await clearAnonymous(moderator, id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: 2, likes: 1, anonymous: 0 });
    expect(await anonRows(moderator, id)).toEqual([]);
    // The account like is untouched: this clears one half of the number, not the number.
    expect((await audit(moderator, id)).body.data.total).toBe(1);
  });

  it('writes one audit entry naming the listing and how many went', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, HOME);
    await anonLike(id, ELSEWHERE);
    const moderator = mod();

    await clearAnonymous(moderator, id);

    const entries = await logEntries(moderator, '?action=anonymous_likes_cleared');

    expect(entries).toHaveLength(1);
    expect(entries[0].target.name).toBe('Sedge Landing');
    expect(entries[0].snippet).toContain('2');
  });

  it('writes nothing when there was nothing to clear', async () => {
    const { id } = await seed();
    const moderator = mod();

    const res = await clearAnonymous(moderator, id);

    expect(res.body.data).toEqual({ removed: 0, likes: 0, anonymous: 0 });
    expect(await logEntries(moderator, '?action=anonymous_likes_cleared')).toEqual([]);
  });

  it('refuses an ordinary account and a caller with no session, and removes nothing', async () => {
    enable();
    const { id } = await seed();
    await anonLike(id, HOME);

    expect((await clearAnonymous(user('ordinary'), id)).status).toBe(403);
    expect((await clearAnonymous(null, id)).status).toBe(401);
    expect(await anonRows(mod(), id)).toHaveLength(1);
  });

  it('answers 404 for a listing that is not there', async () => {
    expect((await clearAnonymous(mod(), 'no-such-listing')).status).toBe(404);
  });
});
