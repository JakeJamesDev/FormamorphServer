import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Following somebody, and what it gets you.
 *
 * There is no notifications table: a feed row is a listing, joined to the follows table and filtered by
 * when the follow started. Everything worth guarding falls out of that — repeated updates are one row,
 * following somebody does not dump their back catalogue, and nothing has to be cleaned up afterwards.
 */

const follow = (reader, authorId) =>
  request(app).put(`/api/users/${authorId}/follow`).set(authHeader(reader));

const unfollow = (reader, authorId) =>
  request(app).delete(`/api/users/${authorId}/follow`).set(authHeader(reader));

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const feed = (reader) => request(app).get('/api/users/me/notifications').set(authHeader(reader));

const unread = async (reader) =>
  (await request(app).get('/api/users/me/notifications/unread-count').set(authHeader(reader))).body.unread;

const followingList = (reader) => request(app).get('/api/users/me/following').set(authHeader(reader));

/** Move a follow into the past, so a listing published "now" counts as after it. */
const backdateFollow = (readerId, authorId, at = '2020-01-01T00:00:00.000Z') =>
  db.prepare('UPDATE follows SET created_at = ? WHERE follower_id = ? AND followed_id = ?')
    .run(at, readerId, authorId);

describe('following an account', () => {
  it('takes, and says so', async () => {
    const author = createUser();
    const reader = createUser();

    const res = await follow(reader, author.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ following: true, followers: 1 });
  });

  it('is idempotent, and keeps the original date', async () => {
    // Re-following must not reset the window — that would hide everything published in between.
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    const first = db.prepare('SELECT created_at FROM follows WHERE follower_id = ?').get(reader.id).created_at;

    await follow(reader, author.id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM follows').get().n).toBe(1);
    expect(db.prepare('SELECT created_at FROM follows WHERE follower_id = ?').get(reader.id).created_at).toBe(first);
  });

  it('refuses to follow yourself, which would put your own work in your own news', async () => {
    const user = createUser();

    const res = await follow(user, user.id);

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM follows').get().n).toBe(0);
  });

  it('404s an account that is not there', async () => {
    expect((await follow(createUser(), 'no-such-user')).status).toBe(404);
  });

  it('turns away somebody with no account', async () => {
    const author = createUser();

    expect((await request(app).put(`/api/users/${author.id}/follow`)).status).toBe(401);
  });

  it('refuses a suspended account, like every other write', async () => {
    const author = createUser();
    const reader = createUser({ status: 'suspended' });

    expect((await follow(reader, author.id)).status).toBe(403);
  });
});

describe('unfollowing', () => {
  it('removes it and drops the count', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);

    const res = await unfollow(reader, author.id);

    expect(res.body.data).toMatchObject({ following: false, followers: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM follows').get().n).toBe(0);
  });

  it('is fine when there was nothing to remove', async () => {
    // Nothing to undo, and an error would strand a client whose state had drifted.
    const author = createUser();

    expect((await unfollow(createUser(), author.id)).status).toBe(200);
  });
});

describe('the list of who you follow', () => {
  it('is yours, newest first', async () => {
    const reader = createUser();
    const first = createUser({ username: 'wren_hallow' });
    const second = createUser({ username: 'osk_tinder' });
    await follow(reader, first.id);
    db.prepare("UPDATE follows SET created_at = '2020-01-01T00:00:00.000Z' WHERE followed_id = ?").run(first.id);
    await follow(reader, second.id);

    const res = await followingList(reader);

    expect(res.body.data.map((u) => u.username)).toEqual(['osk_tinder', 'wren_hallow']);
  });

  it('carries their picture, so the list reads like the rest of the app', async () => {
    const reader = createUser();
    const author = createUser();
    await follow(reader, author.id);

    expect(followingList(reader).then((r) => r.body.data[0])).resolves.toHaveProperty('avatarUrl');
  });

  it('is empty for somebody who follows nobody', async () => {
    expect((await followingList(createUser())).body.data).toEqual([]);
  });
});

