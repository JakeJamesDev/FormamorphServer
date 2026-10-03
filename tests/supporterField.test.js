import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');

/**
 * The `supporter` field on every author object.
 *
 * The server decides who shows flair, and reads it live on every path: a missed path would show flair the
 * member turned off. Each account state runs against each payload path.
 */

const SINCE = '2026-03-01T00:00:00.000+00:00';

const linkAs = (user, tier, pledgeStart = SINCE) => PatreonLink.link({
  userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart, checkedAt: new Date().toISOString()
});

const setFlair = (user, showFlair) =>
  request(app).patch('/api/users/me/patreon').set(authHeader(user)).send({ showFlair });

/** Each account state: how to make it, and the `supporter` every payload must carry. */
const STATES = [
  { name: 'no link', make: () => createUser(), expected: null },
  { name: 'no tier', make: () => { const u = createUser(); linkAs(u, null, null); return u; }, expected: null },
  {
    name: 'Supporter',
    make: () => { const u = createUser(); linkAs(u, 'supporter'); return u; },
    expected: { tier: 'supporter', since: SINCE }
  },
  {
    name: 'Supporter+',
    make: () => { const u = createUser(); linkAs(u, 'supporter_plus'); return u; },
    expected: { tier: 'supporter_plus', since: SINCE }
  },
  {
    name: 'Supporter with no pledge start',
    make: () => { const u = createUser(); linkAs(u, 'supporter', null); return u; },
    expected: { tier: 'supporter', since: null }
  },
  {
    name: 'toggle off',
    make: async () => {
      const u = createUser();
      linkAs(u, 'supporter_plus');
      expect((await setFlair(u, false)).status).toBe(200);
      return u;
    },
    expected: null
  },
  ...['mod', 'dev', 'admin'].map((accountType) => ({
    name: `${accountType} supporter`,
    make: () => { const u = createUser({ accountType }); linkAs(u, 'supporter_plus'); return u; },
    expected: null
  }))
];

const publish = async (user) => {
  const res = await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload());
  expect(res.status).toBe(201);
  return res.body.data.id;
};

const fileFeedback = async (user) => {
  const res = await request(app).post('/api/feedback').set(authHeader(user))
    .send({ title: 'Save button does nothing', category: 'crash', body: 'Pressing save just spins.' });
  expect(res.status).toBe(201);
  return res.body.data.id;
};

/** Each payload path: given the account, the author object a reader receives. */
const PATHS = {
  'listing in the catalog': async (user) => {
    const id = await publish(user);
    return (await request(app).get('/api/worlds')).body.data.find((w) => w.id === id).author;
  },
  'listing detail': async (user) => {
    const id = await publish(user);
    return (await request(app).get(`/api/worlds/${id}`)).body.data.author;
  },
  'comment as posted': async (user) => {
    const id = await publish(createUser());
    return (await request(app).post(`/api/worlds/${id}/comments`).set(authHeader(user))
      .send({ content: 'Nice work.' })).body.data.author;
  },
  'comment in the thread': async (user) => {
    const id = await publish(createUser());
    await request(app).post(`/api/worlds/${id}/comments`).set(authHeader(user)).send({ content: 'Nice work.' });
    return (await request(app).get(`/api/worlds/${id}/comments`)).body.data[0].author;
  },
  'following list': async (user) => {
    const reader = createUser();
    await request(app).put(`/api/users/${user.id}/follow`).set(authHeader(reader));
    return (await request(app).get('/api/users/me/following').set(authHeader(reader))).body.data[0];
  },
  'follow feed': async (user) => {
    const reader = createUser();
    await request(app).put(`/api/users/${user.id}/follow`).set(authHeader(reader));
    await publish(user);
    return (await request(app).get('/api/users/me/notifications').set(authHeader(reader))).body.data[0].author;
  },
  'feedback reporter': async (user) => {
    const id = await fileFeedback(user);
    return (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body.data.reporter;
  },
  'feedback reply': async (user) => {
    const id = await fileFeedback(user);
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body: 'Still broken.' });
    return (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body.comments[0].author;
  },
  'profile by id': async (user) => (await request(app).get(`/api/users/${user.id}/profile`)).body.data,
  'profile by username': async (user) =>
    (await request(app).get(`/api/users/by-username/${user.username}/profile`)).body.data
};

