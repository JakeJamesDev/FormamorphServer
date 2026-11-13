import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { mergeUsers } = require('../src/utils/mergeUsers');
const { PLACEHOLDER_USERNAME } = require('../src/config/accountDeletion');

/**
 * Folding a second account into the first. The work moves, the duplicates go, the old name is gone, and a
 * dry run reports all of it while changing nothing.
 */

const publish = async (user, name) =>
  (await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload({ name }))).body.data;

const comment = (user, worldId) =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content: 'A remark' });

const like = (user, worldId) =>
  request(app).put(`/api/worlds/${worldId}/like`).set(authHeader(user)).send({ liked: true });

const follow = (user, id) => request(app).put(`/api/users/${id}/follow`).set(authHeader(user));

const readListing = (id) => request(app).get(`/api/worlds/${id}`);

const rows = (sql, ...args) => db.prepare(sql).all(...args);

/** Everything a merge could touch, for comparing before and after. */
const snapshot = () => JSON.stringify({
  users: rows('SELECT id, username FROM users ORDER BY id'),
  worlds: rows('SELECT id, author_id FROM worlds ORDER BY id'),
  comments: rows('SELECT id, author_id FROM comments ORDER BY id'),
  likes: rows('SELECT world_id, user_id FROM world_likes ORDER BY 1, 2'),
  follows: rows('SELECT follower_id, followed_id FROM follows ORDER BY 1, 2'),
  placements: rows('SELECT event_id, author_name FROM event_placements ORDER BY 1')
});

