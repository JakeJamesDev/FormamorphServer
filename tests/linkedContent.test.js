import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const deleteUser = require('../src/utils/deleteUser');
const { PLACEHOLDER_ID } = require('../src/config/accountDeletion');
const { migrate } = require('../src/schema');
const Database = require('better-sqlite3');

/**
 * Linked content: what a world requires, what a component is offered for, and the unlisted listing that
 * is reachable only through a world that requires it.
 *
 * Three things have to hold. A world author alone decides what is required; a component author alone
 * decides what is offered; a world author alone answers an offer. An unlisted listing is as absent as a
 * deleted one to everyone but its author and staff, on every path except dependency resolution. And a
 * client can tell a source changed from the revision alone, with no version kept behind it.
 */

const staff = (username = 'a-mod') => createUser({ username, accountType: 'mod' });

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const update = (user, id, body) =>
  request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

const as = (req, user) => (user ? req.set(authHeader(user)) : req);

const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);
const list = (user, query = '') => as(request(app).get(`/api/worlds${query}`), user);
const download = (id, user) => as(request(app).get(`/api/worlds/${id}/content`), user);
const resolve = (id, user) => as(request(app).get(`/api/worlds/${id}/dependencies`), user);
const downloadDependency = (worldId, sourceId, user) =>
  as(request(app).get(`/api/worlds/${worldId}/dependencies/${sourceId}/content`), user);
const addons = (id, user) => as(request(app).get(`/api/worlds/${id}/addons`), user);

const declareDependencies = (user, id, sourceIds) =>
  request(app).put(`/api/worlds/${id}/dependencies`).set(authHeader(user)).send({ sourceIds });
const declareCompatibility = (user, id, worldIds) =>
  request(app).put(`/api/worlds/${id}/compatibility`).set(authHeader(user)).send({ worldIds });
const review = (user, worldId, componentId, reviewState) =>
  request(app).put(`/api/worlds/${worldId}/addons/${componentId}/review`).set(authHeader(user)).send({ reviewState });

const ids = (rows) => rows.map((row) => row.id);

/** A world author with a published world, and a component author with a published character. */
const seed = async ({ visibility = 'public' } = {}) => {
  const worldAuthor = createUser({ username: 'wren' });
  const componentAuthor = createUser({ username: 'sable' });
  const world = (await publish(worldAuthor, { name: 'Sedge Landing' })).body.data;
  const component = (await publish(componentAuthor, { name: 'Marsh Warden', kind: 'entity', visibility })).body.data;
  return { worldAuthor, componentAuthor, world, component };
};

