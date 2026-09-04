import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { DAY_MS } = require('../src/config/time');

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
    expect(res.body.data).toEqual({ total: 0, rows: [] });
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
  it('writes one entry per call, naming the listing and its author', async () => {
    const { author, id } = await seed();
    const moderator = mod();
    await like(user('sock'), id, HOME);

    await audit(moderator, id);

    const [entry] = await logEntries(moderator, '?action=signals_viewed');
    expect(entry).toMatchObject({
      action: 'signals_viewed',
      actor: { username: moderator.username, role: 'mod' },
      targetUser: { id: author.id, username: author.username },
      target: { kind: 'world', name: 'Sedge Landing' }
    });
  });

  it('writes a second entry on a second look, so going back is recorded too', async () => {
    const { id } = await seed();
    const moderator = mod();

    await audit(moderator, id);
    await audit(moderator, id);

    expect(await logEntries(moderator, '?action=signals_viewed')).toHaveLength(2);
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
