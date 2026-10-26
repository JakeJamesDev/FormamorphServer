import { describe, it, expect } from 'vitest';
import { app, request, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Listing review: with the setting on, a normal author's new listing waits for a mod, and until then
 * only its author and staff can see it on any read path. Staff uploads skip the wait and are logged.
 *
 * Every read is made as each of the three people the rule separates: a player, the author, and staff.
 */

const as = (req, user) => (user ? req.set(authHeader(user)) : req);

const admin = () => createUser({ username: `admin-${Math.random().toString(16).slice(2, 8)}`, accountType: 'admin' });
const mod = () => createUser({ username: `mod-${Math.random().toString(16).slice(2, 8)}`, accountType: 'mod' });
const person = (name) => createUser({ username: `${name}-${Math.random().toString(16).slice(2, 8)}` });

const setReview = (actor, value) =>
  request(app).put('/api/settings/listing_review').set(authHeader(actor)).send({ value });

const reviewOn = async () => expect((await setReview(admin(), true)).status).toBe(200);

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);
const catalog = (user, query = '') => as(request(app).get(`/api/worlds${query}`), user);
const download = (id, user) => as(request(app).get(`/api/worlds/${id}/content`), user);
const dependencies = (id, user) => as(request(app).get(`/api/worlds/${id}/dependencies`), user);
const dependencyContent = (worldId, sourceId, user) =>
  as(request(app).get(`/api/worlds/${worldId}/dependencies/${sourceId}/content`), user);
const addons = (id, user) => as(request(app).get(`/api/worlds/${id}/addons`), user);
const authorListing = (authorId, user) => as(request(app).get(`/api/users/${authorId}/worlds`), user);
const profile = (userId, user) => as(request(app).get(`/api/users/${userId}/profile`), user);
const report = (user, targetId) => request(app).post('/api/reports').set(authHeader(user))
  .send({ targetKind: 'listing', targetId, category: 'spam' });

const ids = (rows) => rows.map((row) => row.id);

/** Turn review on, then publish one pending listing from a normal author. */
const seedPending = async (over = {}) => {
  await reviewOn();
  const author = person('author');
  const res = await publish(author, { name: 'Sedge Landing', ...over });
  expect(res.status).toBe(201);
  return { author, id: res.body.data.id, player: person('player'), staff: mod() };
};

describe('the listing_review setting', () => {
  it('is off by default, and the meta route says so to anyone', async () => {
    const read = await request(app).get('/api/settings/listing_review').set(authHeader(mod()));
    expect(read.body.data).toBe(false);

    const meta = await request(app).get('/api/reviews/meta');
    expect(meta.status).toBe(200);
    expect(meta.body.data).toEqual({ enabled: false });
  });

  it('is written by an admin, and the meta route follows it', async () => {
    await reviewOn();

    expect((await request(app).get('/api/reviews/meta').set(authHeader(person('player')))).body.data)
      .toEqual({ enabled: true });
  });

  it('refuses a mod, who would otherwise switch review off alone', async () => {
    const res = await setReview(mod(), true);

    expect(res.status).toBe(403);
    expect((await request(app).get('/api/reviews/meta')).body.data).toEqual({ enabled: false });
  });

  it('takes only true or false', async () => {
    expect((await setReview(admin(), 'yes')).status).toBe(400);
  });
});

describe('a new listing while review is on', () => {
  it('waits for review when a normal author publishes it, and the author sees that', async () => {
    const { author, id } = await seedPending();

    const own = (await readOne(id, author)).body.data;
    expect(own.moderation_state).toBe('pending');
    expect(own.moderation_queued_at).toBeTruthy();
    expect(own.listed_at).toBeNull();
  });

  it('goes live at once from staff, and the skip is logged with the listing id', async () => {
    await reviewOn();
    const staff = mod();

    const id = (await publish(staff, { name: 'Staff Landing' })).body.data.id;

    expect((await readOne(id, person('player'))).status).toBe(200);
    expect((await readOne(id, staff)).body.data.moderation_state).toBe('approved');

    const log = await request(app).get('/api/audit?action=listing_auto_approved').set(authHeader(admin()));
    expect(log.body.data).toHaveLength(1);
    expect(log.body.data[0].target).toMatchObject({ id, name: 'Staff Landing' });
  });

  it('logs no skip for a normal author', async () => {
    await seedPending();

    const log = await request(app).get('/api/audit?action=listing_auto_approved').set(authHeader(admin()));
    expect(log.body.data).toHaveLength(0);
  });
});