describe('declaring what a world requires', () => {
  it('is the world author’s to write, and comes back on a read of the world', async () => {
    const { worldAuthor, world, component } = await seed();

    const res = await declareDependencies(worldAuthor, world.id, [component.id]);

    expect(res.status).toBe(200);
    expect(res.body.data.requiredDependencies).toMatchObject([{ id: component.id, status: 'ok' }]);
    expect(res.body.data.requiredDependencies[0].listing.name).toBe('Marsh Warden');

    const read = await readOne(world.id);
    expect(read.body.data.requiredDependencies).toMatchObject([{ id: component.id, status: 'ok' }]);
  });

  it('can be declared in the publish itself, and in an update', async () => {
    const { worldAuthor, componentAuthor, component } = await seed();
    const other = (await publish(componentAuthor, { name: 'Tide Table', kind: 'dictionary' })).body.data;

    const published = await publish(worldAuthor, { name: 'Reed Bank', requiredDependencies: [component.id] });
    expect(published.status).toBe(201);
    expect(ids(published.body.data.requiredDependencies)).toEqual([component.id]);

    const updated = await update(worldAuthor, published.body.data.id, { requiredDependencies: [other.id] });
    expect(updated.status).toBe(200);
    expect(ids(updated.body.data.requiredDependencies)).toEqual([other.id]);
  });

  it('is refused to anyone but the author and staff', async () => {
    const { world, component, componentAuthor } = await seed();

    // Authorship of the component grants nothing over the world that might require it.
    expect((await declareDependencies(componentAuthor, world.id, [component.id])).status).toBe(403);
    expect((await declareDependencies(createUser(), world.id, [component.id])).status).toBe(403);

    expect((await declareDependencies(staff(), world.id, [component.id])).status).toBe(200);
  });

  it('refuses a source that is not a component, and a listing that is not a world', async () => {
    const { worldAuthor, world, component, componentAuthor } = await seed();
    const another = (await publish(worldAuthor, { name: 'Another World' })).body.data;

    const notComponent = await declareDependencies(worldAuthor, world.id, [another.id]);
    expect(notComponent.status).toBe(400);
    expect(notComponent.body.code).toBe('SOURCE_NOT_COMPONENT');

    expect((await declareDependencies(componentAuthor, component.id, [component.id])).status).toBe(400);
  });

  it('answers not found for a source that does not exist, without writing anything', async () => {
    const { worldAuthor, world, component } = await seed();

    const res = await declareDependencies(worldAuthor, world.id, [component.id, 'no-such-listing']);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
    expect(res.body.sourceIds).toEqual(['no-such-listing']);
    expect((await resolve(world.id)).body.data.dependencies).toEqual([]);
  });

  it('refuses a malformed list', async () => {
    const { worldAuthor, world } = await seed();

    for (const sourceIds of ['x', [1], [''], null, Array.from({ length: 101 }, (_, i) => `s${i}`)]) {
      expect((await declareDependencies(worldAuthor, world.id, sourceIds)).status).toBe(400);
    }
  });

  it('holds still while the world’s contest is being judged', async () => {
    // Entered the way an entry is entered, then the contest closes with the results still unannounced.
    const { worldAuthor, component } = await seed();
    const minutes = (n) => new Date(Date.now() + n * 60000).toISOString();
    const contest = Event.create({
      type: 'contest', title: 'Autumn Build', bannerText: 'Build', body: 'Build a world',
      startsAt: minutes(-60), endsAt: minutes(60)
    });
    const entered = await publish(worldAuthor, { name: 'Entered', contestEventId: contest.id });
    expect(entered.status).toBe(201);
    Event.update(contest.id, { startsAt: minutes(-120), endsAt: minutes(-60) });

    const res = await declareDependencies(worldAuthor, entered.body.data.id, [component.id]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTEST_LOCKED');
  });
});

describe('declaring what a component is compatible with', () => {
  it('is the component author’s to write, and comes back on a read of the component', async () => {
    const { componentAuthor, world, component } = await seed();

    const res = await declareCompatibility(componentAuthor, component.id, [world.id]);

    expect(res.status).toBe(200);
    expect(res.body.data.compatibleWorlds).toMatchObject([
      { id: world.id, name: 'Sedge Landing', reviewState: 'unreviewed', reviewedRevision: null, updatedSinceReview: false }
    ]);
    expect(res.body.data.compatibleWorlds[0].author.username).toBe('wren');

    const read = await readOne(component.id);
    expect(read.body.data.compatibleWorlds).toMatchObject([{ id: world.id, reviewState: 'unreviewed' }]);
  });

  it('can be declared in the publish itself', async () => {
    const { componentAuthor, world } = await seed();

    const res = await publish(componentAuthor, { name: 'Fen Lantern', kind: 'dictionary', compatibleWorlds: [world.id] });

    expect(res.status).toBe(201);
    expect(ids(res.body.data.compatibleWorlds)).toEqual([world.id]);
  });

  it('is refused to the world author, who does not own the component', async () => {
    const { worldAuthor, world, component } = await seed();

    expect((await declareCompatibility(worldAuthor, component.id, [world.id])).status).toBe(403);
  });

  it('refuses a target that is not a world, and answers not found for one that does not exist', async () => {
    const { componentAuthor, component } = await seed();
    const other = (await publish(componentAuthor, { name: 'Other', kind: 'entity' })).body.data;

    expect((await declareCompatibility(componentAuthor, component.id, [other.id])).status).toBe(404);

    const res = await declareCompatibility(componentAuthor, component.id, ['no-such-world']);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORLD_NOT_FOUND');
  });

  it('does not make the component required by the world', async () => {
    const { componentAuthor, world, component } = await seed();

    await declareCompatibility(componentAuthor, component.id, [world.id]);

    expect((await resolve(world.id)).body.data.dependencies).toEqual([]);
  });
});

describe('the world author’s review of an offer', () => {
  it('is writable by the world author alone', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    await declareCompatibility(componentAuthor, component.id, [world.id]);

    expect((await review(componentAuthor, world.id, component.id, 'approved')).status).toBe(403);
    expect((await review(staff(), world.id, component.id, 'approved')).status).toBe(403);
    expect((await review(createUser(), world.id, component.id, 'approved')).status).toBe(403);

    const res = await review(worldAuthor, world.id, component.id, 'approved');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ worldId: world.id, componentId: component.id, reviewState: 'approved', reviewedRevision: 1 });
  });

  it('takes only the three states, and only for an offer that was made', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();

    expect((await review(worldAuthor, world.id, component.id, 'approved')).status).toBe(404);

    await declareCompatibility(componentAuthor, component.id, [world.id]);
    for (const state of ['yes', '', null, 'APPROVED']) {
      expect((await review(worldAuthor, world.id, component.id, state)).status).toBe(400);
    }
    for (const state of ['declined', 'unreviewed', 'approved']) {
      expect((await review(worldAuthor, world.id, component.id, state)).body.data.reviewState).toBe(state);
    }
  });

  it('is read by everyone who can see the component, except a decline, which only its author and staff see', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    const otherWorld = (await publish(worldAuthor, { name: 'Reed Bank' })).body.data;
    await declareCompatibility(componentAuthor, component.id, [world.id, otherWorld.id]);
    await review(worldAuthor, world.id, component.id, 'approved');
    await review(worldAuthor, otherWorld.id, component.id, 'declined');

    const room = (await readOne(component.id)).body.data.compatibleWorlds;
    expect(room).toMatchObject([{ id: world.id, reviewState: 'approved' }]);

    const own = (await readOne(component.id, componentAuthor)).body.data.compatibleWorlds;
    expect(own.map((w) => w.reviewState)).toEqual(['approved', 'declined']);

    const mod = (await readOne(component.id, staff())).body.data.compatibleWorlds;
    expect(mod.map((w) => w.reviewState)).toEqual(['approved', 'declined']);
  });

  it('survives the component author republishing the same offer', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    await declareCompatibility(componentAuthor, component.id, [world.id]);
    await review(worldAuthor, world.id, component.id, 'approved');

    await update(componentAuthor, component.id, { compatibleWorlds: [world.id] });

    expect((await readOne(component.id)).body.data.compatibleWorlds[0].reviewState).toBe('approved');
  });

  it('shows the world author when the component changed since they answered', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    await declareCompatibility(componentAuthor, component.id, [world.id]);
    await review(worldAuthor, world.id, component.id, 'approved');

    await update(componentAuthor, component.id, { contentData: { name: 'Marsh Warden', changed: true } });
    const stale = (await addons(world.id, worldAuthor)).body.data[0];
    expect(stale).toMatchObject({ reviewState: 'approved', reviewedRevision: 1, revision: 2, updatedSinceReview: true });

    // Answering again with the same state is how the author marks the new revision reviewed.
    await review(worldAuthor, world.id, component.id, 'approved');
    const fresh = (await addons(world.id, worldAuthor)).body.data[0];
    expect(fresh).toMatchObject({ reviewedRevision: 2, updatedSinceReview: false });
  });
});

