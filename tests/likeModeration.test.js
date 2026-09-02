import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, seedUsers, seedLikes, authHeader, worldPayload, TINY_PNG } from './helpers.js';

/**
 * Like moderation — telling a popular listing from an inflated one.
 *
 * Staff see who liked a listing and what an account has liked, and can take a like off or clear an
 * account's likes. Everything here goes through the routes a client would use; the audit log is read back
 * through its own route.
 */

const rnd = () => Math.random().toString(36).slice(2, 8);

const user = (name = 'user') => createUser({ username: `${name}-${rnd()}` });
const mod = (name = 'mod') => createUser({ username: `${name}-${rnd()}`, accountType: 'mod' });
const dev = (name = 'dev') => createUser({ username: `${name}-${rnd()}`, accountType: 'dev' });
const admin = (name = 'admin') => createUser({ username: `${name}-${rnd()}`, accountType: 'admin' });

const publish = (author, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload(over));

const like = (who, id, liked = true) =>
  request(app).put(`/api/worlds/${id}/like`).set(authHeader(who)).send({ liked });

const withAuth = (req, who) => (who ? req.set(authHeader(who)) : req);

const likers = (who, id) => withAuth(request(app).get(`/api/worlds/${id}/likes`), who);
const given = (who, id) => withAuth(request(app).get(`/api/users/${id}/likes`), who);
const removeLike = (who, worldId, userId) =>
  withAuth(request(app).delete(`/api/worlds/${worldId}/likes/${userId}`), who);
const clearLikes = (who, userId) => withAuth(request(app).delete(`/api/users/${userId}/likes`), who);

const publicCount = async (id) => (await request(app).get(`/api/worlds/${id}`)).body.data.likes;

const setStatus = (actor, target, status) =>
  request(app).put(`/api/users/${target.id}/status`).set(authHeader(actor)).send({ status });

const quarantine = (actor, id) =>
  request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(actor)).send({});

const entries = async (who, query = '') =>
  (await request(app).get(`/api/audit${query}`).set(authHeader(who))).body.data;

/** Like timestamps carry milliseconds; a pause between two likes keeps their order unambiguous. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** One published listing, its author, and somebody else to do the liking. */
const seed = async (over = {}) => {
  const author = user('author');
  const reader = user('reader');
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;

  return { author, reader, id };
};

