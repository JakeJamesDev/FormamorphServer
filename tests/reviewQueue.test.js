import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * The review queue for new listings: what mods see waiting, and what approving or rejecting one does to
 * what a player, the author and staff get back afterwards.
 */

const as = (req, user) => (user ? req.set(authHeader(user)) : req);
const tag = () => Math.random().toString(16).slice(2, 8);

const admin = () => createUser({ username: `admin-${tag()}`, accountType: 'admin' });
const mod = () => createUser({ username: `mod-${tag()}`, accountType: 'mod' });
const person = (name) => createUser({ username: `${name}-${tag()}` });

const setReview = (value) =>
  request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value });

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const queue = (user) => as(request(app).get('/api/reviews'), user);
const count = (user) => as(request(app).get('/api/reviews/count'), user);
const content = (id, user) => as(request(app).get(`/api/reviews/${id}/content`), user);
const approve = (id, user) => as(request(app).post(`/api/reviews/${id}/approve`), user);
const reject = (id, user, body = {}) => as(request(app).post(`/api/reviews/${id}/reject`), user).send(body);
const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);
const catalog = (user) => as(request(app).get('/api/worlds'), user);
const auditOf = (action) => request(app).get(`/api/audit?action=${action}`).set(authHeader(admin()));

const ids = (rows) => rows.map((row) => row.id);
const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const contest = () => Event.create({
  type: 'contest',
  title: 'Sedge Landing Contest',
  bannerText: 'Build on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  startsAt: at(-60),
  endsAt: at(60)
});

/** Turn review on, then publish one pending listing from a normal author. */
const seedPending = async (over = {}) => {
  await setReview(true);
  const author = person('author');
  const res = await publish(author, { name: 'Sedge Landing', ...over });
  expect(res.status).toBe(201);
  return { author, id: res.body.data.id, player: person('player'), staff: mod() };
};

const queuedAt = (id, iso) => db.prepare('UPDATE worlds SET moderation_queued_at = ? WHERE id = ?').run(iso, id);

describe('the review queue', () => {
  it('lists a waiting new listing with what a mod needs to pick it up', async () => {
    const { author, id, staff } = await seedPending();

    const res = await queue(staff);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({
      id,
      kind: 'world',
      name: 'Sedge Landing',
      type: 'new',
      author: expect.objectContaining({ id: author.id, username: author.username }),
      contest: null
    })]);
    expect(res.body.data[0].queuedAt).toBeTruthy();
  });

  it('holds only what waits: no staff upload, nothing published with review off', async () => {
    const staff = mod();
    await publish(person('early'), { name: 'Before Review' });
    const { id } = await seedPending();
    await publish(staff, { name: 'Staff Landing' });

    expect(ids((await queue(staff)).body.data)).toEqual([id]);
    expect((await count(staff)).body.data).toEqual({ count: 1 });
  });

  it('puts contest entries first, then the longest-waiting', async () => {
    const event = contest();
    const staff = mod();
    await setReview(true);
    const newest = (await publish(person('a'), { name: 'Newest' })).body.data.id;
    const oldest = (await publish(person('b'), { name: 'Oldest' })).body.data.id;
    const entry = (await publish(person('c'), { name: 'Entry', contestEventId: event.id })).body.data.id;
    queuedAt(oldest, '2026-01-01T00:00:00.000Z');
    queuedAt(newest, '2026-02-01T00:00:00.000Z');
    queuedAt(entry, '2026-03-01T00:00:00.000Z');

    const rows = (await queue(staff)).body.data;

    expect(ids(rows)).toEqual([entry, oldest, newest]);
    expect(rows[0].contest).toEqual({ id: event.id, title: 'Sedge Landing Contest' });
  });

  it('is staff-only, and counts the same items it lists', async () => {
    const { author, player, staff } = await seedPending();
    await publish(person('second'));

    expect((await queue(player)).status).toBe(403);
    expect((await queue(author)).status).toBe(403);
    expect((await queue(null)).status).toBe(401);
    expect((await count(player)).status).toBe(403);
    expect((await count(staff)).body.data.count).toBe((await queue(staff)).body.data.length);
  });
});

