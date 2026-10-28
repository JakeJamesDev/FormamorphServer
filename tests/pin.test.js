import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Pin — staff put any listing first in the catalog, newest pin first, whatever sort the player chose.
 */

const staffUser = (username = 'root-admin', accountType = 'admin') => createUser({ username, accountType });

const publish = async (user, over = {}) =>
  (await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over))).body.data.id;

const pin = (actor, id) => {
  const r = request(app).put(`/api/worlds/${id}/pin`);
  return (actor ? r.set(authHeader(actor)) : r).send({});
};

const unpin = (actor, id) => request(app).delete(`/api/worlds/${id}/pin`).set(authHeader(actor));

const names = async (query = '') =>
  (await request(app).get(`/api/worlds${query}`)).body.data.map((w) => w.name);

/** Make pin times distinct and ordered, since two pins in one millisecond would tie. */
const pinAt = (id, iso) => db.prepare('UPDATE worlds SET pinned_at = ? WHERE id = ?').run(iso, id);

/** Three worlds whose natural orders differ per sort, so a pin has to beat all of them. */
const seed = async () => {
  const author = createUser({ username: 'author' });
  const a = await publish(author, { name: 'Alpha' });
  const b = await publish(author, { name: 'Bravo' });
  const c = await publish(author, { name: 'Charlie' });
  db.prepare("UPDATE worlds SET downloads = CASE name WHEN 'Alpha' THEN 1 WHEN 'Bravo' THEN 2 ELSE 3 END").run();
  return { author, a, b, c };
};

describe('who can Pin', () => {
  it('lets an administrator and a moderator pin and unpin', async () => {
    const { a, b } = await seed();

    const pinned = await pin(staffUser(), a);
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.id).toBe(a);
    expect(pinned.body.data.pinnedAt).toBeTruthy();

    expect((await pin(staffUser('a-mod', 'mod'), b)).status).toBe(200);
    expect((await unpin(staffUser('another-mod', 'mod'), b)).status).toBe(200);
  });

  it('refuses the listing author and any other account with a 403', async () => {
    const { author, a } = await seed();
    const other = createUser({ username: 'someone' });

    expect((await pin(author, a)).status).toBe(403);
    expect((await pin(other, a)).status).toBe(403);
    expect((await unpin(author, a)).status).toBe(403);
    expect((await pin(null, a)).status).toBe(401);
    expect(db.prepare('SELECT pinned_at FROM worlds WHERE id = ?').get(a).pinned_at).toBeNull();
  });

  it('answers 404 for a listing that does not exist', async () => {
    await seed();
    expect((await pin(staffUser(), 'no-such-world')).status).toBe(404);
  });
});

describe('catalog order', () => {
  const SORTS = ['created_at', 'updated_at', 'downloads', 'name', 'likes'];

  it('puts pinned listings first, newest pin first, under every sort and direction', async () => {
    const { a, b } = await seed();
    pinAt(a, '2000-01-01T00:00:00.000Z');
    pinAt(b, '2000-02-01T00:00:00.000Z');

    for (const sort of SORTS) {
      for (const order of ['asc', 'desc']) {
        const listed = await names(`?sort=${sort}&order=${order}`);
        expect(listed.slice(0, 2), `${sort} ${order}`).toEqual(['Bravo', 'Alpha']);
        expect(listed).toHaveLength(3);
      }
    }
  });

  it('keeps pins ahead on the page after the first', async () => {
    const { c } = await seed();
    pinAt(c, '2000-01-01T00:00:00.000Z');

    // Alpha sorts first by name, yet the pinned Charlie still leads page one.
    expect(await names('?sort=name&order=asc&limit=1&page=1')).toEqual(['Charlie']);
    expect(await names('?sort=name&order=asc&limit=1&page=2')).toEqual(['Alpha']);
  });

  it('leads an all-kinds read with a pinned listing of any kind', async () => {
    const author = createUser({ username: 'author' });
    // The pinned listings are the oldest, so only the pin puts them ahead of the newest-first default.
    const entity = await publish(author, { name: 'Pinned Entity', kind: 'entity' });
    const dict = await publish(author, { name: 'Pinned Dictionary', kind: 'dictionary' });
    await publish(author, { name: 'A World' });
    await publish(author, { name: 'Other Entity', kind: 'entity' });
    db.prepare("UPDATE worlds SET created_at = '2001-01-01 00:00:00', listed_at = '2001-01-01 00:00:00' WHERE name LIKE 'Pinned%'").run();
    pinAt(entity, '2000-01-01T00:00:00.000Z');
    pinAt(dict, '2000-02-01T00:00:00.000Z');

    expect((await names('?kind=all')).slice(0, 2)).toEqual(['Pinned Dictionary', 'Pinned Entity']);
    expect((await names('?kind=entity'))[0]).toBe('Pinned Entity');
    expect(await names('?kind=world')).toEqual(['A World']);
  });

  it('moves a re-pinned listing back to the top', async () => {
    const { a, b } = await seed();
    const root = staffUser();
    await pin(root, a);
    await pin(root, b);
    pinAt(a, '2000-01-01T00:00:00.000Z');
    pinAt(b, '2000-02-01T00:00:00.000Z');
    expect((await names()).slice(0, 2)).toEqual(['Bravo', 'Alpha']);

    await pin(root, a);

    expect((await names()).slice(0, 2)).toEqual(['Alpha', 'Bravo']);
  });

  it('restores an unpinned listing to its normal position', async () => {
    const { c } = await seed();
    const root = staffUser();
    const before = await names('?sort=name&order=asc');
    expect(before).toEqual(['Alpha', 'Bravo', 'Charlie']);

    await pin(root, c);
    expect(await names('?sort=name&order=asc')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    const res = await unpin(root, c);

    expect(res.status).toBe(200);
    expect(res.body.data.pinnedAt).toBeNull();
    expect(await names('?sort=name&order=asc')).toEqual(before);
  });

  it('does not change the listing\'s updated time', async () => {
    const { a } = await seed();
    const before = db.prepare('SELECT updated_at FROM worlds WHERE id = ?').get(a).updated_at;

    await pin(staffUser(), a);

    expect(db.prepare('SELECT updated_at FROM worlds WHERE id = ?').get(a).updated_at).toBe(before);
  });
});

describe('payloads', () => {
  it('carries pinned_at in the catalog and the detail read, null when unpinned', async () => {
    const { a, b } = await seed();
    await pin(staffUser(), a);

    const list = (await request(app).get('/api/worlds')).body.data;
    expect(list.find((w) => w.id === a).pinned_at).toEqual(expect.any(String));
    expect(list.find((w) => w.id === b).pinned_at).toBeNull();

    expect((await request(app).get(`/api/worlds/${a}`)).body.data.pinned_at).toEqual(expect.any(String));
    expect((await request(app).get(`/api/worlds/${b}`)).body.data.pinned_at).toBeNull();
  });
});

describe('audit', () => {
  it('records a Pin and an Unpin, and skips an Unpin that changed nothing', async () => {
    const { a, b } = await seed();
    const root = staffUser();

    await pin(root, a);
    await unpin(root, a);
    await unpin(root, b);

    const log = (await request(app).get('/api/audit').set(authHeader(root))).body.data;
    expect(log.map((e) => e.action).sort()).toEqual(['listing_pinned', 'listing_unpinned']);
  });
});