describe('a new listing while review is off', () => {
  it('goes live at once with its listed time set, for anyone who publishes it', async () => {
    const author = person('author');

    const id = (await publish(author)).body.data.id;

    const own = (await readOne(id, author)).body.data;
    expect(own.moderation_state).toBe('approved');
    expect(own.listed_at).toBeTruthy();
    expect((await readOne(id, person('player'))).status).toBe(200);
  });

  it('logs no skip for staff, because nothing was skipped', async () => {
    await publish(mod());

    const log = await request(app).get('/api/audit?action=listing_auto_approved').set(authHeader(admin()));
    expect(log.body.data).toHaveLength(0);
  });
});

describe('a pending listing to a player', () => {
  it('is absent from the catalog, signed in or not, and present for its author and staff', async () => {
    const { author, id, player, staff } = await seedPending();

    expect(ids((await catalog(null)).body.data)).not.toContain(id);
    expect(ids((await catalog(player)).body.data)).not.toContain(id);
    expect(ids((await catalog(author)).body.data)).toContain(id);
    expect(ids((await catalog(staff)).body.data)).toContain(id);
  });

  it('answers 404 when read by id', async () => {
    const { author, id, player, staff } = await seedPending();

    expect((await readOne(id)).status).toBe(404);
    expect((await readOne(id, player)).status).toBe(404);
    expect((await readOne(id, author)).status).toBe(200);
    expect((await readOne(id, staff)).status).toBe(200);
  });

  it('answers 404 to a download, and counts none', async () => {
    const { author, id, player, staff } = await seedPending();

    expect((await download(id, player)).status).toBe(404);
    expect((await download(id, author)).status).toBe(200);
    expect((await download(id, staff)).status).toBe(200);
  });

  it('is left out of a list of an author\'s work and of their totals', async () => {
    const { author, id, player, staff } = await seedPending();
    await download(id, author);

    expect(ids((await authorListing(author.id, player)).body.data)).not.toContain(id);
    expect(ids((await authorListing(author.id, author)).body.data)).toContain(id);
    expect(ids((await authorListing(author.id, staff)).body.data)).toContain(id);
    expect(ids((await request(app).get('/api/users/me/worlds').set(authHeader(author))).body.data)).toContain(id);

    expect((await profile(author.id, player)).body.data.downloads).toBe(0);
  });

  it('adds no like a mod gave it to the author\'s total', async () => {
    const { author, id, player, staff } = await seedPending();
    expect((await request(app).put(`/api/worlds/${id}/like`).set(authHeader(staff)).send({ liked: true })).status)
      .toBe(200);

    expect((await profile(author.id, player)).body.data.likes).toBe(0);
  });

  it('cannot be liked by a player', async () => {
    const { id, player } = await seedPending();

    expect((await request(app).put(`/api/worlds/${id}/like`).set(authHeader(player)).send({ liked: true })).status)
      .toBe(404);
  });

  it('resolves as not found when an approved world requires it', async () => {
    const { author, id, player, staff } = await seedPending({ name: 'Marsh Warden', kind: 'entity' });
    const world = (await publish(staff, { name: 'Staff Landing', requiredDependencies: [id] })).body.data;

    expect((await dependencies(world.id, player)).body.data.dependencies)
      .toEqual([{ id, status: 'not_found' }]);
    expect((await dependencyContent(world.id, id, player)).status).toBe(404);

    expect((await dependencies(world.id, author)).body.data.dependencies[0].status).toBe('ok');
    expect((await dependencies(world.id, staff)).body.data.dependencies[0].status).toBe('ok');
  });

  it('is never offered as an add-on for an approved world', async () => {
    const staff = mod();
    const world = (await publish(staff, { name: 'Staff Landing' })).body.data;
    const { author, id, player } = await seedPending({ name: 'Marsh Warden', kind: 'entity', compatibleWorlds: [world.id] });

    expect(ids((await addons(world.id, player)).body.data)).not.toContain(id);
    expect(ids((await addons(world.id, author)).body.data)).toContain(id);
    expect(ids((await addons(world.id, staff)).body.data)).toContain(id);
  });

  it('is left off an approved component\'s list of the worlds it is offered for', async () => {
    // The author's own pending world, with the author's own component offered for it after review is off.
    const { author, id: worldId, player, staff } = await seedPending();
    await setReview(admin(), false);
    const approved = (await publish(staff, { name: 'Staff Landing' })).body.data.id;
    const component = (await publish(author, {
      name: 'Marsh Warden', kind: 'entity', compatibleWorlds: [worldId, approved]
    })).body.data;

    expect(ids((await readOne(component.id, player)).body.data.compatibleWorlds)).toEqual([approved]);
    expect(ids((await readOne(component.id, author)).body.data.compatibleWorlds)).toContain(worldId);
    expect(ids((await readOne(component.id, staff)).body.data.compatibleWorlds)).toContain(worldId);
  });

  it('stays out of a follower\'s feed and unread count', async () => {
    await reviewOn();
    const author = person('author');
    const follower = person('follower');
    await request(app).put(`/api/users/${author.id}/follow`).set(authHeader(follower));
    db.prepare('UPDATE follows SET created_at = ? WHERE follower_id = ?').run('2020-01-01T00:00:00.000Z', follower.id);

    await publish(author);

    // The count first: opening the feed marks it read.
    const unread = await request(app).get('/api/users/me/notifications/unread-count').set(authHeader(follower));
    expect(unread.body.unread).toBe(0);
    const feed = await request(app).get('/api/users/me/notifications').set(authHeader(follower));
    expect(feed.body.data).toEqual([]);
  });

  it('answers 404 to a report, while a quarantined listing stays reportable', async () => {
    const { id, player } = await seedPending();

    expect((await report(player, id)).status).toBe(404);

    const staffWorld = (await publish(mod(), { name: 'Staff Landing' })).body.data;
    await request(app).put(`/api/worlds/${staffWorld.id}/quarantine`).set(authHeader(admin())).send({});
    expect((await report(player, staffWorld.id)).status).toBe(201);
  });

  it('can be reported by staff, who can see it', async () => {
    const { id } = await seedPending();

    expect((await report(admin(), id)).status).toBe(201);
  });
});

