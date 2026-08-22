import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * The Listing Changelog — an author's update history on a published listing.
 *
 * It is metadata, and every rule below follows from that one word. It lives on its own table so the
 * catalog never carries it; it is read only when it is asked for; and writing to it never moves the
 * listing's `updated_at`, because fixing a typo in last month's notes is not a new release. The lock that
 * holds a contest entry still while it is judged does not reach it either, for the reason it does not
 * reach comments: none of this is the work being judged.
 */

const named = (prefix, over = {}) =>
  createUser({ username: `${prefix}-${Math.random().toString(16).slice(2, 8)}`, ...over });

const publish = (user, over = {}) => request(app)
  .post('/api/worlds')
  .set(authHeader(user))
  .send(worldPayload(over));

const add = (user, worldId, body) => {
  const req = request(app).post(`/api/worlds/${worldId}/changelog`);
  if (user) req.set(authHeader(user));
  return req.send(body);
};

const edit = (user, worldId, entryId, body) => {
  const req = request(app).put(`/api/worlds/${worldId}/changelog/${entryId}`);
  if (user) req.set(authHeader(user));
  return req.send(body);
};

const remove = (user, worldId, entryId) => {
  const req = request(app).delete(`/api/worlds/${worldId}/changelog/${entryId}`);
  if (user) req.set(authHeader(user));
  return req.send();
};

const readOne = (worldId, user, query = '') => {
  const req = request(app).get(`/api/worlds/${worldId}${query}`);
  return user ? req.set(authHeader(user)) : req;
};

/** A valid entry body; override any field per test. */
const entry = (over = {}) => ({
  title: 'Update 1',
  body: 'The drowned quarter is walkable now.',
  date: '2026-08-01',
  ...over
});

/** One published listing and its author. */
const seed = async (over = {}) => {
  const author = named('author');
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;

  return { author, id };
};

const suspend = (user) =>
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);

const quarantine = (worldId) => db
  .prepare('UPDATE worlds SET quarantined_at = ?, quarantine_expires_at = ? WHERE id = ?')
  .run(new Date().toISOString(), new Date(Date.now() + 7 * 86400000).toISOString(), worldId);

/** Publish into a running contest, then close its window so the entry is being judged. */
const enteredThenClosed = async (user) => {
  const at = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const event = Event.create({
    type: 'contest',
    title: 'Sedge Landing Contest',
    bannerText: 'Build on Sedge Landing.',
    body: 'Build something before the week is out.',
    startsAt: at(-60),
    endsAt: at(60)
  });
  const world = await publish(user, { contestEventId: event.id });
  Event.update(event.id, { startsAt: at(-120), endsAt: at(-60) });

  return { event, worldId: world.body.data.id };
};

const rowsFor = (worldId) => db
  .prepare('SELECT * FROM world_changelog WHERE world_id = ?')
  .all(worldId);

const updatedAtOf = (worldId) =>
  db.prepare('SELECT updated_at FROM worlds WHERE id = ?').get(worldId).updated_at;