describe('a world’s add-on offerings', () => {
  it('list the compatible components with their review state, declined ones left out', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    const approved = (await publish(componentAuthor, { name: 'Approved One', kind: 'dictionary' })).body.data;
    const declined = (await publish(componentAuthor, { name: 'Declined One', kind: 'entity' })).body.data;
    for (const c of [component, approved, declined]) await declareCompatibility(componentAuthor, c.id, [world.id]);
    await review(worldAuthor, world.id, approved.id, 'approved');
    await review(worldAuthor, world.id, declined.id, 'declined');

    const res = await addons(world.id);

    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => [a.id, a.reviewState])).toEqual([
      [component.id, 'unreviewed'], [approved.id, 'approved']
    ]);
    expect(res.body.data[0].content_file).toBeUndefined();
  });

  it('show the world author, and staff, the declined ones too — it is their review list', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    await declareCompatibility(componentAuthor, component.id, [world.id]);
    await review(worldAuthor, world.id, component.id, 'declined');

    expect((await addons(world.id, createUser())).body.data).toEqual([]);
    expect(ids((await addons(world.id, worldAuthor)).body.data)).toEqual([component.id]);
    expect(ids((await addons(world.id, staff())).body.data)).toEqual([component.id]);
  });

  it('never include an unlisted component, whoever asks', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed({ visibility: 'unlisted' });
    await declareCompatibility(componentAuthor, component.id, [world.id]);
    await review(worldAuthor, world.id, component.id, 'approved');

    for (const viewer of [null, createUser(), worldAuthor, componentAuthor, staff()]) {
      expect((await addons(world.id, viewer)).body.data).toEqual([]);
    }
  });

  it('are as absent as the world is', async () => {
    const { world } = await seed();
    const root = createUser({ username: 'root', accountType: 'admin' });
    await request(app).put(`/api/worlds/${world.id}/quarantine`).set(authHeader(root)).send({});

    expect((await addons(world.id)).status).toBe(404);
    expect((await addons(world.id, root)).status).toBe(200);
  });
});