describe('the feed', () => {
  it('carries what somebody published after you followed them', async () => {
    const author = createUser({ username: 'wren_hallow' });
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });

    const res = await feed(reader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Sedge Landing', event: 'published' });
    expect(res.body.data[0].author.username).toBe('wren_hallow');
  });

  it('does not hand you their back catalogue for following them', async () => {
    // Following somebody is an interest in what they do next, not a request for everything they ever did.
    const author = createUser();
    await publish(author, { name: 'Old Work' });
    const reader = createUser();

    await follow(reader, author.id);

    expect((await feed(reader)).body.data).toHaveLength(0);
  });

  it('reads an old listing revised today as an update, not as news', async () => {
    const author = createUser();
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;
    db.prepare("UPDATE worlds SET created_at = '2019-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    // The listing predates the follow; touching it is what puts it in the feed.
    await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send(worldPayload({ name: 'Sedge Landing' }));

    const res = await feed(reader);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].event).toBe('updated');
  });

  it('sees a listing written before timestamps were stored as ISO', async () => {
    // Every row in production predating that fix holds SQLite's own `2026-08-01 09:00:00`. Compared as
    // raw strings against an ISO follow date, a space sorts below a `T` — so those listings would be
    // invisible to their followers for the rest of the day, which is not a fact about time.
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    const id = (await publish(author, { name: 'Legacy Listing' })).body.data.id;
    db.prepare("UPDATE follows SET created_at = '2026-08-01T08:00:00.000Z' WHERE follower_id = ?").run(reader.id);
    db.prepare("UPDATE worlds SET created_at = '2026-08-01 09:00:00', updated_at = '2026-08-01 09:00:00' WHERE id = ?").run(id);

    const res = await feed(reader);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Legacy Listing');
  });

  it('is one row per listing however many times it is updated', async () => {
    // The whole reason there is no notifications table: an author cannot flood anybody by republishing.
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;

    for (let i = 0; i < 4; i++) {
      await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send(worldPayload({ name: 'Sedge Landing' }));
    }

    expect((await feed(reader)).body.data).toHaveLength(1);
  });

  it('carries nothing from accounts you do not follow', async () => {
    const stranger = createUser();
    const reader = createUser();
    await publish(stranger, { name: 'Not Yours' });

    expect((await feed(reader)).body.data).toHaveLength(0);
  });

  it('drops a listing that has been quarantined', async () => {
    // Out of circulation everywhere else; a feed row pointing at a 404 is worse than no row.
    const author = createUser();
    const reader = createUser();
    const moderator = createUser({ accountType: 'admin' });
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;
    expect((await feed(reader)).body.data).toHaveLength(1);

    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(moderator)).send({ days: 3 });

    expect((await feed(reader)).body.data).toHaveLength(0);
  });

  it('drops a listing that has been deleted', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author));

    expect((await feed(reader)).body.data).toHaveLength(0);
  });

  it('empties when you unfollow them', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });

    await unfollow(reader, author.id);

    expect((await feed(reader)).body.data).toHaveLength(0);
  });

  it('carries every kind, not only worlds', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Ilsa of the Weir', kind: 'entity' });

    const res = await feed(reader);

    expect(res.body.data[0]).toMatchObject({ name: 'Ilsa of the Weir', kind: 'entity' });
  });

  it('turns away somebody with no account', async () => {
    expect((await request(app).get('/api/users/me/notifications')).status).toBe(401);
  });
});

describe('what is new', () => {
  it('counts what has arrived since the feed was last opened', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });

    expect(await unread(reader)).toBe(1);
  });

  it('clears when the feed is read, since the feed is the notification', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });

    await feed(reader);

    expect(await unread(reader)).toBe(0);
  });

  it('reports what was new at the moment it was opened, not after', async () => {
    // Stamping first would hand back a feed that says nothing is new while showing three new things.
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });

    expect((await feed(reader)).body.unread).toBe(1);
  });

  it('comes back when something new happens after that', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Sedge Landing' });
    await feed(reader);

    await publish(author, { name: 'The Long Tally' });

    expect(await unread(reader)).toBe(1);
  });

  it('is nothing for somebody who follows nobody', async () => {
    expect(await unread(createUser())).toBe(0);
  });
});

describe('when an account goes', () => {
  it('takes its follows with it, both ways', async () => {
    const author = createUser();
    const reader = createUser();
    await follow(reader, author.id);

    db.prepare('DELETE FROM users WHERE id = ?').run(author.id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM follows').get().n).toBe(0);
  });
});

describe('the badge in the feed', () => {
  it('says a row was published by somebody on the team', async () => {
    // The same badge the catalog shows. A feed that drops it makes the team anonymous in the one place
    // a reader has subscribed to hear from them.
    const staff = createUser({ accountType: 'dev' });
    const reader = createUser();
    await follow(reader, staff.id);
    backdateFollow(reader.id, staff.id);
    await publish(staff, { name: 'Sedge Landing' });

    const { data } = (await feed(reader)).body;

    expect(data[0].author.role).toBe('dev');
  });

  it('carries none for an ordinary author', async () => {
    const author = createUser({ accountType: 'normal' });
    const reader = createUser();
    await follow(reader, author.id);
    backdateFollow(reader.id, author.id);
    await publish(author, { name: 'Quiet World' });

    expect((await feed(reader)).body.data[0].author.role).toBeNull();
  });

  it('shows on the list of who you follow', async () => {
    const staff = createUser({ accountType: 'admin' });
    const reader = createUser();
    await follow(reader, staff.id);

    expect((await followingList(reader)).body.data[0].role).toBe('admin');
  });

  it('does not leak the raw column into either list', async () => {
    const staff = createUser({ accountType: 'mod' });
    const reader = createUser();
    await follow(reader, staff.id);
    backdateFollow(reader.id, staff.id);
    await publish(staff, { name: 'No Leak' });

    expect((await followingList(reader)).body.data[0].account_type).toBeUndefined();
    expect((await feed(reader)).body.data[0].author.author_account_type).toBeUndefined();
  });
});
