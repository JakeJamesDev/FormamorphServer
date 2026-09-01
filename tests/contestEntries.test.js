import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: addContestColumn } = require('../src/schema/steps/contest');

/**
 * Entering a contest, leaving one, and what a listing may still do while it is entered.
 *
 * An entry is a flag on the listing rather than a row of its own, so most of what follows is about the
 * flag's edges: it can only be set at publish, only by naming the contest that is actually running, and
 * only once per person. Everything after that is about what the flag then costs its owner — which is
 * the ability to rewrite the thing while it is being judged, and nothing else.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const contest = (over = {}) => Event.create({
  type: 'contest',
  title: 'Sedge Landing Contest',
  bannerText: 'Build on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  startsAt: at(-60),
  endsAt: at(60),
  ...over
});

const author = () => createUser({ username: `author-${Math.random().toString(16).slice(2, 8)}` });

const publish = (user, body = {}) => request(app)
  .post('/api/worlds')
  .set(authHeader(user))
  .send(worldPayload(body));

const entryOf = (worldId) => db
  .prepare('SELECT contest_event_id FROM worlds WHERE id = ?')
  .get(worldId).contest_event_id;

const columnNames = () => db.prepare('PRAGMA table_info(worlds)').all().map((column) => column.name);

const indexNames = () => db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worlds'")
  .all()
  .map((row) => row.name);

/** A worlds table as it stands on a database published before contests existed. */
const legacyDb = () => {
  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT)');
  return legacy;
};

describe('the contest entry column', () => {
  it('is on a freshly created worlds table', () => {
    expect(columnNames()).toContain('contest_event_id');
    expect(indexNames()).toContain('idx_worlds_contest');
  });

  it('is added to a worlds table that predates it', () => {
    const legacy = legacyDb();

    expect(addContestColumn(legacy)).toBe(true);
    expect(legacy.prepare('PRAGMA table_info(worlds)').all().map((c) => c.name)).toContain('contest_event_id');

    legacy.close();
  });

  it('is a no-op the second time, so every boot after the first costs nothing', () => {
    const legacy = legacyDb();

    addContestColumn(legacy);
    expect(addContestColumn(legacy)).toBe(false);

    legacy.close();
  });

  it('leaves a database with no worlds table alone', () => {
    // `PRAGMA table_info` on a missing table returns an empty list rather than throwing, which reads
    // exactly like "the table is there and the column is missing" — so absence is checked for by name.
    const empty = new Database(':memory:');

    expect(addContestColumn(empty)).toBe(false);

    empty.close();
  });
});