describe('the waiting content', () => {
  it('reaches staff and the author, and counts no download', async () => {
    const { author, id, staff } = await seedPending();

    const read = await content(id, staff);
    expect(read.status).toBe(200);
    expect(read.body.data.contentData).toBeTruthy();
    expect((await content(id, author)).status).toBe(200);

    expect((await readOne(id, author)).body.data.downloads).toBe(0);
  });

  it('answers 404 to a player, as if nothing were there', async () => {
    const { id, player } = await seedPending();

    expect((await content(id, player)).status).toBe(404);
    expect((await content(id, null)).status).toBe(401);
  });

  it('answers 404 once nothing waits', async () => {
    const { id, staff } = await seedPending();
    await approve(id, staff);

    expect((await content(id, staff)).status).toBe(404);
  });
});

describe('approving a new listing', () => {
  it('puts it live for a player, in the catalog, as listed and updated now', async () => {
    const { author, id, player, staff } = await seedPending();
    const before = Date.now();

    const res = await approve(id, staff);

    expect(res.status).toBe(200);
    expect((await readOne(id, player)).status).toBe(200);
    expect(ids((await catalog(player)).body.data)).toContain(id);
    const own = (await readOne(id, author)).body.data;
    expect(own.moderation_state).toBe('approved');
    expect(Date.parse(own.listed_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(own.updated_at)).toBeGreaterThanOrEqual(before);
    expect((await count(staff)).body.data.count).toBe(0);
  });

  it('logs the approval with the listing id', async () => {
    const { id, staff } = await seedPending();
    await approve(id, staff);

    const log = (await auditOf('listing_approved')).body.data;
    expect(log).toHaveLength(1);
    expect(log[0].target).toMatchObject({ id, name: 'Sedge Landing' });
  });

  it('reaches a follower\'s feed as published news, though it was submitted before the follow', async () => {
    const { author, id, staff } = await seedPending();
    const follower = person('follower');
    await request(app).put(`/api/users/${author.id}/follow`).set(authHeader(follower));
    // Submitted a day before the follow began; approved after.
    db.prepare('UPDATE worlds SET created_at = ? WHERE id = ?').run(at(-24 * 60), id);
    db.prepare('UPDATE follows SET created_at = ? WHERE follower_id = ?').run(at(-60), follower.id);

    await approve(id, staff);

    const unread = await request(app).get('/api/users/me/notifications/unread-count').set(authHeader(follower));
    expect(unread.body.unread).toBe(1);
    const feed = await request(app).get('/api/users/me/notifications').set(authHeader(follower));
    expect(feed.body.data).toEqual([expect.objectContaining({ id, event: 'published' })]);
  });

  it('answers 409 the second time, and to an approval after a rejection', async () => {
    const { id, staff } = await seedPending();
    expect((await approve(id, staff)).status).toBe(200);
    expect((await approve(id, mod())).status).toBe(409);
    expect((await reject(id, mod())).status).toBe(409);

    const other = await seedPending();
    expect((await reject(other.id, staff)).status).toBe(200);
    expect((await approve(other.id, staff)).status).toBe(409);
  });

  it('answers 404 for a listing that does not exist', async () => {
    expect((await approve('no-such-listing', mod())).status).toBe(404);
  });
});

describe('rejecting a new listing', () => {
  it('quarantines it for the days asked, and answers what the message to the author needs', async () => {
    const { author, id, player, staff } = await seedPending();

    const res = await reject(id, staff, { days: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data.author).toMatchObject({ id: author.id, username: author.username });
    const span = Date.parse(res.body.data.quarantineExpiresAt) - Date.parse(res.body.data.quarantinedAt);
    expect(span).toBe(3 * 24 * 60 * 60 * 1000);

    expect((await readOne(id, player)).status).toBe(404);
    const own = (await readOne(id, author)).body.data;
    expect(own.moderation_state).toBe('rejected');
    expect(own.quarantine_expires_at).toBe(res.body.data.quarantineExpiresAt);
    expect((await count(staff)).body.data.count).toBe(0);
  });

  it('takes the quarantine route\'s default and bounds', async () => {
    const { id, staff } = await seedPending();
    expect((await reject(id, staff, { days: 0 })).status).toBe(400);
    expect((await reject(id, staff, { days: 91 })).status).toBe(400);
    expect((await reject(id, staff, { days: 2.5 })).status).toBe(400);
    expect((await readOne(id, staff)).body.data.moderation_state).toBe('pending');

    const res = await reject(id, staff);
    const span = Date.parse(res.body.data.quarantineExpiresAt) - Date.parse(res.body.data.quarantinedAt);
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('logs the rejection with the listing id and the deadline', async () => {
    const { id, staff } = await seedPending();
    const res = await reject(id, staff, { days: 3 });

    const log = (await auditOf('listing_rejected')).body.data;
    expect(log).toHaveLength(1);
    expect(log[0].target).toMatchObject({ id, name: 'Sedge Landing' });
    expect(log[0].snippet).toContain(res.body.data.quarantineExpiresAt);
  });

  it('answers 409 the second time, whatever days it is sent', async () => {
    const { id, staff } = await seedPending();
    expect((await reject(id, staff)).status).toBe(200);
    expect((await reject(id, mod())).status).toBe(409);
    expect((await reject(id, mod(), { days: 0 })).status).toBe(409);
  });
});

describe('the staff ladder on review', () => {
  // Promoted after submitting, which is the one way a staff member's listing waits.
  const promote = (user, role) => db.prepare('UPDATE users SET account_type = ? WHERE id = ?').run(role, user.id);

  it('refuses a mod on an admin\'s listing', async () => {
    const { author, id } = await seedPending();
    promote(author, 'admin');

    expect((await approve(id, mod())).status).toBe(403);
    expect((await reject(id, mod())).status).toBe(403);
    expect((await content(id, mod())).status).toBe(403);
    expect((await readOne(id, author)).body.data.moderation_state).toBe('pending');
  });

  it('refuses a mod on another mod\'s listing, and lets an admin act on it', async () => {
    const { author, id } = await seedPending();
    promote(author, 'mod');

    expect((await approve(id, mod())).status).toBe(403);
    expect((await approve(id, admin())).status).toBe(200);
  });

  it('refuses a player, signed out or in', async () => {
    const { id, player } = await seedPending();

    expect((await approve(id, player)).status).toBe(403);
    expect((await reject(id, null)).status).toBe(401);
  });
});

describe('a pending contest entry', () => {
  it('holds its author\'s one contest slot', async () => {
    const event = contest();
    const { author } = await seedPending({ contestEventId: event.id });

    const second = await publish(author, { name: 'Second Try', contestEventId: event.id });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONTEST_ALREADY_ENTERED');
  });

  it('can be approved after the contest deadline, and stays entered', async () => {
    const event = contest();
    const { id, player, staff } = await seedPending({ contestEventId: event.id });
    Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });

    expect((await approve(id, staff)).status).toBe(200);
    const read = (await readOne(id, player)).body.data;
    expect(read.contest_event_id ?? read.contestEventId).toBe(event.id);
  });
});

describe('the add-on review route', () => {
  const review = (worldId, componentId, user) => request(app)
    .put(`/api/worlds/${worldId}/addons/${componentId}/review`).set(authHeader(user)).send({ reviewState: 'approved' });

  it('answers 404 to the world author for a component waiting for review', async () => {
    const owner = person('owner');
    const world = (await publish(owner, { name: 'Owner Landing' })).body.data;
    const { id: component } = await seedPending({ name: 'Marsh Warden', kind: 'entity', compatibleWorlds: [world.id] });

    expect((await review(world.id, component, owner)).status).toBe(404);
  });

  it('answers 404 to the world author for a quarantined component, and 200 once released', async () => {
    const owner = person('owner');
    const world = (await publish(owner, { name: 'Owner Landing' })).body.data;
    const component = (await publish(person('maker'), {
      name: 'Marsh Warden', kind: 'entity', compatibleWorlds: [world.id]
    })).body.data.id;
    expect((await review(world.id, component, owner)).status).toBe(200);

    await request(app).put(`/api/worlds/${component}/quarantine`).set(authHeader(admin())).send({});
    expect((await review(world.id, component, owner)).status).toBe(404);

    await request(app).delete(`/api/worlds/${component}/quarantine`).set(authHeader(admin()));
    expect((await review(world.id, component, owner)).status).toBe(200);
  });
});