describe('who liked this listing', () => {
  it('lists every liker newest first, with every field and the total', async () => {
    const { reader, id } = await seed();
    const later = user('later');
    await like(reader, id);
    await tick();
    await like(later, id);

    const res = await likers(mod(), id);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.rows.map((r) => r.id)).toEqual([later.id, reader.id]);
    expect(res.body.data.rows[0]).toEqual({
      id: later.id,
      username: later.username,
      avatarUrl: null,
      status: 'normal',
      createdAt: expect.any(String),
      likedAt: expect.any(String),
      accountAgeAtLikeSeconds: expect.any(Number)
    });
  });

  it('is open to every staff role', async () => {
    const { reader, id } = await seed();
    await like(reader, id);

    for (const who of [mod(), dev(), admin()]) {
      expect((await likers(who, id)).status).toBe(200);
    }
  });

  it('is refused to an ordinary reader', async () => {
    const { reader, id } = await seed();

    expect((await likers(reader, id)).status).toBe(403);
  });

  it('is refused to the listing author', async () => {
    // Their count stays a count and nothing more: who liked their work is not theirs to know.
    const { author, reader, id } = await seed();
    await like(reader, id);

    expect((await likers(author, id)).status).toBe(403);
  });

  it('is refused to a signed-out visitor', async () => {
    const { id } = await seed();

    expect((await likers(null, id)).status).toBe(401);
  });

  it('says how old the account was when it liked', async () => {
    const { id } = await seed();
    const veteran = createUser({ username: `veteran-${rnd()}`, createdAt: '2026-01-01 00:00:00' });
    await like(veteran, id);

    const [row] = (await likers(mod(), id)).body.data.rows;

    const expected = Math.floor(Date.parse(row.likedAt) / 1000) - Date.parse('2026-01-01T00:00:00Z') / 1000;
    expect(row.createdAt).toBe('2026-01-01 00:00:00');
    expect(row.accountAgeAtLikeSeconds).toBe(expected);
    expect(row.accountAgeAtLikeSeconds).toBeGreaterThan(0);
  });

  it('shows the status a liker has now', async () => {
    const { reader, id } = await seed();
    await like(reader, id);
    await setStatus(admin(), reader, 'suspended');

    const [row] = (await likers(mod(), id)).body.data.rows;

    expect(row.status).toBe('suspended');
  });

  it('carries the liker’s avatar', async () => {
    const { reader, id } = await seed();
    await request(app).put('/api/users/me/avatar').set(authHeader(reader)).send({ image: TINY_PNG });
    await like(reader, id);

    const [row] = (await likers(mod(), id)).body.data.rows;

    expect(row.avatarUrl).toMatch(/^\/api\/avatars\//);
  });

  it('still answers for a quarantined listing', async () => {
    // Hiding a listing must not hide the evidence.
    const { reader, id } = await seed();
    await like(reader, id);
    await quarantine(admin(), id);

    const res = await likers(mod(), id);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('stops at the cap and still reports the true total', async () => {
    const { id } = await seed();
    const crowd = seedUsers(501, `crowd-${rnd()}`);
    seedLikes(id, crowd);

    const { total, rows } = (await likers(mod(), id)).body.data;

    expect(total).toBe(501);
    expect(rows).toHaveLength(500);
    // The newest 500 survive the cut; the oldest like is the one left out.
    expect(rows[0].id).toBe(crowd[500].id);
    expect(rows.map((r) => r.id)).not.toContain(crowd[0].id);
  });

  it('404s a listing that is not there', async () => {
    expect((await likers(mod(), 'no-such-world')).status).toBe(404);
  });
});

describe('what this account liked', () => {
  it('lists every listing newest first, with its author, its quarantine flag and the like time', async () => {
    const one = user('one');
    const two = user('two');
    const reader = user('reader');
    const first = (await publish(one, { name: 'First' })).body.data.id;
    const hidden = (await publish(one, { name: 'Hidden' })).body.data.id;
    const last = (await publish(two, { name: 'Last' })).body.data.id;
    await like(reader, first);
    await tick();
    await like(reader, hidden);
    await tick();
    await like(reader, last);
    await quarantine(admin(), hidden);

    const res = await given(mod(), reader.id);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.rows.map((r) => r.id)).toEqual([last, hidden, first]);
    expect(res.body.data.rows[0]).toEqual({
      id: last,
      name: 'Last',
      authorId: two.id,
      authorUsername: two.username,
      quarantined: false,
      likedAt: expect.any(String)
    });
    expect(res.body.data.rows[1].quarantined).toBe(true);
  });

  it('is refused to an ordinary account, even for its own likes', async () => {
    const { reader, id } = await seed();
    await like(reader, id);

    expect((await given(reader, reader.id)).status).toBe(403);
  });

  it('is refused to a signed-out visitor', async () => {
    const { reader } = await seed();

    expect((await given(null, reader.id)).status).toBe(401);
  });

  it('404s an account that is not there', async () => {
    expect((await given(mod(), 'no-such-user')).status).toBe(404);
  });
});

describe('removing one like', () => {
  it('drops the public count at once', async () => {
    const { reader, id } = await seed();
    await like(reader, id);

    const res = await removeLike(mod(), id, reader.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ likes: 0 });
    expect(await publicCount(id)).toBe(0);
    expect((await likers(mod(), id)).body.data.total).toBe(0);
  });

  it('is idempotent', async () => {
    const { reader, id } = await seed();
    await like(reader, id);
    await removeLike(mod(), id, reader.id);

    const res = await removeLike(mod(), id, reader.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ likes: 0 });
  });

  it('lands in the log as like_removed, naming the listing and the liker', async () => {
    const { reader, id } = await seed();
    const moderator = mod();
    await like(reader, id);

    await removeLike(moderator, id, reader.id);

    const [entry] = await entries(moderator);
    expect(entry).toMatchObject({
      action: 'like_removed',
      actor: { username: moderator.username, role: 'mod' },
      targetUser: { id: reader.id, username: reader.username },
      target: { kind: 'world', name: 'Sedge Landing' }
    });
  });

  it('writes nothing to the log when there was no like to remove', async () => {
    const { reader, id } = await seed();
    const moderator = mod();

    await removeLike(moderator, id, reader.id);

    expect(await entries(moderator)).toEqual([]);
  });

  it('is refused to an ordinary account', async () => {
    const { reader, id } = await seed();
    const other = user('other');
    await like(reader, id);

    expect((await removeLike(other, id, reader.id)).status).toBe(403);
    expect(await publicCount(id)).toBe(1);
  });

  it('is refused to the listing author', async () => {
    const { author, reader, id } = await seed();
    await like(reader, id);

    expect((await removeLike(author, id, reader.id)).status).toBe(403);
    expect(await publicCount(id)).toBe(1);
  });

  it('404s a listing that is not there', async () => {
    expect((await removeLike(mod(), 'no-such-world', user().id)).status).toBe(404);
  });

  it('404s an account that is not there', async () => {
    const { id } = await seed();

    expect((await removeLike(mod(), id, 'no-such-user')).status).toBe(404);
  });

  it('lets a reinstated account like the same listing again', async () => {
    // A removed like is a deleted row, so a past correction does not follow the account forever.
    const { reader, id } = await seed();
    const root = admin();
    await like(reader, id);
    await setStatus(root, reader, 'suspended');
    await removeLike(root, id, reader.id);

    expect((await like(reader, id)).status).toBe(403);

    await setStatus(root, reader, 'normal');
    const res = await like(reader, id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ liked: true, likes: 1 });
  });
});

