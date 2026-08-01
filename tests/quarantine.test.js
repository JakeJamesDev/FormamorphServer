import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { sweepQuarantine } = require('../src/utils/sweepQuarantine');

/**
 * Quarantine — a listing taken out of circulation rather than deleted, so its author has a stated number
 * of days to fix it.
 *
 * The three things it has to get right: the room cannot see it (and cannot tell it exists), the author
 * can still work on it, and the deadline is real even if nothing is watching the clock.
 */

const admin = (username = 'root-admin') => createUser({ username, accountType: 'admin' });

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const quarantine = (actor, id, body = {}) =>
  request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(actor)).send(body);

const release = (actor, id) =>
  request(app).delete(`/api/worlds/${id}/quarantine`).set(authHeader(actor));

const readOne = (id, user) => {
  const r = request(app).get(`/api/worlds/${id}`);
  return user ? r.set(authHeader(user)) : r;
};

const list = (user, query = '') => {
  const r = request(app).get(`/api/worlds${query}`);
  return user ? r.set(authHeader(user)) : r;
};

const download = (id, user) => {
  const r = request(app).get(`/api/worlds/${id}/content`);
  return user ? r.set(authHeader(user)) : r;
};

const entries = async (user, query = '') =>
  (await request(app).get(`/api/audit${query}`).set(authHeader(user))).body.data;

/** Publish one listing and hand back its author, an admin, and the id. */
const seed = async (over = {}) => {
  const root = admin();
  const author = createUser({ username: 'author' });
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;
  return { root, author, id };
};

/** Move a quarantine's deadline into the past without waiting for it. */
const expire = (id) =>
  db.prepare("UPDATE worlds SET quarantine_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

describe('putting something into quarantine', () => {
  it('is an admin action', async () => {
    const { root, id } = await seed();

    const res = await quarantine(root, id);

    expect(res.status).toBe(200);
    expect(res.body.data.quarantineExpiresAt).toBeTruthy();
  });

  it('is refused to the author, who would otherwise hide their own work', async () => {
    const { author, id } = await seed();

    expect((await quarantine(author, id)).status).toBe(403);
  });

  it('is refused to a signed-out visitor', async () => {
    const { id } = await seed();

    expect((await request(app).put(`/api/worlds/${id}/quarantine`).send({})).status).toBe(401);
  });

  it('runs seven days unless the admin says otherwise', async () => {
    const { root, id } = await seed();

    const res = await quarantine(root, id);

    const days = (new Date(res.body.data.quarantineExpiresAt) - new Date(res.body.data.quarantinedAt)) / 86400000;
    expect(Math.round(days)).toBe(7);
  });

  it('takes the number of days the admin chose', async () => {
    const { root, id } = await seed();

    const res = await quarantine(root, id, { days: 3 });

    const days = (new Date(res.body.data.quarantineExpiresAt) - new Date(res.body.data.quarantinedAt)) / 86400000;
    expect(Math.round(days)).toBe(3);
  });

  it('refuses a length that is not a sensible number of whole days', async () => {
    const { root, id } = await seed();

    for (const days of [0, -1, 1.5, 91, 'soon', null]) {
      expect((await quarantine(root, id, { days })).status).toBe(400);
    }
  });

  it('404s on a listing that does not exist', async () => {
    expect((await quarantine(admin(), 'no-such-world')).status).toBe(404);
  });
});

describe('who can see something in quarantine', () => {
  it('hides it from the catalog', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    expect((await list(null)).body.data.map((w) => w.id)).not.toContain(id);
  });

  it('hides it from another signed-in account', async () => {
    const { root, id } = await seed();
    const stranger = createUser({ username: 'stranger' });
    await quarantine(root, id);

    expect((await list(stranger)).body.data.map((w) => w.id)).not.toContain(id);
  });

  it('leaves it in the author’s view of the catalog', async () => {
    // They have to be able to find the thing they are being asked to fix.
    const { root, author, id } = await seed();
    await quarantine(root, id);

    expect((await list(author)).body.data.map((w) => w.id)).toContain(id);
  });

  it('leaves it in an admin’s view', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    expect((await list(root)).body.data.map((w) => w.id)).toContain(id);
  });

  it('answers 404 to anyone else asking for it directly', async () => {
    // The same answer a deleted listing gives, so its existence is not something to probe for.
    const { root, id } = await seed();
    const stranger = createUser({ username: 'stranger' });
    await quarantine(root, id);

    expect((await readOne(id, null)).status).toBe(404);
    expect((await readOne(id, stranger)).status).toBe(404);
  });

  it('still opens for the author and for an admin', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    expect((await readOne(id, owner)).status).toBe(200);
    expect((await readOne(id, root)).status).toBe(200);
  });

  it('refuses the download to everyone else', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    expect((await download(id, null)).status).toBe(404);
    expect((await download(id, createUser({ username: 'stranger' }))).status).toBe(404);
  });

  it('does not count a refused download', async () => {
    // A refusal that still bumped the counter would be a lie in the other direction.
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    await download(id, null);

    expect((await readOne(id, owner)).body.data.downloads).toBe(0);
  });

  it('still lets the author download their own', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    expect((await download(id, owner)).status).toBe(200);
  });

  it('gives staff the whole catalog, quarantined listings included', async () => {
    // There is no queue-only parameter: the client narrows this list itself, so what staff ask for is
    // everything, with the hidden ones in it.
    const { root, id } = await seed();
    const other = (await publish(createUser({ username: 'other' }), { name: 'The Long Tally' })).body.data.id;
    await quarantine(root, id);

    const ids = (await list(root)).body.data.map((w) => w.id);

    expect(ids).toContain(id);
    expect(ids).toContain(other);
  });

  it('cannot be talked into listing the queue by a query parameter', async () => {
    // The old `?quarantined=true` is gone. An unknown parameter must be ignored rather than honored —
    // otherwise it is a way to enumerate exactly what is hidden.
    const { root, id } = await seed();
    await quarantine(root, id);
    const stranger = createUser({ username: 'stranger' });

    expect((await list(stranger, '?quarantined=true')).body.data.map((w) => w.id)).not.toContain(id);
  });
});

