import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * The badge beside a name in the catalog.
 *
 * Every author DTO the catalog hands out carries it, because a reader who sees "Mod" on a feedback reply
 * and nothing on the same person's listing has no way to tell which one is telling the truth. It is a
 * live read rather than a snapshot: unlike a feedback reply, a listing is not a record of a moment.
 */

const publish = (user, overrides) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(overrides));

const comment = (user, worldId, body) =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content: body });

describe('a listing’s author', () => {
  it('wears their badge in the catalog', async () => {
    const staff = createUser({ accountType: 'mod' });
    await publish(staff, { name: 'Sedge Landing' });

    const res = await request(app).get('/api/worlds');

    const listing = res.body.data.find((w) => w.name === 'Sedge Landing');
    expect(listing.author.role).toBe('mod');
  });

  it('wears it on the listing itself, not only in the list', async () => {
    // Two different DTOs; the detail view is where somebody actually reads the author's name.
    const staff = createUser({ accountType: 'admin' });
    const { body } = await publish(staff, { name: 'Sedge Landing' });

    const res = await request(app).get(`/api/worlds/${body.data.id}`);

    expect(res.body.data.author.role).toBe('admin');
  });

  it('wears none when they are an ordinary author', async () => {
    const author = createUser({ accountType: 'normal' });
    const { body } = await publish(author, { name: 'Quiet World' });

    const res = await request(app).get(`/api/worlds/${body.data.id}`);

    expect(res.body.data.author.role).toBeNull();
  });

  it('changes with the account, since the badge says who they are now', async () => {
    // A snapshot would leave a former mod badged forever, and a new one badged nowhere.
    const author = createUser({ accountType: 'normal' });
    const admin = createUser({ accountType: 'admin' });
    const { body } = await publish(author, { name: 'Promoted Later' });

    const promoted = await request(app).put(`/api/users/${author.id}/status`)
      .set(authHeader(admin)).send({ accountType: 'mod' });
    expect(promoted.status).toBe(200);

    const res = await request(app).get(`/api/worlds/${body.data.id}`);
    expect(res.body.data.author.role).toBe('mod');
  });

  it('does not leak the raw column alongside it', async () => {
    const staff = createUser({ accountType: 'dev' });
    await publish(staff, { name: 'No Leak' });

    const listing = (await request(app).get('/api/worlds')).body.data.find((w) => w.name === 'No Leak');

    expect(listing.author_account_type).toBeUndefined();
    expect(listing.account_type).toBeUndefined();
  });
});

describe('a comment’s author', () => {
  it('wears their badge in the thread', async () => {
    const author = createUser();
    const staff = createUser({ accountType: 'dev' });
    const { body } = await publish(author, { name: 'Commented On' });
    await comment(staff, body.data.id, 'Looks good to me.');

    const res = await request(app).get(`/api/worlds/${body.data.id}/comments`);

    expect(res.body.data[0].author.role).toBe('dev');
  });

  it('wears none when an ordinary reader replies', async () => {
    const author = createUser();
    const reader = createUser({ accountType: 'normal' });
    const { body } = await publish(author, { name: 'Also Commented On' });
    await comment(reader, body.data.id, 'Nice work.');

    const res = await request(app).get(`/api/worlds/${body.data.id}/comments`);

    expect(res.body.data[0].author.role).toBeNull();
  });
});
