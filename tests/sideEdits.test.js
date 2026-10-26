import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Side edits under review: dependencies, compatibility, the spoiler flag, visibility and the changelog
 * join the pending update on an approved listing, and apply together at approval.
 *
 * Every read is made as the person the rule is about: a player, the author, or staff.
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
const edit = (id, user, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}?includeChangelog=true`), user);
const setDependencies = (id, user, sourceIds) =>
  request(app).put(`/api/worlds/${id}/dependencies`).set(authHeader(user)).send({ sourceIds });
const setCompatibility = (id, user, worldIds) =>
  request(app).put(`/api/worlds/${id}/compatibility`).set(authHeader(user)).send({ worldIds });
const setSpoiler = (id, user, spoiler) =>
  request(app).put(`/api/worlds/${id}/spoiler`).set(authHeader(user)).send({ spoiler });
const addEntry = (id, user, over = {}) => request(app).post(`/api/worlds/${id}/changelog`).set(authHeader(user))
  .send({ title: 'Update 1', body: 'The drowned quarter is walkable now.', date: '2026-08-01', ...over });
const editEntry = (id, entryId, user, over = {}) =>
  request(app).put(`/api/worlds/${id}/changelog/${entryId}`).set(authHeader(user))
    .send({ title: 'Update 1', body: 'Rewritten.', date: '2026-08-02', ...over });
const deleteEntry = (id, entryId, user) =>
  request(app).delete(`/api/worlds/${id}/changelog/${entryId}`).set(authHeader(user));
const queue = (user) => as(request(app).get('/api/reviews'), user);
const approve = (id, user) => as(request(app).post(`/api/reviews/${id}/approve`), user);
const reject = (id, user, body = {}) => as(request(app).post(`/api/reviews/${id}/reject`), user).send(body);
const trust = (userId) => request(app).put(`/api/users/${userId}/trust`).set(authHeader(admin()));

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();
const contest = () => Event.create({
  type: 'contest',
  title: 'Sedge Landing Contest',
  bannerText: 'Build on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  startsAt: at(-60),
  endsAt: at(60)
});

const ids = (rows) => rows.map((row) => row.id);
const discard = (id, user) => request(app).delete(`/api/reviews/${id}`).set(authHeader(user));
const readDependencies = (id, user) => as(request(app).get(`/api/worlds/${id}/dependencies`), user);

/** Approved filler entries, with the listing's count kept in step the way the routes keep it. */
const fillChangelog = (worldId, count) => {
  const insert = db.prepare(`
    INSERT INTO world_changelog (id, world_id, title, body, entry_date, created_at, updated_at)
    VALUES (?, ?, 'Filler', 'Filler.', '2026-01-01', ?, ?)
  `);
  const now = new Date().toISOString();
  for (let i = 0; i < count; i += 1) insert.run(`filler-${tag()}-${i}`, worldId, now, now);
  db.prepare('UPDATE worlds SET changelog_count = (SELECT COUNT(*) FROM world_changelog WHERE world_id = ?) WHERE id = ?')
    .run(worldId, worldId);
};

/**
 * An approved world and an approved component from one normal author, a second source to require, and
 * review on.
 */
const seedApproved = async (over = {}) => {
  await setReview(false);
  const author = person('author');
  const other = person('other');
  const world = (await publish(author, { name: 'Sedge Landing', ...over })).body.data;
  const component = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;
  const source = (await publish(other, { name: 'Tide Table', kind: 'dictionary' })).body.data;
  const target = (await publish(other, { name: 'Reed Bank' })).body.data;
  expect((await addEntry(world.id, author, { title: 'Launch' })).status).toBe(201);
  await setReview(true);
  return { author, world, component, source, target, player: person('player'), staff: mod() };
};

/** Every side edit held on the seeded listings, through the side routes. */
const holdSideEdits = async (seeded) => {
  const { author, world, component, source, target } = seeded;
  const launch = (await readOne(world.id, author)).body.data.changelog[0];

  expect((await setDependencies(world.id, author, [source.id])).status).toBe(200);
  expect((await setCompatibility(component.id, author, [target.id])).status).toBe(200);
  expect((await setSpoiler(world.id, author, true)).status).toBe(200);
  const created = await addEntry(world.id, author, { title: 'Update 2' });
  expect(created.status).toBe(201);
  expect((await editEntry(world.id, launch.id, author, { title: 'Launch, revised' })).status).toBe(200);
  expect((await deleteEntry(world.id, created.body.data.id, author)).status).toBe(200);
  const kept = await addEntry(world.id, author, { title: 'Update 3', date: '2026-08-03' });
  expect(kept.status).toBe(201);

  return { launch, dropped: created.body.data, kept: kept.body.data };
};

describe('side edits to an approved listing', () => {
  it('wait in the pending update, and players keep the approved values', async () => {
    const seeded = await seedApproved();
    const { world, component, player } = seeded;
    await holdSideEdits(seeded);

    const read = (await readOne(world.id, player)).body.data;
    expect(read.spoiler).toBe(false);
    expect(read.requiredDependencies).toEqual([]);
    expect(read.changelog.map((entry) => entry.title)).toEqual(['Launch']);
    expect((await readDependencies(world.id, player)).body.data.dependencies).toEqual([]);
    expect((await readOne(component.id, player)).body.data.compatibleWorlds).toEqual([]);
  });

  it('show the author and staff each change beside the approved value', async () => {
    const seeded = await seedApproved();
    const { author, staff, world, component, source, target } = seeded;
    const { launch, dropped, kept } = await holdSideEdits(seeded);

    for (const reader of [author, staff]) {
      const update = (await readOne(world.id, reader)).body.data.pending_update;
      expect(update.fields).toEqual({
        spoiler: { approved: false, pending: true },
        required_dependencies: { approved: [], pending: [source.id] }
      });
      expect(update.changelog).toEqual([
        { op: 'create', id: dropped.id, title: 'Update 2', body: 'The drowned quarter is walkable now.', date: '2026-08-01' },
        { op: 'edit', id: launch.id, title: 'Launch, revised', body: 'Rewritten.', date: '2026-08-02' },
        { op: 'delete', id: dropped.id },
        { op: 'create', id: kept.id, title: 'Update 3', body: 'The drowned quarter is walkable now.', date: '2026-08-03' }
      ]);
    }

    expect((await readOne(component.id, author)).body.data.pending_update.fields).toEqual({
      compatible_worlds: { approved: [], pending: [target.id] }
    });
  });

  it('answer the approved values with the pending update beside them', async () => {
    const { author, world, component, source, target } = await seedApproved();

    const deps = (await setDependencies(world.id, author, [source.id])).body.data;
    expect(deps.requiredDependencies).toEqual([]);
    expect(deps.has_pending_update).toBe(true);
    expect(deps.pending_update.fields.required_dependencies.pending).toEqual([source.id]);

    const compat = (await setCompatibility(component.id, author, [target.id])).body.data;
    expect(compat.compatibleWorlds).toEqual([]);
    expect(compat.pending_update.fields.compatible_worlds.pending).toEqual([target.id]);

    const spoiler = (await setSpoiler(world.id, author, true)).body.data;
    expect(spoiler).toEqual(expect.objectContaining({ spoiler: false, has_pending_update: true }));

    const entry = (await addEntry(world.id, author, { title: 'Update 2' })).body.data;
    expect(entry).toEqual(expect.objectContaining({ title: 'Update 2', entry_date: '2026-08-01', pending: true }));
  });

  it('answer a changelog edit with the approved entry, and a delete with the pending update', async () => {
    const { author, world } = await seedApproved();
    const launch = (await readOne(world.id, author)).body.data.changelog[0];

    const edited = (await editEntry(world.id, launch.id, author, { title: 'Launch, revised' })).body.data;
    expect(edited).toEqual(expect.objectContaining({ id: launch.id, title: 'Launch', has_pending_update: true }));
    expect(edited.pending_update.changelog.map((op) => op.title)).toEqual(['Launch, revised']);

    // A held create has no approved entry behind it, so its edit answers the held entry.
    const created = (await addEntry(world.id, author, { title: 'Update 2' })).body.data;
    const heldEdit = (await editEntry(world.id, created.id, author, { title: 'Update 2, revised' })).body.data;
    expect(heldEdit).toEqual(expect.objectContaining({ id: created.id, title: 'Update 2, revised', pending: true }));
    expect(heldEdit.has_pending_update).toBe(true);

    const deleted = (await deleteEntry(world.id, launch.id, author)).body.data;
    expect(deleted.has_pending_update).toBe(true);
    expect(deleted.pending_update.changelog.at(-1)).toEqual({ op: 'delete', id: launch.id });
  });

  it('list the changelog operations in order on the queue item', async () => {
    const seeded = await seedApproved();
    const { launch, dropped, kept } = await holdSideEdits(seeded);

    const item = (await queue(seeded.staff)).body.data.find((row) => row.id === seeded.world.id);
    expect(item.type).toBe('update');
    expect(item.pendingUpdate.changelog.map((op) => [op.op, op.id]))
      .toEqual([['create', dropped.id], ['edit', launch.id], ['delete', dropped.id], ['create', kept.id]]);
  });

  it('hold the visibility, dependency and compatibility writes of the main update too', async () => {
    const { author, player, world, component, source, target } = await seedApproved();

    expect((await edit(world.id, author, { requiredDependencies: [source.id] })).status).toBe(200);
    expect((await edit(component.id, author, { visibility: 'unlisted', compatibleWorlds: [target.id] })).status).toBe(200);

    expect((await readOne(world.id, player)).body.data.requiredDependencies).toEqual([]);
    const componentRead = await readOne(component.id, player);
    expect(componentRead.status).toBe(200);
    expect(componentRead.body.data.visibility).toBe('public');
    expect(componentRead.body.data.compatibleWorlds).toEqual([]);

    expect((await readOne(world.id, author)).body.data.pending_update.fields).toEqual({
      required_dependencies: { approved: [], pending: [source.id] }
    });
    expect((await readOne(component.id, author)).body.data.pending_update.fields).toEqual({
      visibility: { approved: 'public', pending: 'unlisted' },
      compatible_worlds: { approved: [], pending: [target.id] }
    });
  });

  it('reach a held entry for a later edit, and refuse one the update deleted', async () => {
    const { author, world } = await seedApproved();

    const created = (await addEntry(world.id, author, { title: 'Update 2' })).body.data;
    expect((await editEntry(world.id, created.id, author)).status).toBe(200);
    expect((await deleteEntry(world.id, created.id, author)).status).toBe(200);
    expect((await editEntry(world.id, created.id, author)).status).toBe(404);
  });

  it('count held entries toward the cap', async () => {
    const { author, world } = await seedApproved();
    fillChangelog(world.id, 98);

    expect((await addEntry(world.id, author)).status).toBe(201);
    expect((await addEntry(world.id, author)).status).toBe(400);
  });

  it('skip a held entry at approval when staff filled the cap meanwhile', async () => {
    const { author, staff, world } = await seedApproved();
    fillChangelog(world.id, 98);

    expect((await addEntry(world.id, author, { title: 'Held' })).status).toBe(201);
    expect((await addEntry(world.id, staff, { title: 'Staff note' })).status).toBe(201);
    expect((await approve(world.id, staff)).status).toBe(200);

    const titles = (await readOne(world.id, author)).body.data.changelog.map((entry) => entry.title);
    expect(titles).toHaveLength(100);
    expect(titles).not.toContain('Held');
  });
});

describe('side edits that apply at once', () => {
  it('apply on a pending listing', async () => {
    await setReview(false);
    const other = person('other');
    const source = (await publish(other, { name: 'Tide Table', kind: 'dictionary' })).body.data;
    const target = (await publish(other, { name: 'Reed Bank' })).body.data;
    await setReview(true);
    const author = person('author');
    const world = (await publish(author, { name: 'Sedge Landing' })).body.data;
    const component = (await publish(author, { name: 'Marsh Warden', kind: 'entity' })).body.data;
    expect(world.moderation_state).toBe('pending');
    expect(component.moderation_state).toBe('pending');

    expect((await setSpoiler(world.id, author, true)).body.data.spoiler).toBe(true);
    expect(ids((await setDependencies(world.id, author, [source.id])).body.data.requiredDependencies))
      .toEqual([source.id]);
    expect(ids((await setCompatibility(component.id, author, [target.id])).body.data.compatibleWorlds))
      .toEqual([target.id]);
    const first = (await addEntry(world.id, author)).body.data;
    expect(first.pending).toBeUndefined();
    const second = (await addEntry(world.id, author, { title: 'Update 2' })).body.data;
    expect((await editEntry(world.id, first.id, author, { title: 'Update 1, revised' })).body.data.title)
      .toBe('Update 1, revised');
    expect((await deleteEntry(world.id, second.id, author)).status).toBe(200);

    const read = (await readOne(world.id, author)).body.data;
    expect(read.spoiler).toBe(true);
    expect(ids(read.requiredDependencies)).toEqual([source.id]);
    expect(read.changelog.map((entry) => entry.title)).toEqual(['Update 1, revised']);
    expect(read.has_pending_update).toBe(false);
    expect(ids((await readOne(component.id, author)).body.data.compatibleWorlds)).toEqual([target.id]);
  });

  it('apply on a rejected listing, which stays rejected', async () => {
    await setReview(true);
    const author = person('author');
    const world = (await publish(author, { name: 'Sedge Landing' })).body.data;
    expect((await reject(world.id, mod())).status).toBe(200);

    expect((await setSpoiler(world.id, author, true)).body.data.spoiler).toBe(true);
    const read = (await readOne(world.id, author)).body.data;
    expect(read.spoiler).toBe(true);
    expect(read.moderation_state).toBe('rejected');
  });

  it('apply for a trusted author', async () => {
    const { author, player, world, source } = await seedApproved();
    await trust(author.id);

    expect((await setDependencies(world.id, author, [source.id])).status).toBe(200);
    expect((await addEntry(world.id, author, { title: 'Update 2' })).status).toBe(201);

    const read = (await readOne(world.id, player)).body.data;
    expect(ids(read.requiredDependencies)).toEqual([source.id]);
    expect(read.changelog).toHaveLength(2);
  });

  it('apply for staff on the author\'s listing, and leave the pending update alone', async () => {
    const { author, staff, player, world } = await seedApproved();
    expect((await setSpoiler(world.id, author, true)).status).toBe(200);

    expect((await addEntry(world.id, staff, { title: 'Staff note' })).status).toBe(201);

    const read = (await readOne(world.id, player)).body.data;
    expect(read.changelog.map((entry) => entry.title)).toContain('Staff note');
    expect((await readOne(world.id, author)).body.data.pending_update.fields).toEqual({
      spoiler: { approved: false, pending: true }
    });
  });
});

describe('deciding on side edits', () => {
  it('approval applies them all with one revision raise', async () => {
    const seeded = await seedApproved();
    const { staff, player, world, component, source, target } = seeded;
    await holdSideEdits(seeded);
    expect((await edit(component.id, seeded.author, { visibility: 'unlisted' })).status).toBe(200);
    const before = (await readOne(world.id, staff)).body.data.revision;

    expect((await approve(world.id, staff)).status).toBe(200);
    expect((await approve(component.id, staff)).status).toBe(200);

    const read = (await readOne(world.id, player)).body.data;
    expect(read.revision).toBe(before + 1);
    expect(read.spoiler).toBe(true);
    expect(ids(read.requiredDependencies)).toEqual([source.id]);
    expect(read.changelog.map((entry) => entry.title)).toEqual(['Update 3', 'Launch, revised']);
    expect((await readOne(world.id, staff)).body.data.has_pending_update).toBe(false);

    // Unlisted now, so only its author reads it directly.
    expect((await readOne(component.id, player)).status).toBe(404);
    const offered = (await readOne(component.id, seeded.author)).body.data;
    expect(offered.visibility).toBe('unlisted');
    expect(ids(offered.compatibleWorlds)).toEqual([target.id]);
  });

  it('approval of side edits alone leaves the revision and date where they were', async () => {
    const seeded = await seedApproved();
    const { author, staff, world, component, target } = seeded;
    const launch = (await readOne(world.id, author)).body.data.changelog[0];
    expect((await setSpoiler(world.id, author, true)).status).toBe(200);
    expect((await editEntry(world.id, launch.id, author, { title: 'Launch, revised' })).status).toBe(200);
    expect((await addEntry(world.id, author, { title: 'Update 2' })).status).toBe(201);
    expect((await edit(component.id, author, { visibility: 'unlisted', compatibleWorlds: [target.id] })).status)
      .toBe(200);
    const worldBefore = (await readOne(world.id, staff)).body.data;
    const componentBefore = (await readOne(component.id, staff)).body.data;

    expect((await approve(world.id, staff)).status).toBe(200);
    expect((await approve(component.id, staff)).status).toBe(200);

    const worldAfter = (await readOne(world.id, staff)).body.data;
    expect(worldAfter.spoiler).toBe(true);
    expect(worldAfter.changelog.map((entry) => entry.title)).toEqual(['Launch, revised', 'Update 2']);
    expect([worldAfter.revision, worldAfter.updated_at]).toEqual([worldBefore.revision, worldBefore.updated_at]);

    const componentAfter = (await readOne(component.id, staff)).body.data;
    expect(componentAfter.visibility).toBe('unlisted');
    expect(ids(componentAfter.compatibleWorlds)).toEqual([target.id]);
    expect([componentAfter.revision, componentAfter.updated_at])
      .toEqual([componentBefore.revision, componentBefore.updated_at]);
  });

  it('rejection drops them and leaves the approved listing', async () => {
    const seeded = await seedApproved();
    const { staff, player, world, component } = seeded;
    await holdSideEdits(seeded);

    expect((await reject(world.id, staff)).status).toBe(200);
    expect((await reject(component.id, staff)).status).toBe(200);

    const read = (await readOne(world.id, player)).body.data;
    expect(read.spoiler).toBe(false);
    expect(read.requiredDependencies).toEqual([]);
    expect(read.changelog.map((entry) => entry.title)).toEqual(['Launch']);
    expect((await readOne(component.id, player)).body.data.compatibleWorlds).toEqual([]);
  });

  it('approval skips an operation whose entry is gone and a listing deleted while it waited', async () => {
    const { author, staff, world, component, source, target } = await seedApproved();
    const launch = (await readOne(world.id, author)).body.data.changelog[0];
    expect((await editEntry(world.id, launch.id, author, { title: 'Launch, revised' })).status).toBe(200);
    expect((await deleteEntry(world.id, launch.id, author)).status).toBe(200);
    expect((await setDependencies(world.id, author, [source.id])).status).toBe(200);
    expect((await setCompatibility(component.id, author, [target.id])).status).toBe(200);

    expect((await deleteEntry(world.id, launch.id, staff)).status).toBe(200);
    for (const gone of [source, target]) {
      expect((await request(app).delete(`/api/worlds/${gone.id}`).set(authHeader(admin()))).status).toBe(200);
    }

    expect((await approve(world.id, staff)).status).toBe(200);
    expect((await approve(component.id, staff)).status).toBe(200);
    const read = (await readOne(world.id, author)).body.data;
    expect(read.changelog).toEqual([]);
    expect(read.requiredDependencies).toEqual([]);
    expect((await readOne(component.id, author)).body.data.compatibleWorlds).toEqual([]);
  });
});

describe('an update to a contest entry', () => {
  /** A contest entry with a held update, its contest window then closed. */
  const seedJudged = async () => {
    await setReview(false);
    const event = contest();
    const author = person('author');
    const world = (await publish(author, { name: 'Sedge Landing', contestEventId: event.id })).body.data;
    await setReview(true);
    expect((await setSpoiler(world.id, author, true)).status).toBe(200);
    Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });
    return { event, world, author, staff: mod() };
  };

  it('waits for the results during judging, and stays queued', async () => {
    const { world, staff } = await seedJudged();

    const res = await approve(world.id, staff);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTEST_LOCKED');
    expect(ids((await queue(staff)).body.data)).toContain(world.id);
  });

  it('can still be rejected or discarded during judging', async () => {
    const rejected = await seedJudged();
    expect((await reject(rejected.world.id, rejected.staff)).status).toBe(200);
    expect((await readOne(rejected.world.id, rejected.author)).body.data.has_pending_update).toBe(false);

    const discarded = await seedJudged();
    expect((await discard(discarded.world.id, discarded.author)).status).toBe(200);
    const read = (await readOne(discarded.world.id, discarded.author)).body.data;
    expect([read.spoiler, read.has_pending_update]).toEqual([false, false]);
  });

  it('approves once the results are announced', async () => {
    const { event, world, staff, author } = await seedJudged();
    db.prepare('UPDATE events SET results_announced_at = ? WHERE id = ?').run(new Date().toISOString(), event.id);

    expect((await approve(world.id, staff)).status).toBe(200);
    expect((await readOne(world.id, author)).body.data.spoiler).toBe(true);
  });

  it('still lets a new contest entry approve during judging', async () => {
    await setReview(true);
    const event = contest();
    const author = person('author');
    const world = (await publish(author, { name: 'Sedge Landing', contestEventId: event.id })).body.data;
    Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });

    expect((await approve(world.id, mod())).status).toBe(200);
  });
});