describe('an unlisted listing', () => {
  it('can only be a component', async () => {
    const author = createUser();

    expect((await publish(author, { name: 'W', visibility: 'unlisted' })).status).toBe(400);
    expect((await publish(author, { name: 'W', visibility: 'hidden' })).status).toBe(400);
    expect((await publish(author, { name: 'E', kind: 'entity', visibility: 'unlisted' })).status).toBe(201);
    expect((await publish(author, { name: 'D', kind: 'dictionary', visibility: 'unlisted' })).status).toBe(201);
  });

  it('is public unless the publish says otherwise, so an old client changes nothing', async () => {
    const author = createUser();

    const res = await publish(author, { name: 'E', kind: 'entity' });

    expect(res.body.data.visibility).toBe('public');
    expect(res.body.data.revision).toBe(1);
  });

  it('is read by its author and by staff, and is not found by anyone else', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });

    expect((await readOne(component.id, componentAuthor)).status).toBe(200);
    expect((await readOne(component.id, staff())).status).toBe(200);
    expect((await readOne(component.id)).status).toBe(404);
    expect((await readOne(component.id, createUser())).status).toBe(404);

    expect((await download(component.id, componentAuthor)).status).toBe(200);
    expect((await download(component.id, createUser())).status).toBe(404);
  });

  it('is absent from browse, search, and the author’s public list for everyone else', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });
    const stranger = createUser({ username: 'stranger' });

    for (const viewer of [null, stranger]) {
      expect(ids((await list(viewer, '?kind=entity')).body.data)).not.toContain(component.id);
      expect(ids((await list(viewer, '?kind=all')).body.data)).not.toContain(component.id);
      expect(ids((await list(viewer, '?kind=entity&search=Marsh')).body.data)).not.toContain(component.id);
      expect(ids((await list(viewer, '?kind=entity&search=sable&searchByAuthor=true')).body.data)).not.toContain(component.id);
      const byAuthor = await as(request(app).get(`/api/users/${componentAuthor.id}/worlds?kind=entity`), viewer);
      expect(ids(byAuthor.body.data)).not.toContain(component.id);
    }

    expect(ids((await list(componentAuthor, '?kind=entity')).body.data)).toContain(component.id);
    expect(ids((await list(staff(), '?kind=entity&search=Marsh')).body.data)).toContain(component.id);
    const own = await request(app).get('/api/users/me/worlds?kind=entity').set(authHeader(componentAuthor));
    expect(ids(own.body.data)).toContain(component.id);
  });

  it('is as absent from its comments, its like, and its report as from its page', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });
    const stranger = createUser({ username: 'stranger' });

    expect((await request(app).get(`/api/worlds/${component.id}/comments`)).status).toBe(404);
    expect((await request(app).get(`/api/worlds/${component.id}/comments`).set(authHeader(stranger))).status).toBe(404);
    expect((await request(app).post(`/api/worlds/${component.id}/comments`).set(authHeader(stranger)).send({ content: 'hello' })).status).toBe(404);
    expect((await request(app).put(`/api/worlds/${component.id}/like`).set(authHeader(stranger)).send({ liked: true })).status).toBe(404);
    expect((await readOne(component.id, stranger).query({ includeChangelog: 'true' })).status).toBe(404);

    // The author's own thread, and staff's, go on as normal.
    expect((await request(app).post(`/api/worlds/${component.id}/comments`).set(authHeader(componentAuthor)).send({ content: 'mine' })).status).toBe(201);
    expect((await request(app).get(`/api/worlds/${component.id}/comments`).set(authHeader(staff()))).status).toBe(200);
  });

  it('does not count toward the author’s public totals while it is unlisted', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });
    await download(component.id, componentAuthor);

    const hidden = (await request(app).get(`/api/users/${componentAuthor.id}/profile`)).body.data;
    expect(hidden.downloads).toBe(0);

    await update(componentAuthor, component.id, { visibility: 'public' });
    const shown = (await request(app).get(`/api/users/${componentAuthor.id}/profile`)).body.data;
    expect(shown.downloads).toBe(1);
  });

  it('is absent from a follower’s feed', async () => {
    const { componentAuthor } = await seed();
    const follower = createUser({ username: 'follower' });
    await request(app).put(`/api/users/${componentAuthor.id}/follow`).set(authHeader(follower)).send({});
    // Backdated, so a listing published now counts as after the follow began.
    db.prepare('UPDATE follows SET created_at = ? WHERE follower_id = ?').run('2020-01-01T00:00:00.000Z', follower.id);
    const hidden = (await publish(componentAuthor, { name: 'Quiet', kind: 'entity', visibility: 'unlisted' })).body.data;
    const shown = (await publish(componentAuthor, { name: 'Loud', kind: 'entity' })).body.data;

    const feed = await request(app).get('/api/users/me/notifications').set(authHeader(follower));

    expect(ids(feed.body.data)).toContain(shown.id);
    expect(ids(feed.body.data)).not.toContain(hidden.id);
  });

  it('is moderated exactly like a public one', async () => {
    const { component } = await seed({ visibility: 'unlisted' });
    const root = createUser({ username: 'root', accountType: 'admin' });

    const quarantined = await request(app).put(`/api/worlds/${component.id}/quarantine`).set(authHeader(root)).send({});
    expect(quarantined.status).toBe(200);
    expect((await request(app).delete(`/api/worlds/${component.id}/quarantine`).set(authHeader(root))).status).toBe(200);
    expect((await request(app).delete(`/api/worlds/${component.id}`).set(authHeader(root))).status).toBe(200);
  });

  it('can be made public and unlisted again by its author, without counting as a change', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });

    const shown = await update(componentAuthor, component.id, { visibility: 'public' });
    expect(shown.body.data.visibility).toBe('public');
    expect(shown.body.data.revision).toBe(1);
    expect((await readOne(component.id)).status).toBe(200);

    const hidden = await update(componentAuthor, component.id, { visibility: 'unlisted' });
    expect(hidden.body.data.visibility).toBe('unlisted');
    expect((await readOne(component.id)).status).toBe(404);
  });

  it('cannot be required by a world whose author cannot see it', async () => {
    // The id leaks through a dependency answer, and a world that required it would hand it to the room.
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });
    const other = createUser({ username: 'other' });
    const theirs = (await publish(other, { name: 'Theirs' })).body.data;

    const res = await declareDependencies(other, theirs.id, [component.id]);
    expect(res.status).toBe(404);
    expect(res.body.sourceIds).toEqual([component.id]);

    const own = (await publish(componentAuthor, { name: 'Own', requiredDependencies: [component.id] }));
    expect(own.status).toBe(201);
  });
});