describe('a pending contest entry', () => {
  it('cannot place on the podium until it is approved', async () => {
    const event = Event.create({
      type: 'contest',
      title: 'Sedge Landing Contest',
      bannerText: 'Build on Sedge Landing.',
      body: 'Build something on Sedge Landing before the week is out.',
      startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    const { id } = await seedPending({ contestEventId: event.id });
    Event.update(event.id, {
      startsAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });

    const res = await request(app).put(`/api/events/${event.id}/results`).set(authHeader(admin()))
      .send({ placements: [{ place: 1, worldId: id }] });

    expect(res.status).toBe(409);
  });
});

describe('moderation fields in a payload', () => {
  const MODERATION_FIELDS = ['moderation_state', 'moderation_queued_at'];
  const expectNone = (row) => MODERATION_FIELDS.forEach((field) => expect(row).not.toHaveProperty(field));

  it('never reach a player, on any read of an approved listing', async () => {
    const author = person('author');
    const player = person('player');
    const source = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;
    const world = (await publish(author, { requiredDependencies: [source.id] })).body.data;
    await publish(author, { name: 'Fen Lantern', kind: 'entity', compatibleWorlds: [world.id] });

    for (const viewer of [null, player]) {
      (await catalog(viewer)).body.data.forEach(expectNone);
      expectNone((await readOne(world.id, viewer)).body.data);
      expectNone((await download(world.id, viewer)).body.data);
      (await authorListing(author.id, viewer)).body.data.forEach(expectNone);
      expectNone((await dependencies(world.id, viewer)).body.data.dependencies[0].listing);
      (await addons(world.id, viewer)).body.data.forEach(expectNone);
    }
  });

  it('reach the author and staff', async () => {
    const { author, id, staff } = await seedPending();

    for (const viewer of [author, staff]) {
      expect((await readOne(id, viewer)).body.data.moderation_state).toBe('pending');
      expect((await catalog(viewer)).body.data.find((row) => row.id === id).moderation_state).toBe('pending');
    }
  });
});

describe('the catalog\'s newest sort', () => {
  it('orders by when a listing went live, so a late approval sorts as new', async () => {
    const author = person('author');
    const early = (await publish(author, { name: 'Submitted Early' })).body.data.id;
    const late = (await publish(author, { name: 'Submitted Late' })).body.data.id;
    // Submitted first but approved last.
    db.prepare('UPDATE worlds SET created_at = ?, listed_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', early);
    db.prepare('UPDATE worlds SET created_at = ?, listed_at = ? WHERE id = ?')
      .run('2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', late);

    const rows = (await catalog(null, '?sort=created_at&order=desc')).body.data;

    expect(ids(rows)).toEqual([early, late]);
  });
});