describe('entering a contest at publish', () => {
  it('stamps the entry when the publish names the running contest', async () => {
    const event = contest();

    const response = await publish(author(), { contestEventId: event.id });

    expect(response.status).toBe(201);
    expect(entryOf(response.body.data.id)).toBe(event.id);
  });

  it('leaves a publish that names nothing out of the contest', async () => {
    contest();

    const response = await publish(author());

    expect(response.status).toBe(201);
    expect(entryOf(response.body.data.id)).toBeNull();
  });

  it('refuses a contest that has not started', async () => {
    const event = contest({ startsAt: at(60), endsAt: at(120) });

    const response = await publish(author(), { contestEventId: event.id });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_NOT_ACTIVE');
    expect(db.prepare('SELECT COUNT(*) AS count FROM worlds').get().count).toBe(0);
  });

  it('refuses a contest whose window has closed', async () => {
    const event = contest({ startsAt: at(-120), endsAt: at(-60) });

    const response = await publish(author(), { contestEventId: event.id });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_NOT_ACTIVE');
  });

  it('refuses a contest that was called off', async () => {
    const event = contest();
    Event.cancel(event.id);

    const response = await publish(author(), { contestEventId: event.id });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_NOT_ACTIVE');
  });

  it('refuses an announcement, which has no entries to take', async () => {
    const event = Event.create({
      type: 'announcement',
      title: 'Maintenance',
      bannerText: 'Down for an hour.',
      body: 'Back shortly.',
      startsAt: at(-60),
      endsAt: at(60)
    });

    const response = await publish(author(), { contestEventId: event.id });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_NOT_ACTIVE');
  });

  it('refuses an event that does not exist', async () => {
    contest();

    const response = await publish(author(), { contestEventId: 'no-such-event' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_NOT_ACTIVE');
  });

  it('refuses a second entry from the same person, and publishes nothing', async () => {
    const event = contest();
    const user = author();
    await publish(user, { contestEventId: event.id, name: 'First' });

    const response = await publish(user, { contestEventId: event.id, name: 'Second' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_ALREADY_ENTERED');
    // The whole publish is refused, not merely the flag — a listing nobody asked for must not appear.
    expect(db.prepare("SELECT COUNT(*) AS count FROM worlds WHERE name = 'Second'").get().count).toBe(0);
  });

  it('counts a quarantined entry as the slot it is', async () => {
    const event = contest();
    const user = author();
    const first = await publish(user, { contestEventId: event.id, name: 'First' });
    const staff = createUser({ username: `mod-${Math.random().toString(16).slice(2, 8)}`, accountType: 'mod' });
    await request(app).put(`/api/worlds/${first.body.data.id}/quarantine`).set(authHeader(staff)).send({});

    const response = await publish(user, { contestEventId: event.id, name: 'Second' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_ALREADY_ENTERED');
  });

  it('lets somebody publish alongside their own entry as long as they do not enter it', async () => {
    const event = contest();
    const user = author();
    await publish(user, { contestEventId: event.id, name: 'First' });

    const response = await publish(user, { name: 'Second' });

    expect(response.status).toBe(201);
  });

  it('lets two people each enter once', async () => {
    const event = contest();

    const first = await publish(author(), { contestEventId: event.id });
    const second = await publish(author(), { contestEventId: event.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('frees the slot once the first entry is withdrawn', async () => {
    const event = contest();
    const user = author();
    const first = await publish(user, { contestEventId: event.id, name: 'First' });
    await request(app).delete(`/api/worlds/${first.body.data.id}/contest`).set(authHeader(user));

    const response = await publish(user, { contestEventId: event.id, name: 'Second' });

    expect(response.status).toBe(201);
  });

  it('frees the slot once the first entry is deleted', async () => {
    const event = contest();
    const user = author();
    const first = await publish(user, { contestEventId: event.id, name: 'First' });
    await request(app).delete(`/api/worlds/${first.body.data.id}`).set(authHeader(user));

    const response = await publish(user, { contestEventId: event.id, name: 'Second' });

    expect(response.status).toBe(201);
  });

  it('marks the entry on its catalog row and nobody else s', async () => {
    const event = contest();
    await publish(author(), { contestEventId: event.id, name: 'Entered' });
    await publish(author(), { name: 'Ordinary' });

    const response = await request(app).get('/api/worlds');

    const entries = Object.fromEntries(response.body.data.map((row) => [row.name, row.contest_event_id]));
    expect(entries.Entered).toBe(event.id);
    expect(entries.Ordinary).toBeNull();
  });
});

/** Publish into a running contest, then close its window so the entry is being judged. */
const enteredThenClosed = async (user, over = {}) => {
  const event = contest();
  const world = await publish(user, { contestEventId: event.id, ...over });
  Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });
  return { event, worldId: world.body.data.id };
};

const auditRows = () => db
  .prepare('SELECT action, actor_username, target_username, target_kind, target_name, snippet FROM audit_log ORDER BY id')
  .all();

const updatedAtOf = (worldId) => db.prepare('SELECT updated_at FROM worlds WHERE id = ?').get(worldId).updated_at;

const staffUser = (accountType = 'mod') =>
  createUser({ username: `${accountType}-${Math.random().toString(16).slice(2, 8)}`, accountType });

describe('withdrawing an entry', () => {
  it('clears the flag when its author asks', async () => {
    const user = author();
    const event = contest();
    const world = await publish(user, { contestEventId: event.id });

    const response = await request(app)
      .delete(`/api/worlds/${world.body.data.id}/contest`)
      .set(authHeader(user));

    expect(response.status).toBe(200);
    expect(entryOf(world.body.data.id)).toBeNull();
  });

  it('leaves the listing own date alone, so the catalog does not reshuffle', async () => {
    const user = author();
    const event = contest();
    const world = await publish(user, { contestEventId: event.id });
    const before = updatedAtOf(world.body.data.id);

    await request(app).delete(`/api/worlds/${world.body.data.id}/contest`).set(authHeader(user));

    expect(updatedAtOf(world.body.data.id)).toBe(before);
  });

  it('records a self-withdrawal against nobody', async () => {
    const user = author();
    const event = contest();
    const world = await publish(user, { contestEventId: event.id });

    await request(app).delete(`/api/worlds/${world.body.data.id}/contest`).set(authHeader(user));

    expect(auditRows()).toEqual([expect.objectContaining({
      action: 'entry_withdrawn',
      actor_username: user.username,
      target_username: null,
      target_name: 'Test World',
      snippet: event.title
    })]);
  });

  it('lets staff pull an entry that is not theirs, and says whose it was', async () => {
    const user = author();
    const mod = staffUser();
    const event = contest();
    const world = await publish(user, { contestEventId: event.id });

    const response = await request(app)
      .delete(`/api/worlds/${world.body.data.id}/contest`)
      .set(authHeader(mod));

    expect(response.status).toBe(200);
    expect(entryOf(world.body.data.id)).toBeNull();
    expect(auditRows()).toEqual([expect.objectContaining({
      action: 'entry_withdrawn',
      actor_username: mod.username,
      target_username: user.username
    })]);
  });

  it('refuses an ordinary account that owns nothing here', async () => {
    const event = contest();
    const world = await publish(author(), { contestEventId: event.id });

    const response = await request(app)
      .delete(`/api/worlds/${world.body.data.id}/contest`)
      .set(authHeader(author()));

    expect(response.status).toBe(403);
    expect(entryOf(world.body.data.id)).toBe(event.id);
  });

  it('refuses a signed-out caller', async () => {
    const event = contest();
    const world = await publish(author(), { contestEventId: event.id });

    const response = await request(app).delete(`/api/worlds/${world.body.data.id}/contest`);

    expect(response.status).toBe(401);
  });

  it('refuses a listing that is not entered in anything', async () => {
    const user = author();
    const world = await publish(user);

    const response = await request(app)
      .delete(`/api/worlds/${world.body.data.id}/contest`)
      .set(authHeader(user));

    expect(response.status).toBe(400);
    expect(auditRows()).toEqual([]);
  });

  it('answers 404 for a listing that is not there', async () => {
    const response = await request(app)
      .delete('/api/worlds/no-such-world/contest')
      .set(authHeader(author()));

    expect(response.status).toBe(404);
  });

  it('still works while the contest is being judged', async () => {
    // Withdrawal is the one thing an entrant can still do after the deadline: their work, their call.
    const user = author();
    const { worldId } = await enteredThenClosed(user);

    const response = await request(app).delete(`/api/worlds/${worldId}/contest`).set(authHeader(user));

    expect(response.status).toBe(200);
    expect(entryOf(worldId)).toBeNull();
  });
});

describe('an entry while its contest is being judged', () => {
  it('refuses a content update from its author', async () => {
    const user = author();
    const { event, worldId } = await enteredThenClosed(user);

    const response = await request(app)
      .put(`/api/worlds/${worldId}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_LOCKED');
    expect(response.body.error).toContain(event.title);
    expect(db.prepare('SELECT name FROM worlds WHERE id = ?').get(worldId).name).toBe('Test World');
  });

  it('takes an update from its author while the contest is still open', async () => {
    const user = author();
    const event = contest();
    const world = await publish(user, { contestEventId: event.id });

    const response = await request(app)
      .put(`/api/worlds/${world.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(200);
  });

  it('takes an update to a listing that entered nothing', async () => {
    const user = author();
    const event = contest();
    const world = await publish(user);
    Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });

    const response = await request(app)
      .put(`/api/worlds/${world.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(200);
  });

  it('lets staff through', async () => {
    const { worldId } = await enteredThenClosed(author());

    const response = await request(app)
      .put(`/api/worlds/${worldId}`)
      .set(authHeader(staffUser()))
      .send({ name: 'Moderated' });

    expect(response.status).toBe(200);
    expect(db.prepare('SELECT name FROM worlds WHERE id = ?').get(worldId).name).toBe('Moderated');
  });

  it('opens again once the contest is called off', async () => {
    const user = author();
    const { event, worldId } = await enteredThenClosed(user);

    await request(app)
      .post(`/api/events/${event.id}/cancel`)
      .set(authHeader(staffUser('admin')))
      .send({});

    // Cancelling releases every entry, so there is nothing left to hold this one still.
    expect(entryOf(worldId)).toBeNull();

    const response = await request(app)
      .put(`/api/worlds/${worldId}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(200);
  });

  it('can still be flagged, liked, commented on and taken down by its author', async () => {
    const user = author();
    const reader = author();
    const { worldId } = await enteredThenClosed(user);

    const spoiler = await request(app)
      .put(`/api/worlds/${worldId}/spoiler`)
      .set(authHeader(user))
      .send({ spoiler: true });
    const like = await request(app).put(`/api/worlds/${worldId}/like`).set(authHeader(reader)).send({ liked: true });
    const comment = await request(app)
      .post(`/api/worlds/${worldId}/comments`)
      .set(authHeader(reader))
      .send({ content: 'Good luck in the contest.' });
    const quarantine = await request(app)
      .put(`/api/worlds/${worldId}/quarantine`)
      .set(authHeader(staffUser()))
      .send({});
    const removed = await request(app).delete(`/api/worlds/${worldId}`).set(authHeader(user));

    expect([spoiler.status, like.status, comment.status, quarantine.status, removed.status])
      .toEqual([200, 200, 201, 200, 200]);
    // An author deleting their entry mid-judging is a withdrawal by other means, and the flag goes with
    // the row rather than leaving a contest pointing at nothing.
    expect(db.prepare('SELECT COUNT(*) AS count FROM worlds WHERE id = ?').get(worldId).count).toBe(0);
  });
});

/** A closed contest with one entry, ready to be judged. */
const judgeable = async (user = author()) => {
  const event = contest();
  const world = await publish(user, { contestEventId: event.id, name: 'The Entry' });
  Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });
  return { event, user, worldId: world.body.data.id };
};

/** The same, with a second entrant — both published while the window is open, as entering requires. */
const judgeablePair = async () => {
  const event = contest();
  const user = author();
  const runnerUp = author();
  const world = await publish(user, { contestEventId: event.id, name: 'The Entry' });
  const other = await publish(runnerUp, { contestEventId: event.id, name: 'Runner Up' });
  Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });
  return { event, user, runnerUp, worldId: world.body.data.id, runnerUpId: other.body.data.id };
};

/** A closed contest with three entrants, so a full podium can be assembled. */
const judgeableThree = async () => {
  const event = contest();
  const entrants = [author(), author(), author()];
  const names = ['The Entry', 'Runner Up', 'Third Wheel'];
  const ids = [];
  for (let i = 0; i < entrants.length; i += 1) {
    const world = await publish(entrants[i], { contestEventId: event.id, name: names[i] });
    ids.push(world.body.data.id);
  }
  Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });
  return { event, entrants, ids };
};

/** A podium body from world ids in podium order. */
const podium = (...worldIds) => ({
  placements: worldIds.map((worldId, index) => ({ place: index + 1, worldId }))
});

const announce = (event, body, actor) => request(app)
  .put(`/api/events/${event.id}/results`)
  .set(authHeader(actor))
  .send(body);

const editPodium = (event, body, actor) => request(app)
  .put(`/api/events/${event.id}/placements`)
  .set(authHeader(actor))
  .send(body);

const eventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);

const placementRows = (id) => db
  .prepare('SELECT place, world_id, world_name, author_name FROM event_placements WHERE event_id = ? ORDER BY place')
  .all(id);

const broadcasts = () => db.prepare('SELECT * FROM messages ORDER BY created_at, id').all();

describe('announcing a contest’s results', () => {
  it('refuses a signed-out caller', async () => {
    const { event, worldId } = await judgeable();

    const response = await request(app).put(`/api/events/${event.id}/results`).send(podium(worldId));

    expect(response.status).toBe(401);
  });

  it('refuses an ordinary account', async () => {
    const { event, worldId } = await judgeable();

    const response = await announce(event, podium(worldId), author());

    expect(response.status).toBe(403);
  });

  it('refuses staff who are not administrators, which is the tightening', async () => {
    // Announcing results speaks to every player at once, exactly as scheduling the contest did. The
    // moderation team reads the calendar; the podium is the owner's to publish.
    const { event, worldId } = await judgeable();

    const response = await announce(event, podium(worldId), staffUser('mod'));

    expect(response.status).toBe(403);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('stores a whole podium, gold first', async () => {
    const { event, entrants, ids } = await judgeableThree();

    const response = await announce(event, podium(...ids), staffUser('admin'));

    expect(response.status).toBe(200);
    expect(placementRows(event.id)).toEqual([
      { place: 1, world_id: ids[0], world_name: 'The Entry', author_name: entrants[0].username },
      { place: 2, world_id: ids[1], world_name: 'Runner Up', author_name: entrants[1].username },
      { place: 3, world_id: ids[2], world_name: 'Third Wheel', author_name: entrants[2].username }
    ]);
  });

  it('answers with the podium it stored', async () => {
    const { event, entrants, ids } = await judgeableThree();

    const response = await announce(event, podium(ids[0], ids[1]), staffUser('admin'));

    expect(response.body.data.placements).toEqual([
      { place: 1, worldId: ids[0], worldName: 'The Entry', authorName: entrants[0].username },
      { place: 2, worldId: ids[1], worldName: 'Runner Up', authorName: entrants[1].username }
    ]);
    expect(response.body.data.resultsAnnouncedAt).toBeTruthy();
  });

  it('takes gold alone, so a small contest is not made to invent three winners', async () => {
    const { event, worldId } = await judgeable();

    const response = await announce(event, podium(worldId), staffUser('admin'));

    expect(response.status).toBe(200);
    expect(placementRows(event.id)).toHaveLength(1);
  });

  it('announces the whole podium in one broadcast, and remembers which message that was', async () => {
    const { event, entrants, ids } = await judgeableThree();

    await announce(event, podium(...ids), staffUser('admin'));

    const announcement = broadcasts().find((message) => message.id === eventRow(event.id).results_message_id);

    expect(announcement).toBeDefined();
    expect(announcement.recipient_id).toBeNull();
    expect(announcement.scope).toBe('new');
    for (const name of ['The Entry', 'Runner Up', 'Third Wheel']) expect(announcement.body).toContain(name);
    for (const entrant of entrants) expect(announcement.body).toContain(entrant.username);
    expect(announcement.body).toContain('First place');
    expect(announcement.body).toContain('Third place');
  });

  it('logs who announced it, whose contest it was, and the whole podium', async () => {
    const { event, entrants, ids } = await judgeableThree();
    const announcer = staffUser('admin');

    await announce(event, podium(ids[0], ids[1]), announcer);

    expect(auditRows()).toEqual([expect.objectContaining({
      action: 'results_announced',
      actor_username: announcer.username,
      target_username: entrants[0].username,
      target_name: event.title,
      snippet: `First place: The Entry by ${entrants[0].username}; Second place: Runner Up by ${entrants[1].username}`
    })]);
  });

  it('refuses an event that does not exist', async () => {
    const { worldId } = await judgeable();

    const response = await request(app)
      .put('/api/events/no-such-event/results')
      .set(authHeader(staffUser('admin')))
      .send(podium(worldId));

    expect(response.status).toBe(404);
  });

  it('refuses an announcement, which has no entries to place in it', async () => {
    const { worldId } = await judgeable();
    const notice = Event.create({
      type: 'announcement',
      title: 'Maintenance',
      bannerText: 'Down for an hour.',
      body: 'Back shortly.',
      startsAt: at(-120),
      endsAt: at(-60)
    });

    const response = await announce(notice, podium(worldId), staffUser('admin'));

    expect(response.status).toBe(400);
  });

  it('refuses a listing that does not exist', async () => {
    const { event } = await judgeable();

    const response = await announce(event, podium('no-such-world'), staffUser('admin'));

    expect(response.status).toBe(404);
  });

  it('refuses a listing entered in nothing', async () => {
    const { event } = await judgeable();
    const outsider = await publish(author(), { name: 'Not Entered' });

    const response = await announce(event, podium(outsider.body.data.id), staffUser('admin'));

    expect(response.status).toBe(409);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('refuses an entry that was withdrawn', async () => {
    const { event, user, worldId } = await judgeable();
    await request(app).delete(`/api/worlds/${worldId}/contest`).set(authHeader(user));

    const response = await announce(event, podium(worldId), staffUser('admin'));

    expect(response.status).toBe(409);
  });

  it('refuses a quarantined entry in any place, not only gold', async () => {
    const { event, ids } = await judgeableThree();
    await request(app).put(`/api/worlds/${ids[2]}/quarantine`).set(authHeader(staffUser())).send({});

    const response = await announce(event, podium(...ids), staffUser('admin'));

    expect(response.status).toBe(409);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('refuses the announcer their own entry in any place, not only gold', async () => {
    // Staff enter contests like anyone else in a community this size; not judging your own is the rule
    // that makes that fine, and it has to cover every place or the rule is only about gold.
    const announcer = staffUser('admin');
    const event = contest();
    const other = author();
    const theirs = await publish(other, { contestEventId: event.id, name: 'Theirs' });
    const own = await publish(announcer, { contestEventId: event.id, name: 'Mine' });
    Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });

    const response = await announce(
      event,
      podium(theirs.body.data.id, own.body.data.id),
      announcer
    );

    expect(response.status).toBe(409);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('refuses the same world in two places', async () => {
    const { event, ids } = await judgeableThree();

    const response = await announce(event, podium(ids[0], ids[0]), staffUser('admin'));

    expect(response.status).toBe(400);
    expect(placementRows(event.id)).toEqual([]);
  });

  it.each([
    ['silver with no gold', [2]],
    ['bronze with no silver', [1, 3]],
    ['bronze alone', [3]]
  ])('refuses a podium with a gap — %s', async (_label, places) => {
    const { event, ids } = await judgeableThree();

    const response = await announce(
      event,
      { placements: places.map((place, index) => ({ place, worldId: ids[index] })) },
      staffUser('admin')
    );

    expect(response.status).toBe(400);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('refuses an empty podium, so nothing can be announced about nothing', async () => {
    const { event } = await judgeable();

    const response = await announce(event, { placements: [] }, staffUser('admin'));

    expect(response.status).toBe(400);
    expect(broadcasts().every((message) => !message.body.includes('has been judged'))).toBe(true);
  });

  it('refuses a fourth place', async () => {
    const { event, ids } = await judgeableThree();

    const response = await announce(
      event,
      { placements: [...podium(...ids).placements, { place: 3, worldId: ids[0] }] },
      staffUser('admin')
    );

    expect(response.status).toBe(400);
  });

  it('refuses a second announcement, and announces nothing further', async () => {
    const { event, ids } = await judgeableThree();
    await announce(event, podium(ids[0]), staffUser('admin'));
    const announced = broadcasts().length;

    const response = await announce(event, podium(ids[1]), staffUser('admin'));

    expect(response.status).toBe(409);
    expect(placementRows(event.id).map((row) => row.world_id)).toEqual([ids[0]]);
    expect(broadcasts()).toHaveLength(announced);
  });

  it('lets a placed entrant edit their listing again', async () => {
    const { event, user, worldId } = await judgeable();

    await announce(event, podium(worldId), staffUser('admin'));

    const response = await request(app)
      .put(`/api/worlds/${worldId}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(200);
  });

  it('lets every other entrant edit again too', async () => {
    const { event, worldId, runnerUp, runnerUpId } = await judgeablePair();

    await announce(event, podium(worldId), staffUser('admin'));

    const response = await request(app)
      .put(`/api/worlds/${runnerUpId}`)
      .set(authHeader(runnerUp))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(200);
  });

  it('holds the lock until the announcement, not until a place is decided', async () => {
    // The lock lifts at the announcement, so judging finishes before entries reopen. Storing a podium
    // without announcing it is not a state a route offers, so the stored placement stands in for it.
    const { event, user, worldId } = await judgeable();
    Event.setPlacements(event.id, [
      { place: 1, worldId, name: 'The Entry', authorName: user.username }
    ]);

    const response = await request(app)
      .put(`/api/worlds/${worldId}`)
      .set(authHeader(user))
      .send({ name: 'Rewritten' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_LOCKED');
  });

  it.each([[1], [2], [3]])('refuses to let the world in place %i be withdrawn', async (place) => {
    const { event, entrants, ids } = await judgeableThree();
    await announce(event, podium(...ids), staffUser('admin'));

    const response = await request(app)
      .delete(`/api/worlds/${ids[place - 1]}/contest`)
      .set(authHeader(entrants[place - 1]));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONTEST_PLACED');
    expect(entryOf(ids[place - 1])).toBe(event.id);
  });

  it('still lets an entrant who placed nowhere withdraw', async () => {
    const { event, runnerUp, runnerUpId, worldId } = await judgeablePair();
    await announce(event, podium(worldId), staffUser('admin'));

    const response = await request(app)
      .delete(`/api/worlds/${runnerUpId}/contest`)
      .set(authHeader(runnerUp));

    expect(response.status).toBe(200);
    expect(entryOf(runnerUpId)).toBeNull();
  });

  it('keeps every place after its listing is deleted', async () => {
    const { event, entrants, ids } = await judgeableThree();
    await announce(event, podium(...ids), staffUser('admin'));

    await request(app).delete(`/api/worlds/${ids[1]}`).set(authHeader(entrants[1]));

    expect(placementRows(event.id)).toEqual([
      { place: 1, world_id: ids[0], world_name: 'The Entry', author_name: entrants[0].username },
      { place: 2, world_id: null, world_name: 'Runner Up', author_name: entrants[1].username },
      { place: 3, world_id: ids[2], world_name: 'Third Wheel', author_name: entrants[2].username }
    ]);
  });
});

describe('editing an announced podium', () => {
  /** A contest with its full podium already announced, and the ids to rearrange it with. */
  const announced = async () => {
    const seeded = await judgeableThree();
    const admin = staffUser('admin');
    await announce(seeded.event, podium(...seeded.ids), admin);
    db.prepare('DELETE FROM audit_log').run();
    return { ...seeded, admin };
  };

  it('refuses staff who are not administrators', async () => {
    const { event, ids } = await announced();

    const response = await editPodium(event, podium(ids[1], ids[0]), staffUser('mod'));

    expect(response.status).toBe(403);
    expect(placementRows(event.id).map((row) => row.world_id)).toEqual(ids);
  });

  it('refuses a contest that has not announced yet', async () => {
    const { event, ids } = await judgeableThree();

    const response = await editPodium(event, podium(ids[0]), staffUser('admin'));

    expect(response.status).toBe(409);
    expect(placementRows(event.id)).toEqual([]);
  });

  it('rearranges the podium wholesale, swaps included', async () => {
    const { event, ids, admin } = await announced();

    const response = await editPodium(event, podium(ids[1], ids[0], ids[2]), admin);

    expect(response.status).toBe(200);
    expect(placementRows(event.id).map((row) => row.world_id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it('adds a place that was left off', async () => {
    const { event, ids, admin } = await judgeableThree().then(async (seeded) => {
      const staff = staffUser('admin');
      await announce(seeded.event, podium(seeded.ids[0]), staff);
      return { ...seeded, admin: staff };
    });

    const response = await editPodium(event, podium(ids[0], ids[1]), admin);

    expect(response.status).toBe(200);
    expect(placementRows(event.id)).toHaveLength(2);
  });

  it('announces nothing, however much moves', async () => {
    const { event, ids, admin } = await announced();
    const before = broadcasts().length;

    await editPodium(event, podium(ids[2], ids[1], ids[0]), admin);

    expect(broadcasts()).toHaveLength(before);
  });

  it('logs one entry per place that actually moved', async () => {
    const { event, entrants, ids, admin } = await announced();

    // Gold and silver swap; bronze stays put and should leave no line behind.
    await editPodium(event, podium(ids[1], ids[0], ids[2]), admin);

    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'podium_edited',
        actor_username: admin.username,
        target_username: entrants[1].username,
        target_name: event.title,
        snippet: `First place: Runner Up by ${entrants[1].username} (was The Entry)`
      }),
      expect.objectContaining({
        action: 'podium_edited',
        target_username: entrants[0].username,
        snippet: `Second place: The Entry by ${entrants[0].username} (was Runner Up)`
      })
    ]);
  });

  it('logs a place that was dropped', async () => {
    const { event, ids, admin } = await announced();

    await editPodium(event, podium(ids[0], ids[1]), admin);

    expect(auditRows()).toEqual([expect.objectContaining({
      action: 'podium_edited',
      snippet: 'Third place: cleared (was Third Wheel)'
    })]);
  });

  it('leaves the contest decided, and the announcement stamp untouched', async () => {
    const { event, ids, admin } = await announced();
    const stamp = eventRow(event.id).results_announced_at;

    await editPodium(event, podium(ids[2]), admin);

    expect(eventRow(event.id).results_announced_at).toBe(stamp);
  });

  it('applies the same eligibility guards the announcement did', async () => {
    const { event, ids, admin } = await announced();
    await request(app).put(`/api/worlds/${ids[1]}/quarantine`).set(authHeader(staffUser())).send({});

    const quarantined = await editPodium(event, podium(ids[1]), admin);
    const duplicated = await editPodium(event, podium(ids[0], ids[0]), admin);
    const gapped = await editPodium(event, { placements: [{ place: 2, worldId: ids[0] }] }, admin);

    expect([quarantined.status, duplicated.status, gapped.status]).toEqual([409, 400, 400]);
    expect(placementRows(event.id).map((row) => row.world_id)).toEqual(ids);
  });
});

describe('calling a contest off', () => {
  it('releases every entry it had', async () => {
    const event = contest();
    const first = await publish(author(), { contestEventId: event.id, name: 'First' });
    const second = await publish(author(), { contestEventId: event.id, name: 'Second' });
    const untouched = await publish(author(), { name: 'Untouched' });

    await request(app)
      .post(`/api/events/${event.id}/cancel`)
      .set(authHeader(staffUser('admin')))
      .send({});

    expect(entryOf(first.body.data.id)).toBeNull();
    expect(entryOf(second.body.data.id)).toBeNull();
    expect(entryOf(untouched.body.data.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM worlds').get().count).toBe(3);
  });
});

describe('a client that has never heard of contests', () => {
  it('publishes exactly as it always did while one is running', async () => {
    contest();

    const response = await publish(author());

    expect(response.status).toBe(201);
    expect(entryOf(response.body.data.id)).toBeNull();
  });

  it('gets the catalog row it has always got, plus the entry marker and nothing else', async () => {
    // A drift guard rather than a description: everything here is a field an old client already reads
    // past, so a column that leaks in by accident should have to be added deliberately.
    contest();
    await publish(author());

    const response = await request(app).get('/api/worlds');

    expect(Object.keys(response.body.data[0]).sort()).toEqual([
      'author', 'comment_count', 'contest_event_id', 'created_at', 'description', 'downloads', 'id',
      'kind', 'likes', 'name', 'quarantine_expires_at', 'quarantine_extended', 'quarantined_at',
      'spoiler', 'tags', 'thumbnailUrl', 'thumbnail_file', 'updated_at'
    ]);
  });
});

describe('an announce with a malformed body', () => {
  it('reads as a bad request rather than a broken server', async () => {
    const { event, worldId } = await judgeable();
    const header = authHeader(staffUser('admin'));
    const send = (body) => request(app).put(`/api/events/${event.id}/results`).set(header).send(body);

    const missing = await send({});
    const notAList = await send({ placements: { place: 1, worldId } });
    const wrongType = await send({ placements: [{ place: 1, worldId: { id: 'nope' } }] });
    const wrongPlace = await send({ placements: [{ place: '1', worldId }] });

    expect([missing.status, notAList.status, wrongType.status, wrongPlace.status])
      .toEqual([400, 400, 400, 400]);
  });
});