describe('resolving a world’s dependencies', () => {
  const seedRequired = async ({ visibility = 'unlisted' } = {}) => {
    const componentAuthor = createUser({ username: 'sable' });
    const component = (await publish(componentAuthor, { name: 'Marsh Warden', kind: 'entity', visibility })).body.data;
    const world = (await publish(componentAuthor, { name: 'Sedge Landing', requiredDependencies: [component.id] })).body.data;
    return { componentAuthor, component, world };
  };

  it('hands an unlisted required component, and its content, to anyone who can read the world', async () => {
    const { component, world } = await seedRequired();
    const stranger = createUser({ username: 'stranger' });

    for (const viewer of [null, stranger]) {
      expect((await readOne(component.id, viewer)).status).toBe(404);

      const res = await resolve(world.id, viewer);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: world.id, revision: 1 });
      expect(res.body.data.dependencies).toMatchObject([{ id: component.id, status: 'ok' }]);
      expect(res.body.data.dependencies[0].listing).toMatchObject({ name: 'Marsh Warden', visibility: 'unlisted', revision: 1 });
      expect(res.body.data.dependencies[0].listing.content_file).toBeUndefined();

      const content = await downloadDependency(world.id, component.id, viewer);
      expect(content.status).toBe(200);
      expect(content.body.data.contentData.worldOverview.name).toBe('Marsh Warden');
    }

    expect(db.prepare('SELECT downloads FROM worlds WHERE id = ?').get(component.id).downloads).toBe(2);
  });

  it('is only through the world: a source the world does not require answers not found', async () => {
    const { componentAuthor, world } = await seedRequired();
    const other = (await publish(componentAuthor, { name: 'Not Required', kind: 'entity', visibility: 'unlisted' })).body.data;

    expect((await downloadDependency(world.id, other.id)).status).toBe(404);
    expect((await downloadDependency(world.id, 'no-such-source')).status).toBe(404);
  });

  it('is as absent as the world is', async () => {
    const { component, world } = await seedRequired();
    const root = createUser({ username: 'root', accountType: 'admin' });
    await request(app).put(`/api/worlds/${world.id}/quarantine`).set(authHeader(root)).send({});

    expect((await resolve(world.id)).status).toBe(404);
    expect((await downloadDependency(world.id, component.id)).status).toBe(404);
    expect((await resolve(world.id, root)).status).toBe(200);
  });

  it('reports a hard-deleted source as not found, and keeps reporting it', async () => {
    const { componentAuthor, component, world } = await seedRequired({ visibility: 'public' });

    expect((await request(app).delete(`/api/worlds/${component.id}`).set(authHeader(componentAuthor))).status).toBe(200);

    const res = await resolve(world.id);
    expect(res.body.data.dependencies).toEqual([{ id: component.id, status: 'not_found' }]);
    expect((await downloadDependency(world.id, component.id)).status).toBe(404);
    expect((await readOne(world.id)).body.data.requiredDependencies).toEqual([{ id: component.id, status: 'not_found' }]);
  });

  it('reports a quarantined source as not found to the room, as every other path does', async () => {
    const { componentAuthor, component, world } = await seedRequired({ visibility: 'public' });
    const root = createUser({ username: 'root', accountType: 'admin' });
    await request(app).put(`/api/worlds/${component.id}/quarantine`).set(authHeader(root)).send({});

    expect((await resolve(world.id)).body.data.dependencies).toEqual([{ id: component.id, status: 'not_found' }]);
    expect((await downloadDependency(world.id, component.id)).status).toBe(404);
    expect((await resolve(world.id, componentAuthor)).body.data.dependencies[0].status).toBe('ok');
    expect((await downloadDependency(world.id, component.id, root)).status).toBe(200);
  });

  it('forgets the declarations of a deleted world, and the offers for it', async () => {
    const { componentAuthor, component, world } = await seedRequired();
    await declareCompatibility(componentAuthor, component.id, [world.id]);

    await request(app).delete(`/api/worlds/${world.id}`).set(authHeader(componentAuthor));

    expect(db.prepare('SELECT COUNT(*) AS n FROM listing_dependencies WHERE world_id = ?').get(world.id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM listing_compatibility WHERE world_id = ?').get(world.id).n).toBe(0);
  });
});