describe('comments while quarantined', () => {
  const comment = (user, worldId, content = 'Anything at all.') =>
    request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content });

  it('are refused, the author included', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    expect((await comment(owner, id)).status).toBe(403);
    expect((await comment(createUser({ username: 'stranger' }), id)).status).toBe(403);
  });

  it('are refused to an admin too', async () => {
    // A thread growing under something out of circulation would outlive the listing.
    const { root, id } = await seed();
    await quarantine(root, id);

    expect((await comment(root, id)).status).toBe(403);
  });

  it('hide the existing thread along with the listing', async () => {
    const { root, author: owner, id } = await seed();
    await comment(owner, id, 'Said before any of this.');
    await quarantine(root, id);

    expect((await request(app).get(`/api/worlds/${id}/comments`)).status).toBe(404);
  });

  it('come back when the quarantine is lifted', async () => {
    const { root, author: owner, id } = await seed();
    await comment(owner, id, 'Said before any of this.');
    await quarantine(root, id);
    await release(root, id);

    const res = await request(app).get(`/api/worlds/${id}/comments`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.content)).toEqual(['Said before any of this.']);
  });
});

describe('the author fixing it', () => {
  const update = (user, id, over = {}) =>
    request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(worldPayload({ name: 'Sedge Landing', ...over }));

  it('is allowed while quarantined', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    expect((await update(owner, id, { description: 'Fixed.' })).status).toBe(200);
  });

  it('buys seven more days, once', async () => {
    const { root, author: owner, id } = await seed();
    const before = (await quarantine(root, id)).body.data.quarantineExpiresAt;

    await update(owner, id, { description: 'Fixed.' });

    const after = db.prepare('SELECT quarantine_expires_at AS at, quarantine_extended AS ext FROM worlds WHERE id = ?').get(id);
    expect(Math.round((new Date(after.at) - new Date(before)) / 86400000)).toBe(7);
    expect(after.ext).toBe(1);
  });

  it('does not buy more on the second update', async () => {
    // The grace is so that fixing it on day six is not deleted on day seven — not a way to edit forever.
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);
    await update(owner, id, { description: 'Fixed.' });
    const afterFirst = db.prepare('SELECT quarantine_expires_at AS at FROM worlds WHERE id = ?').get(id).at;

    await update(owner, id, { description: 'Fixed again.' });

    expect(db.prepare('SELECT quarantine_expires_at AS at FROM worlds WHERE id = ?').get(id).at).toBe(afterFirst);
  });

  it('is recorded either way', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    await update(owner, id, { description: 'Fixed.' });
    await update(owner, id, { description: 'Fixed again.' });

    const updates = (await entries(root)).filter((e) => e.action === 'quarantine_updated');
    expect(updates).toHaveLength(2);
    expect(updates[1].snippet).toMatch(/extended/i);
    expect(updates[0].snippet).toMatch(/already been extended/i);
  });

  it('gets its grace back on a later, separate quarantine', async () => {
    // Each episode is its own: a listing is not punished for an unrelated incident months earlier.
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);
    await update(owner, id, { description: 'Fixed.' });
    await release(root, id);

    const before = (await quarantine(root, id)).body.data.quarantineExpiresAt;
    await update(owner, id, { description: 'Fixed the new thing.' });

    const after = db.prepare('SELECT quarantine_expires_at AS at FROM worlds WHERE id = ?').get(id).at;
    expect(Math.round((new Date(after) - new Date(before)) / 86400000)).toBe(7);
  });

  it('gets its grace back when an admin re-quarantines without releasing', async () => {
    // Re-quarantining resets the deadline, so it starts a new episode the same way a release-then-
    // quarantine does — otherwise a second notice would arrive with the grace already spent.
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);
    await update(owner, id, { description: 'Fixed.' });

    const before = (await quarantine(root, id, { days: 5 })).body.data.quarantineExpiresAt;
    await update(owner, id, { description: 'Fixed the new thing.' });

    const after = db.prepare('SELECT quarantine_expires_at AS at FROM worlds WHERE id = ?').get(id).at;
    expect(Math.round((new Date(after) - new Date(before)) / 86400000)).toBe(7);
  });

  it('extends nothing when an admin is the one editing', async () => {
    // An admin's own edit is not the author answering the notice.
    const { root, id } = await seed();
    const before = (await quarantine(root, id)).body.data.quarantineExpiresAt;

    await update(root, id, { description: 'Tidied by the team.' });

    expect(db.prepare('SELECT quarantine_expires_at AS at FROM worlds WHERE id = ?').get(id).at).toBe(before);
    expect((await entries(root)).filter((e) => e.action === 'quarantine_updated')).toHaveLength(0);
  });

  it('records nothing on an ordinary update to something not quarantined', async () => {
    const { root, author: owner, id } = await seed();

    await update(owner, id, { description: 'Just editing.' });

    expect((await entries(root)).filter((e) => e.action === 'quarantine_updated')).toHaveLength(0);
  });
});

