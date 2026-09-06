import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

/**
 * The public face of an account — what a stranger sees when they click a name in a thread or on a
 * listing. The whole point is that it carries the few things anybody may see and nothing else: the
 * email, the status and the account type belong to the admin table.
 */

const profile = (id, viewer) => {
  const r = request(app).get(`/api/users/${id}/profile`);
  return viewer ? r.set(authHeader(viewer)) : r;
};

describe('reading somebody’s profile', () => {
  it('gives their name, their picture and when they signed up', async () => {
    const user = createUser({ username: 'wren_hallow' });
    const url = (await request(app).put('/api/users/me/avatar').set(authHeader(user)).send({ image: TINY_PNG }))
      .body.data.avatarUrl;

    const res = await profile(user.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, username: 'wren_hallow', avatarUrl: url });
    expect(res.body.data.createdAt).toBeTruthy();
  });

  it('is public, since the catalog and its comments are', async () => {
    // A signed-out visitor can already read the name beside the picture; gating this would leave them
    // with a name they cannot click.
    const user = createUser();

    expect((await profile(user.id)).status).toBe(200);
  });

  it('says nothing an account has not chosen to show', async () => {
    // The email and the status are the admin table's, not a stranger's. The role is not private — it is
    // the badge — but it is normalized, so nothing here leaks whether an ordinary account exists.
    const user = createUser({ username: 'osk_tinder', email: 'osk@example.test', accountType: 'mod', status: 'flagged' });

    const { data } = (await profile(user.id)).body;

    expect(Object.keys(data).sort()).toEqual([
      'avatarUrl', 'createdAt', 'downloads', 'followers', 'id', 'likes', 'role', 'username'
    ]);
  });

  it('carries the badge, so it matches the one beside their name', async () => {
    const user = createUser({ accountType: 'mod' });

    expect((await profile(user.id)).body.data.role).toBe('mod');
  });

  it('has no badge for an ordinary account', async () => {
    // Null rather than 'normal': a reader should not have to know the word to decide there is no badge.
    const user = createUser({ accountType: 'normal' });

    expect((await profile(user.id)).body.data.role).toBeNull();
  });

  it('says how many follow them, but never who', async () => {
    const author = createUser();
    const reader = createUser();
    await request(app).put(`/api/users/${author.id}/follow`).set(authHeader(reader));

    const { data } = (await profile(author.id)).body;

    expect(data.followers).toBe(1);
    expect(JSON.stringify(data)).not.toContain(reader.username);
  });

  it('tells a signed-in reader whether they follow them', async () => {
    const author = createUser();
    const reader = createUser();

    expect((await profile(author.id, reader)).body.data.following).toBe(false);

    await request(app).put(`/api/users/${author.id}/follow`).set(authHeader(reader));

    expect((await profile(author.id, reader)).body.data.following).toBe(true);
  });

  it('leaves that unanswered for a signed-out visitor', async () => {
    // Absent rather than false: somebody with no account has not decided not to follow anybody.
    const author = createUser();

    expect((await profile(author.id)).body.data.following).toBeUndefined();
  });

  it('is null for a picture nobody has set', async () => {
    const user = createUser();

    expect((await profile(user.id)).body.data.avatarUrl).toBeNull();
  });

  it('404s an account that is not there', async () => {
    expect((await profile('no-such-user')).status).toBe(404);
  });

  it('answers a suspended account the way it answers an unknown id', async () => {
    const user = createUser({ status: 'suspended' });

    const suspended = await profile(user.id);
    const unknown = await profile('no-such-user');

    expect(suspended.status).toBe(unknown.status);
    expect(suspended.text).toBe(unknown.text);
  });

  it('does not show a suspended account to an ordinary signed-in reader', async () => {
    const user = createUser({ status: 'suspended' });
    const reader = createUser();

    expect((await profile(user.id, reader)).status).toBe(404);
  });
});

/**
 * What an author's published work adds up to.
 *
 * Counted over the catalog rather than over what the reader may see: a total that moved with who was
 * asking would make an author's own profile disagree with the one they hand somebody else.
 */
describe('the totals on a profile', () => {
  const publish = (user, over = {}) =>
    request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

  const like = (user, id) =>
    request(app).put(`/api/worlds/${id}/like`).set(authHeader(user)).send({ liked: true });

  const download = (id) => request(app).get(`/api/worlds/${id}/content`);

  const author = () => createUser({ username: `author-${Math.random().toString(36).slice(2, 8)}` });
  const reader = () => createUser({ username: `reader-${Math.random().toString(36).slice(2, 8)}` });

  it('is zeros for somebody who has published nothing', async () => {
    // The row always renders, so the popup keeps its shape whoever is in it.
    const res = await profile(author().id);

    expect(res.body.data).toMatchObject({ likes: 0, downloads: 0 });
  });

  it('adds up the likes across everything they published', async () => {
    const them = author();
    const a = reader();
    const b = reader();
    const one = (await publish(them, { name: 'One' })).body.data.id;
    const two = (await publish(them, { name: 'Two', kind: 'entity' })).body.data.id;
    await like(a, one);
    await like(b, one);
    await like(a, two);

    expect((await profile(them.id)).body.data.likes).toBe(3);
  });

  it('adds up the downloads the same way', async () => {
    const them = author();
    const one = (await publish(them, { name: 'One' })).body.data.id;
    const two = (await publish(them, { name: 'Two' })).body.data.id;
    await download(one);
    await download(one);
    await download(two);

    expect((await profile(them.id)).body.data.downloads).toBe(3);
  });

  it('counts nobody else’s work toward them', async () => {
    const them = author();
    const other = author();
    const fan = reader();
    await publish(them, { name: 'Mine' });
    const theirs = (await publish(other, { name: 'Theirs' })).body.data.id;
    await like(fan, theirs);
    await download(theirs);

    expect((await profile(them.id)).body.data).toMatchObject({ likes: 0, downloads: 0 });
  });

  it('leaves quarantined work out', async () => {
    const root = createUser({ username: `root-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });
    const them = author();
    const fan = reader();
    const hidden = (await publish(them, { name: 'Hidden' })).body.data.id;
    await like(fan, hidden);
    await download(hidden);
    await request(app).put(`/api/worlds/${hidden}/quarantine`).set(authHeader(root)).send({});

    expect((await profile(them.id)).body.data).toMatchObject({ likes: 0, downloads: 0 });
  });

  it('says the same thing to the author as to a stranger', async () => {
    // The point of counting over the catalog: their own hidden work still shows in the list below with
    // its own numbers, but it must not make their totals read higher to themselves than to anyone else.
    const root = createUser({ username: `root2-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });
    const them = author();
    const fan = reader();
    const shown = (await publish(them, { name: 'Shown' })).body.data.id;
    const hidden = (await publish(them, { name: 'Hidden' })).body.data.id;
    await like(fan, shown);
    await like(fan, hidden);
    await request(app).put(`/api/worlds/${hidden}/quarantine`).set(authHeader(root)).send({});

    expect((await profile(them.id, them)).body.data.likes).toBe(1);
    expect((await profile(them.id)).body.data.likes).toBe(1);
  });
});