describe.each(STATES)('an author with $name', ({ make, expected }) => {
  it.each(Object.keys(PATHS))('carries the right supporter on the %s', async (path) => {
    const author = await PATHS[path](await make());

    expect(author).toHaveProperty('supporter');
    expect(author.supporter).toEqual(expected);
  });
});

describe('a live read', () => {
  it("drops a lapsed supporter's flair from an old feedback reply and keeps the role snapshot", async () => {
    const user = createUser({ accountType: 'mod' });
    const id = await fileFeedback(user);
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body: 'Noted.' });
    db.prepare("UPDATE users SET account_type = 'normal' WHERE id = ?").run(user.id);
    linkAs(user, 'supporter');

    // A former mod whose old reply still wears the mod badge shows only that badge.
    const before = (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body.comments[0].author;
    expect(before).toMatchObject({ role: 'mod', supporter: null });

    // A new reply carries no staff badge, so the flair shows.
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body: 'Fixed?' });
    const thread = (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body;
    expect(thread.comments[1].author).toMatchObject({ role: null, supporter: { tier: 'supporter', since: SINCE } });

    linkAs(user, null, null);
    const lapsed = (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body;
    expect(lapsed.comments[1].author).toMatchObject({ role: null, supporter: null });
    expect(lapsed.comments[0].author.role).toBe('mod');
  });

  it('keeps the flair on a reply snapshotted as normal after a promotion to staff', async () => {
    // The badge the payload shows decides, so a name never carries both badges.
    const user = createUser();
    linkAs(user, 'supporter');
    const id = await fileFeedback(user);
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body: 'Still broken.' });
    db.prepare("UPDATE users SET account_type = 'dev' WHERE id = ?").run(user.id);

    const thread = (await request(app).get(`/api/feedback/${id}`).set(authHeader(user))).body;
    const flair = { role: null, supporter: { tier: 'supporter', since: SINCE } };

    expect(thread.comments[0].author).toMatchObject(flair);
    expect(thread.data.reporter).toMatchObject(flair);
    expect((await PATHS['profile by id'](user))).toMatchObject({ role: 'dev', supporter: null });
  });

  it('shows the flair again when the toggle goes back on', async () => {
    const user = createUser();
    linkAs(user, 'supporter');
    await setFlair(user, false);
    await setFlair(user, true);

    expect((await PATHS['profile by id'](user)).supporter).toEqual({ tier: 'supporter', since: SINCE });
  });
});

describe('the flair toggle route', () => {
  it('sets the toggle and answers the status', async () => {
    const user = createUser();
    linkAs(user, 'supporter');

    const res = await setFlair(user, false);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linked: true, tier: 'supporter', since: SINCE, showFlair: false });
    expect((await request(app).get('/api/users/me/patreon').set(authHeader(user))).body.data.showFlair).toBe(false);
  });

  it('refuses an account with no link', async () => {
    const res = await setFlair(createUser(), false);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATREON_NOT_LINKED');
  });

  it.each([undefined, 'false', 0, null])('refuses a showFlair of %s', async (showFlair) => {
    const user = createUser();
    linkAs(user, 'supporter');

    expect((await setFlair(user, showFlair)).status).toBe(400);
    expect((await request(app).get('/api/users/me/patreon').set(authHeader(user))).body.data.showFlair).toBe(true);
  });

  it('is refused to a signed-out visitor', async () => {
    expect((await request(app).patch('/api/users/me/patreon').send({ showFlair: false })).status).toBe(401);
  });

  it("changes only the caller's own link", async () => {
    const user = createUser();
    const other = createUser();
    linkAs(user, 'supporter');
    linkAs(other, 'supporter');

    await setFlair(user, false);

    expect((await PATHS['profile by id'](other)).supporter).toEqual({ tier: 'supporter', since: SINCE });
  });
});

describe('the field is additive', () => {
  it('leaves the existing author fields as they were', async () => {
    const user = createUser({ username: 'additive-author' });
    linkAs(user, 'supporter');

    const author = await PATHS['listing detail'](user);

    expect(Object.keys(author)).toEqual(['id', 'username', 'avatarUrl', 'role', 'supporter']);
    expect(author).toMatchObject({ id: user.id, username: 'additive-author', avatarUrl: null, role: null });
  });
});
