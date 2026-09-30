import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, seedLikes } from './helpers.js';

/**
 * An author's listings and profile total while one of their entries sits in a running contest. The
 * listing rows follow the hidden-count contract; the total leaves the hidden likes out for the room, so
 * subtracting totals cannot reveal an entry's count.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const as = (req, user) => (user ? req.set(authHeader(user)) : req);

const publish = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(body));

const ENTRY_LIKES = 3;
const PLAIN_LIKES = 2;

const seed = async () => {
  const author = createUser({ username: 'reedwright' });
  const staff = createUser({ username: 'a-mod', accountType: 'mod' });
  const reader = createUser({ username: 'fenlark' });
  const event = Event.create({
    type: 'contest', title: 'Sedge Landing Contest', bannerText: 'Build.', body: 'Build.',
    startsAt: at(-60), endsAt: at(60)
  });

  const entry = (await publish(author, { name: 'Marsh Warden', kind: 'entity', contestEventId: event.id })).body.data;
  const plain = (await publish(author, { name: 'Sedge Landing' })).body.data;
  seedLikes(entry.id, [reader, createUser(), createUser()]);
  seedLikes(plain.id, [reader, createUser()]);

  return { author, staff, reader, event, entry, plain };
};

const total = async (path, user) => (await as(request(app).get(path), user)).body.data.likes;

const PROFILES = {
  'by id': (author) => `/api/users/${author.id}/profile`,
  'by username': (author) => `/api/users/by-username/${author.username}/profile`
};

describe('the listings of an author with an entry in a running contest', () => {
  it("shows the entry's count only to its author and staff on another user's listings", async () => {
    const { author, staff, reader, entry, plain } = await seed();
    const url = `/api/users/${author.id}/worlds?kind=all`;

    for (const [who, user] of [['guest', null], ['reader', reader], ['author', author], ['staff', staff]]) {
      const res = await as(request(app).get(url), user);
      expect(res.status, who).toBe(200);
      const all = res.body.data.filter((row) => [entry.id, plain.id].includes(row.id));
      const byName = Object.fromEntries(all.map((row) => [row.name, row]));

      expect(byName['Sedge Landing'].likes, who).toBe(PLAIN_LIKES);
      expect(byName['Sedge Landing'], who).not.toHaveProperty('likesHidden');

      if (who === 'author' || who === 'staff') {
        expect(byName['Marsh Warden'].likes, who).toBe(ENTRY_LIKES);
        expect(byName['Marsh Warden'].likesPrivate, who).toBe(true);
      } else {
        expect(byName['Marsh Warden'], who).not.toHaveProperty('likes');
        expect(byName['Marsh Warden'].likesHidden, who).toBe(true);
      }
    }
  });

  it('gives the author the count on their own listings', async () => {
    const { author } = await seed();

    const res = await request(app).get('/api/users/me/worlds?kind=all').set(authHeader(author));
    expect(res.status).toBe(200);
    const entry = res.body.data.find((row) => row.name === 'Marsh Warden');
    expect(entry.likes).toBe(ENTRY_LIKES);
    expect(entry.likesPrivate).toBe(true);
  });
});

describe.each(Object.keys(PROFILES))('the like total on a profile read %s', (form) => {
  it('equals the normal listing for a public reader and both for the author and staff', async () => {
    const { author, staff, reader } = await seed();
    const path = PROFILES[form](author);

    expect(await total(path, null)).toBe(PLAIN_LIKES);
    expect(await total(path, reader)).toBe(PLAIN_LIKES);
    expect(await total(path, author)).toBe(PLAIN_LIKES + ENTRY_LIKES);
    expect(await total(path, staff)).toBe(PLAIN_LIKES + ENTRY_LIKES);
  });

  it('leaves out anonymous likes on a hidden entry too', async () => {
    const { author, entry } = await seed();
    db.prepare('INSERT INTO anonymous_likes (world_id, install_id, address_hash, browser_family, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, 'install-1', 'hash-1', 'firefox', new Date().toISOString());

    expect(await total(PROFILES[form](author), null)).toBe(PLAIN_LIKES);
    expect(await total(PROFILES[form](author), author)).toBe(PLAIN_LIKES + ENTRY_LIKES + 1);
  });

  it('counts the entry for everyone once results are announced', async () => {
    const { author, event } = await seed();
    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
    Event.announceResults(event.id);

    expect(await total(PROFILES[form](author), null)).toBe(PLAIN_LIKES + ENTRY_LIKES);
  });
});