describe('adding an entry', () => {
  it('needs an account', async () => {
    const { id } = await seed();

    const response = await add(null, id, entry());

    expect(response.status).toBe(401);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('stores what the author wrote, under their own date', async () => {
    const { author, id } = await seed();

    const response = await add(author, id, entry());

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      world_id: id,
      title: 'Update 1',
      body: 'The drowned quarter is walkable now.',
      entry_date: '2026-08-01'
    });
    expect(response.body.data.id).toBeTruthy();
  });

  it('stamps both timestamps ISO, as every other timestamp this server writes is', async () => {
    const { author, id } = await seed();

    const { body } = await add(author, id, entry());

    expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(body.data.updated_at).toBe(body.data.created_at);
  });

  it('refuses somebody else entirely', async () => {
    const { id } = await seed();

    const response = await add(named('stranger'), id, entry());

    expect(response.status).toBe(403);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('refuses a suspended author', async () => {
    const { author, id } = await seed();
    suspend(author);

    const response = await add(author, id, entry());

    expect(response.status).toBe(403);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('lets a moderator through, as moderation reaches everywhere else', async () => {
    const { id } = await seed();

    const response = await add(named('mod', { accountType: 'mod' }), id, entry());

    expect(response.status).toBe(201);
  });

  it('answers a stranger about a quarantined listing as if it were not there', async () => {
    // 404 rather than 403: a quarantined listing is as absent as a deleted one, so the room must not be
    // able to learn it exists by being told it may not write to it.
    const { id } = await seed();
    quarantine(id);

    expect((await add(named('stranger'), id, entry())).status).toBe(404);
  });

  it('still takes an entry from the author of a quarantined listing', async () => {
    const { author, id } = await seed();
    quarantine(id);

    expect((await add(author, id, entry())).status).toBe(201);
  });

  it('takes an entry on a listing whose contest is being judged', async () => {
    // The lock holds the *work* still. A note about the work is not the work — the same standing that
    // comments and likes have.
    const user = named('author');
    const { worldId } = await enteredThenClosed(user);

    const response = await add(user, worldId, entry());

    expect(response.status).toBe(201);
  });

  it('404s a listing that is not there', async () => {
    expect((await add(named('author'), 'no-such-world', entry())).status).toBe(404);
  });
});

describe('what an entry may say', () => {
  it('refuses a blank title', async () => {
    const { author, id } = await seed();

    const response = await add(author, id, entry({ title: '   ' }));

    expect(response.status).toBe(400);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('refuses a blank body', async () => {
    const { author, id } = await seed();

    expect((await add(author, id, entry({ body: '  ' }))).status).toBe(400);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('refuses a title past 120 characters, and takes one exactly that long', async () => {
    const { author, id } = await seed();

    expect((await add(author, id, entry({ title: 'x'.repeat(121) }))).status).toBe(400);
    expect((await add(author, id, entry({ title: 'x'.repeat(120) }))).status).toBe(201);
  });

  it('refuses a body past 4000 characters, and takes one exactly that long', async () => {
    const { author, id } = await seed();

    expect((await add(author, id, entry({ body: 'x'.repeat(4001) }))).status).toBe(400);
    expect((await add(author, id, entry({ body: 'x'.repeat(4000) }))).status).toBe(201);
  });

  it('refuses anything that is not a calendar date', async () => {
    const { author, id } = await seed();

    // `2026-02-31` is the one the shape check alone would let through.
    for (const date of ['', 'yesterday', '2026-8-1', '2026-13-01', '2026-02-31', '2026-08-01T00:00:00Z']) {
      expect((await add(author, id, entry({ date }))).status).toBe(400);
    }

    expect(rowsFor(id)).toHaveLength(0);
  });

  it('stops at 100 entries', async () => {
    const { author, id } = await seed();
    for (let i = 0; i < 100; i++) await add(author, id, entry({ title: `Update ${i}` }));

    const response = await add(author, id, entry({ title: 'One too many' }));

    expect(response.status).toBe(400);
    expect(rowsFor(id)).toHaveLength(100);
  });
});

describe('rewriting an entry', () => {
  it('replaces all three authored fields', async () => {
    const { author, id } = await seed();
    const entryId = (await add(author, id, entry())).body.data.id;

    const response = await edit(author, id, entryId, {
      title: 'New for v2', body: 'Rewritten.', date: '2026-07-04'
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: entryId, title: 'New for v2', body: 'Rewritten.', entry_date: '2026-07-04'
    });
  });

  it('moves updated_at without touching created_at', async () => {
    const { author, id } = await seed();
    const created = (await add(author, id, entry())).body.data;

    const { body } = await edit(author, id, created.id, entry({ body: 'Rewritten.' }));

    expect(body.data.created_at).toBe(created.created_at);
    expect(Date.parse(body.data.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));
  });

  it('refuses somebody else', async () => {
    const { author, id } = await seed();
    const entryId = (await add(author, id, entry())).body.data.id;

    const response = await edit(named('stranger'), id, entryId, entry({ title: 'Vandalised' }));

    expect(response.status).toBe(403);
    expect(rowsFor(id)[0].title).toBe('Update 1');
  });

  it('will not reach an entry through a listing it does not belong to', async () => {
    // Without the pairing check the entry id alone is the address, and any listing's route becomes a door
    // onto any other listing's history.
    const mine = await seed();
    const theirs = await seed();
    const entryId = (await add(theirs.author, theirs.id, entry())).body.data.id;

    const response = await edit(mine.author, mine.id, entryId, entry({ title: 'Reached across' }));

    expect(response.status).toBe(404);
    expect(rowsFor(theirs.id)[0].title).toBe('Update 1');
  });

  it('404s an entry that is not there', async () => {
    const { author, id } = await seed();

    expect((await edit(author, id, 'no-such-entry', entry())).status).toBe(404);
  });

  it('applies the same caps as writing one', async () => {
    const { author, id } = await seed();
    const entryId = (await add(author, id, entry())).body.data.id;

    expect((await edit(author, id, entryId, entry({ title: 'x'.repeat(121) }))).status).toBe(400);
    expect((await edit(author, id, entryId, entry({ date: '2026-02-31' }))).status).toBe(400);
    expect(rowsFor(id)[0].title).toBe('Update 1');
  });
});

describe('deleting an entry', () => {
  it('takes it away and leaves the rest of the history', async () => {
    const { author, id } = await seed();
    const first = (await add(author, id, entry({ title: 'Update 1' }))).body.data.id;
    await add(author, id, entry({ title: 'Update 2', date: '2026-08-02' }));

    const response = await remove(author, id, first);

    expect(response.status).toBe(200);
    expect(rowsFor(id).map((row) => row.title)).toEqual(['Update 2']);
  });

  it('refuses somebody else', async () => {
    const { author, id } = await seed();
    const entryId = (await add(author, id, entry())).body.data.id;

    expect((await remove(named('stranger'), id, entryId)).status).toBe(403);
    expect(rowsFor(id)).toHaveLength(1);
  });

  it('lets a moderator take one down', async () => {
    const { author, id } = await seed();
    const entryId = (await add(author, id, entry())).body.data.id;

    expect((await remove(named('mod', { accountType: 'mod' }), id, entryId)).status).toBe(200);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('goes with the listing', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author));

    expect(rowsFor(id)).toHaveLength(0);
  });
});

describe('reading a changelog', () => {
  it('is absent from the listing unless it is asked for', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    const response = await readOne(id);

    expect(response.status).toBe(200);
    expect(response.body.data.changelog).toBeUndefined();
  });

  it('comes back with the listing when it is', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    const response = await readOne(id, null, '?includeChangelog=true');

    expect(response.body.data.changelog).toHaveLength(1);
    expect(response.body.data.changelog[0]).toMatchObject({ title: 'Update 1', entry_date: '2026-08-01' });
  });

  it('is an empty list on a listing with none, which is how a client tells that from an old server', async () => {
    const { id } = await seed();

    expect((await readOne(id, null, '?includeChangelog=true')).body.data.changelog).toEqual([]);
  });

  it('rides alongside the comments embed rather than replacing it', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    const response = await readOne(id, null, '?includeChangelog=true&includeComments=true');

    expect(response.body.data.changelog).toHaveLength(1);
    expect(response.body.data.comments).toEqual([]);
  });

  it('sorts by the author date, newest first', async () => {
    const { author, id } = await seed();
    await add(author, id, entry({ title: 'Middle', date: '2026-07-01' }));
    await add(author, id, entry({ title: 'Oldest', date: '2026-01-01' }));
    await add(author, id, entry({ title: 'Newest', date: '2026-08-01' }));

    const { body } = await readOne(id, null, '?includeChangelog=true');

    expect(body.data.changelog.map((row) => row.title)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('breaks a tie on the same date by which was written last', async () => {
    const { author, id } = await seed();
    await add(author, id, entry({ title: 'Written first' }));
    await add(author, id, entry({ title: 'Written second' }));

    const { body } = await readOne(id, null, '?includeChangelog=true');

    expect(body.data.changelog.map((row) => row.title)).toEqual(['Written second', 'Written first']);
  });

  it('never reaches the catalog list, however many entries a listing carries', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    const response = await request(app).get('/api/worlds');

    const row = response.body.data.find((world) => world.id === id);
    expect(row).toBeDefined();
    expect(row.changelog).toBeUndefined();
  });

  it('is not served by the download endpoint, which counts a download', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());

    const response = await request(app).get(`/api/worlds/${id}/content`);

    expect(response.status).toBe(200);
    expect(response.body.data.changelog).toBeUndefined();
    expect(JSON.stringify(response.body.data)).not.toContain('The drowned quarter is walkable now.');
  });

  it('is hidden along with a quarantined listing, and still read by its author', async () => {
    const { author, id } = await seed();
    await add(author, id, entry());
    quarantine(id);

    expect((await readOne(id, null, '?includeChangelog=true')).status).toBe(404);
    expect((await readOne(id, author, '?includeChangelog=true')).body.data.changelog).toHaveLength(1);
  });
});

describe('what a changelog write leaves alone', () => {
  it('does not mark the listing as updated', async () => {
    // The whole reason this is not a column on `worlds`: fixing a typo must not resurface a listing as
    // freshly updated, nor flash "Update Available" at everyone holding a copy.
    const { author, id } = await seed();
    const before = updatedAtOf(id);

    const entryId = (await add(author, id, entry())).body.data.id;
    await edit(author, id, entryId, entry({ body: 'Rewritten.' }));
    await remove(author, id, entryId);

    expect(updatedAtOf(id)).toBe(before);
  });
});