describe('clearing an account’s likes', () => {
  /** One reader who liked three listings by two authors. */
  const cluster = async () => {
    const reader = user('reader');
    const one = user('one');
    const two = user('two');
    const ids = [
      (await publish(one, { name: 'A' })).body.data.id,
      (await publish(one, { name: 'B' })).body.data.id,
      (await publish(two, { name: 'C' })).body.data.id
    ];
    for (const id of ids) await like(reader, id);

    return { reader, ids };
  };

  it('removes every like and reports how many went', async () => {
    const { reader, ids } = await cluster();

    const res = await clearLikes(mod(), reader.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: 3 });
    for (const id of ids) expect(await publicCount(id)).toBe(0);
    expect((await given(mod(), reader.id)).body.data.total).toBe(0);
  });

  it('is idempotent, with a count of zero', async () => {
    const { reader } = await cluster();
    await clearLikes(mod(), reader.id);

    const res = await clearLikes(mod(), reader.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: 0 });
  });

  it('lands in the log as one likes_cleared entry carrying the count', async () => {
    const { reader } = await cluster();
    const moderator = mod();

    await clearLikes(moderator, reader.id);

    const found = await entries(moderator, '?action=likes_cleared');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      actor: { username: moderator.username },
      targetUser: { id: reader.id, username: reader.username },
      target: { kind: 'account', name: reader.username }
    });
    expect(found[0].snippet).toMatch(/\b3\b/);
    expect(await entries(moderator, '?action=like_removed')).toEqual([]);
  });

  it('writes nothing to the log when there was nothing to clear', async () => {
    const moderator = mod();

    await clearLikes(moderator, user().id);

    expect(await entries(moderator)).toEqual([]);
  });

  it('is refused to an ordinary account', async () => {
    const { reader, ids } = await cluster();

    expect((await clearLikes(user('other'), reader.id)).status).toBe(403);
    expect(await publicCount(ids[0])).toBe(1);
  });

  it('is refused to a signed-out visitor', async () => {
    const { reader } = await cluster();

    expect((await clearLikes(null, reader.id)).status).toBe(401);
  });

  it('404s an account that is not there', async () => {
    expect((await clearLikes(mod(), 'no-such-user')).status).toBe(404);
  });
});

describe('staff moderate the room, not each other', () => {
  it('stops a mod removing a mod’s, a dev’s or an admin’s like', async () => {
    const moderator = mod();

    for (const liker of [mod('m2'), dev(), admin()]) {
      const { id } = await seed();
      await like(liker, id);

      const res = await removeLike(moderator, id, liker.id);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/staff account/i);
      expect(await publicCount(id)).toBe(1);
    }
  });

  it('lets an admin reach a mod and a dev, but not another admin', async () => {
    const root = admin();

    for (const liker of [mod(), dev()]) {
      const { id } = await seed();
      await like(liker, id);

      expect((await removeLike(root, id, liker.id)).status).toBe(200);
      expect(await publicCount(id)).toBe(0);
    }

    const other = admin('other');
    const { id } = await seed();
    await like(other, id);

    expect((await removeLike(root, id, other.id)).status).toBe(403);
    expect(await publicCount(id)).toBe(1);
  });

  it('says the same thing whether or not there was a like to remove', async () => {
    // Whether a staff account liked something is not a moderator's to learn by probing.
    const { id } = await seed();
    const root = admin();

    const res = await removeLike(mod(), id, root.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/staff account/i);
  });

  it('applies the same ladder to clearing an account', async () => {
    const { id } = await seed();
    const developer = dev();
    await like(developer, id);

    const refused = await clearLikes(mod(), developer.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/staff account/i);
    expect(await publicCount(id)).toBe(1);

    const allowed = await clearLikes(admin(), developer.id);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toEqual({ removed: 1 });

    expect((await clearLikes(admin(), admin('other').id)).status).toBe(403);
  });
});