const addPlacement = (worldId, authorName) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO events (id, type, title, banner_text, body, starts_at, ends_at, created_at, updated_at)
    VALUES ('e-1', 'contest', 'Autumn Ruins', 'Banner', 'Body', ?, ?, ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
    VALUES ('e-1', 1, ?, 'Sedge Landing', ?, ?)
  `).run(worldId, authorName, now);
};

/** Two accounts of one author, with a reader who follows both, and each account having liked the other. */
const seedPair = async () => {
  const main = createUser({ username: 'wren_hallow' });
  const spare = createUser({ username: 'wren_spare' });
  const reader = createUser({ username: 'reader' });
  const mainWorld = await publish(main, 'Sedge Landing');
  const spareWorld = await publish(spare, 'Marsh Light');
  await comment(spare, spareWorld.id);
  await comment(reader, spareWorld.id);
  expect((await follow(reader, main.id)).status).toBeLessThan(300);
  expect((await follow(reader, spare.id)).status).toBeLessThan(300);
  expect((await follow(main, spare.id)).status).toBeLessThan(300);
  expect((await like(main, spareWorld.id)).status).toBeLessThan(300);
  expect((await like(reader, spareWorld.id)).status).toBeLessThan(300);
  addPlacement(spareWorld.id, spare.username);
  return { main, spare, reader, mainWorld, spareWorld };
};

describe('a dry run', () => {
  it('reports the merge and changes nothing', async () => {
    const { main, spare } = await seedPair();
    const before = snapshot();

    const summary = await mergeUsers(spare.username, main.username);

    expect(summary.dryRun).toBe(true);
    expect(summary.moved['worlds.author_id']).toBe(1);
    expect(summary.moved['comments.author_id']).toBe(1);
    expect(summary.dropped['follows.followed_id']).toBe(1);
    expect(summary.selfFollows).toBe(1);
    expect(summary.selfLikes).toBe(1);
    expect(summary.placements).toBe(1);
    expect(snapshot()).toBe(before);
  });
});

describe('a merge', () => {
  it('moves the listings and comments to the kept account', async () => {
    const { main, spare, spareWorld } = await seedPair();

    await mergeUsers(spare.username, main.username, { dryRun: false });

    expect(rows('SELECT author_id FROM worlds').map((w) => w.author_id)).toEqual([main.id, main.id]);
    const shown = await readListing(spareWorld.id);
    expect(shown.body.data.author.username).toBe(main.username);
    expect(rows('SELECT COUNT(*) AS n FROM comments WHERE author_id = ?', main.id)[0].n).toBe(1);
  });

  it('keeps one follow from a reader who followed both, and drops following yourself', async () => {
    const { main, spare, reader } = await seedPair();

    await mergeUsers(spare.username, main.username, { dryRun: false });

    expect(rows('SELECT follower_id, followed_id FROM follows ORDER BY 1')).toEqual([
      { follower_id: reader.id, followed_id: main.id }
    ]);
  });

  it('drops a like on what is now your own listing and keeps everyone else’s', async () => {
    const { main, spare, reader, spareWorld } = await seedPair();

    await mergeUsers(spare.username, main.username, { dryRun: false });

    expect(rows('SELECT user_id FROM world_likes WHERE world_id = ?', spareWorld.id)).toEqual([
      { user_id: reader.id }
    ]);
  });

  it('erases the old account and puts the kept name on its podium', async () => {
    const { main, spare } = await seedPair();

    await mergeUsers(spare.username, main.username, { dryRun: false });

    expect(rows('SELECT id FROM users WHERE id = ?', spare.id)).toEqual([]);
    expect(rows('SELECT author_name FROM event_placements')).toEqual([{ author_name: main.username }]);
  });

  it('writes the merge to the audit log under the kept account', async () => {
    const { main, spare } = await seedPair();

    await mergeUsers(spare.username, main.username, { dryRun: false });

    expect(rows("SELECT target_user_id, snippet FROM audit_log WHERE action = 'account_merged'")).toEqual([
      { target_user_id: main.id, snippet: spare.username }
    ]);
  });
});

describe('a refused merge', () => {
  it('stops on a foreign key it has no rule for, before changing anything', async () => {
    const { main, spare } = await seedPair();
    db.exec('CREATE TABLE scratch_refs (user_id TEXT REFERENCES users (id) ON DELETE CASCADE)');
    const before = snapshot();
    try {
      await expect(mergeUsers(spare.username, main.username, { dryRun: false }))
        .rejects.toThrow('No merge rule for: scratch_refs.user_id');
      expect(snapshot()).toBe(before);
    } finally {
      db.exec('DROP TABLE scratch_refs');
    }
  });

  it('stops when both accounts hold a watermark mark, since one would be lost', async () => {
    const { main, spare } = await seedPair();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO watermark_marks (user_id, mark, created_at) VALUES (?, 1, ?), (?, 2, ?)')
      .run(main.id, now, spare.id, now);
    const before = snapshot();
    try {
      await expect(mergeUsers(spare.username, main.username, { dryRun: false }))
        .rejects.toThrow('Both accounts have watermark_marks.user_id');
      expect(snapshot()).toBe(before);
    } finally {
      db.exec('DELETE FROM watermark_marks');
    }
  });

  it('moves a watermark mark held only by the old account', async () => {
    const { main, spare } = await seedPair();
    db.prepare('INSERT INTO watermark_marks (user_id, mark, created_at) VALUES (?, 7, ?)')
      .run(spare.id, new Date().toISOString());
    try {
      await mergeUsers(spare.username, main.username, { dryRun: false });
      expect(rows('SELECT user_id, mark FROM watermark_marks')).toEqual([{ user_id: main.id, mark: 7 }]);
    } finally {
      db.exec('DELETE FROM watermark_marks');
    }
  });

  it('refuses the placeholder and an account merged into itself', async () => {
    const main = createUser({ username: 'wren_hallow' });

    await expect(mergeUsers(PLACEHOLDER_USERNAME, main.username)).rejects.toThrow('placeholder');
    await expect(mergeUsers(main.username, main.username)).rejects.toThrow('same account');
    await expect(mergeUsers('nobody', main.username)).rejects.toThrow("'nobody' not found");
  });
});