describe('the revision marker', () => {
  it('starts at one and moves with every change to what a downloader receives', async () => {
    const author = createUser();
    const component = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;
    expect(component.revision).toBe(1);

    const content = await update(author, component.id, { contentData: { name: 'Marsh Warden', changed: true } });
    expect(content.body.data.revision).toBe(2);

    const renamed = await update(author, component.id, { name: 'Fen Warden' });
    expect(renamed.body.data.revision).toBe(3);

    expect((await readOne(component.id)).body.data.revision).toBe(3);
    expect((await list(null, '?kind=entity')).body.data[0].revision).toBe(3);
  });

  it('moves when a world’s required set changes, and not when it is restated', async () => {
    const author = createUser();
    const component = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;
    const world = (await publish(author, { name: 'Sedge Landing' })).body.data;

    expect((await declareDependencies(author, world.id, [component.id])).body.data.revision).toBe(2);
    expect((await declareDependencies(author, world.id, [component.id])).body.data.revision).toBe(2);
    expect((await declareDependencies(author, world.id, [])).body.data.revision).toBe(3);
  });

  it('does not move for a spoiler flag, a like, or a compatibility offer', async () => {
    const author = createUser();
    const reader = createUser({ username: 'reader' });
    const world = (await publish(author, { name: 'Sedge Landing' })).body.data;
    const component = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;

    await request(app).put(`/api/worlds/${world.id}/spoiler`).set(authHeader(author)).send({ spoiler: true });
    await request(app).put(`/api/worlds/${world.id}/like`).set(authHeader(reader)).send({ liked: true });
    await declareCompatibility(author, component.id, [world.id]);

    expect((await readOne(world.id)).body.data.revision).toBe(1);
    expect((await readOne(component.id)).body.data.revision).toBe(1);
  });
});