describe('lifting a quarantine', () => {
  it('puts it back in the catalog', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    const res = await release(root, id);

    expect(res.status).toBe(200);
    expect((await list(null)).body.data.map((w) => w.id)).toContain(id);
  });

  it('is an admin action', async () => {
    const { root, author: owner, id } = await seed();
    await quarantine(root, id);

    expect((await release(owner, id)).status).toBe(403);
  });

  it('refuses something that is not quarantined', async () => {
    const { root, id } = await seed();

    expect((await release(root, id)).status).toBe(400);
  });
});

describe('the deadline', () => {
  it('deletes the listing once it passes', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);
    expire(id);

    await sweepQuarantine();

    expect(db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c).toBe(0);
  });

  it('leaves anything still inside its deadline alone', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    await sweepQuarantine();

    expect(db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c).toBe(1);
  });

  it('never touches something that was never quarantined', async () => {
    const { id } = await seed();

    await sweepQuarantine();

    expect(db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c).toBe(1);
  });

  it('is enforced when the catalog is read, not only on a timer', async () => {
    // A server that was down over a deadline must not serve the listing again on the next request.
    const { root, id } = await seed();
    await quarantine(root, id);
    expire(id);

    await list(root);

    expect(db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c).toBe(0);
  });

  it('takes the comments with it', async () => {
    const { root, author: owner, id } = await seed();
    await request(app).post(`/api/worlds/${id}/comments`).set(authHeader(owner)).send({ content: 'Something.' });
    await quarantine(root, id);
    expire(id);

    await sweepQuarantine();

    expect(db.prepare('SELECT COUNT(*) AS c FROM comments WHERE world_id = ?').get(id).c).toBe(0);
  });
});

describe('what the log says about it', () => {
  it('records the quarantine, its subject and its deadline', async () => {
    const { root, id } = await seed();

    await quarantine(root, id, { days: 3 });

    expect((await entries(root))[0]).toMatchObject({
      action: 'listing_quarantined',
      actor: { username: 'root-admin' },
      targetUser: { username: 'author' },
      target: { kind: 'world', name: 'Sedge Landing' }
    });
    expect((await entries(root))[0].snippet).toMatch(/Deleted on/);
  });

  it('records the release', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);

    await release(root, id);

    expect((await entries(root))[0]).toMatchObject({
      action: 'quarantine_released',
      targetUser: { username: 'author' }
    });
  });

  it('records an expiry with no person behind it', async () => {
    // The server did it, so no username is invented for something nobody chose in the moment.
    const { root, id } = await seed();
    await quarantine(root, id);
    expire(id);

    await sweepQuarantine();

    const [entry] = await entries(root);
    expect(entry).toMatchObject({ action: 'quarantine_expired', target: { name: 'Sedge Landing' } });
    expect(entry.actor.username).toBeNull();
    expect(entry.targetUser.username).toBe('author');
  });

  it('keeps the kind, so a character is not filed as a world', async () => {
    const root = admin();
    const owner = createUser({ username: 'author' });
    const id = (await publish(owner, { name: 'Ilsa', kind: 'entity' })).body.data.id;

    await quarantine(root, id);

    expect((await entries(root))[0].target).toMatchObject({ kind: 'entity', name: 'Ilsa' });
  });

  it('can be narrowed to quarantine events', async () => {
    const { root, id } = await seed();
    await quarantine(root, id);
    await release(root, id);

    const res = await request(app).get('/api/audit?action=listing_quarantined').set(authHeader(root));

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].action).toBe('listing_quarantined');
  });
});
