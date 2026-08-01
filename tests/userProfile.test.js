import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, TINY_PNG } from './helpers.js';

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
    // The email, the status and the account type are the admin table's, not a stranger's.
    const user = createUser({ username: 'osk_tinder', email: 'osk@example.test', accountType: 'mod', status: 'suspended' });

    const { data } = (await profile(user.id)).body;

    expect(Object.keys(data).sort()).toEqual(['avatarUrl', 'createdAt', 'id', 'username']);
  });

  it('is null for a picture nobody has set', async () => {
    const user = createUser();

    expect((await profile(user.id)).body.data.avatarUrl).toBeNull();
  });

  it('404s an account that is not there', async () => {
    expect((await profile('no-such-user')).status).toBe(404);
  });
});