describe('an author who leaves', () => {
  it('and keeps their work leaves an unlisted listing behind, still unlisted, under the placeholder', async () => {
    const { componentAuthor, component } = await seed({ visibility: 'unlisted' });

    const result = await deleteUser(componentAuthor.username, { keepContent: true });
    expect(result.success).toBe(true);

    const row = db.prepare('SELECT author_id, visibility FROM worlds WHERE id = ?').get(component.id);
    expect(row).toEqual({ author_id: PLACEHOLDER_ID, visibility: 'unlisted' });
    expect((await readOne(component.id, staff())).status).toBe(200);
    expect((await readOne(component.id)).status).toBe(404);
    expect((await readOne(component.id, createUser())).status).toBe(404);
  });

  it('and takes their work with them leaves dependents seeing not found', async () => {
    const { worldAuthor, componentAuthor, world, component } = await seed();
    expect((await declareDependencies(worldAuthor, world.id, [component.id])).status).toBe(200);

    await deleteUser(componentAuthor.username);

    expect((await resolve(world.id)).body.data.dependencies).toEqual([{ id: component.id, status: 'not_found' }]);
  });
});

describe('the schema step', () => {
  it('gives an old database the two columns, public and at revision one', () => {
    const legacy = new Database(':memory:');
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, email TEXT,
        status TEXT DEFAULT 'normal', account_type TEXT DEFAULT 'normal',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, author_id TEXT NOT NULL,
        thumbnail_file TEXT NOT NULL, preview_data TEXT NOT NULL, content_file TEXT NOT NULL, downloads INTEGER DEFAULT 0,
        comment_count INTEGER DEFAULT 0, tags TEXT, spoiler INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users (id));
      INSERT INTO users (id, username, password) VALUES ('u1', 'old', 'x');
      INSERT INTO worlds (id, name, description, author_id, thumbnail_file, preview_data, content_file)
        VALUES ('w-old', 'Old World', 'from before', 'u1', 't.png', '', 'w-old.json');
    `);

    expect(migrate(legacy)).toContain('linkedContent');

    expect(legacy.prepare("SELECT visibility, revision FROM worlds WHERE id = 'w-old'").get())
      .toEqual({ visibility: 'public', revision: 1 });
    expect(migrate(legacy)).toEqual([]);
    legacy.close();
  });
});
