import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * `/api/feedback` — the edges rather than the behavior: full pages, paging under ties, what a suspended
 * account may do, unknown ids, and input that is trying it on. The feature's own rules live in
 * `feedback.test.js`.
 */

/** Seed straight into the table — filing through the route is capped at ten an hour per account. */
const seed = (userId, count, votedBy = null) => {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = `seed-${i}`;
    const now = new Date(Date.now() - (count - i) * 1000).toISOString();
    db.prepare(`
      INSERT INTO feedback (id, type, reporter_id, title, category, body, status, created_at, updated_at)
      VALUES (?, 'suggestion', ?, ?, 'gameplay', 'Body.', 'open', ?, ?)
    `).run(id, userId, `Idea ${i}`, now, now);
    if (votedBy) {
      db.prepare('INSERT INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, votedBy, now);
    }
    ids.push(id);
  }
  return ids;
};

const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });
const reporter = (username = 'finder', over = {}) => createUser({ username, ...over });

const fileSuggestion = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'suggestion', title: 'An idea', category: 'gameplay', body: 'Body.', ...over });

describe('a full page of threads', () => {
  it('binds a hundred ids without tripping the parameter limit', async () => {
    // `unreadAmong` and `votedAmong` build an IN list per row; limit=100 is the largest page allowed.
    const user = reporter();
    seed(user.id, 100, user.id);

    const res = await request(app).get('/api/feedback?type=suggestion&scope=all&limit=100').set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.data.every((r) => r.voted === true)).toBe(true);
  });
});

describe('paging a vote-sorted board', () => {
  it('covers every row exactly once when votes tie', async () => {
    // Every suggestion sits at one vote from its own author, so the tiebreak is doing all the work.
    const user = reporter();
    seed(user.id, 25, user.id);

    const page = async (n) => (await request(app)
      .get(`/api/feedback?type=suggestion&scope=all&sort=votes&limit=10&page=${n}`)
      .set(authHeader(user))).body.data.map((r) => r.title);

    const seen = [...(await page(1)), ...(await page(2)), ...(await page(3))];

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('a suspended account', () => {
  it('can read the board but not vote, comment or file', async () => {
    const author = reporter('author');
    const id = (await fileSuggestion(author)).body.data.id;
    const banned = reporter('banned', { status: 'suspended' });

    expect((await request(app).get('/api/feedback?type=suggestion&scope=all').set(authHeader(banned))).status).toBe(200);
    expect((await request(app).put(`/api/feedback/${id}/vote`).set(authHeader(banned)).send({ voted: true })).status).toBe(403);
    expect((await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(banned)).send({ body: 'Hi' })).status).toBe(403);
    expect((await fileSuggestion(banned)).status).toBe(403);
  });
});

describe('unknown ids', () => {
  it('404s rather than throwing', async () => {
    const user = reporter();
    const root = admin();

    expect((await request(app).get('/api/feedback/nope').set(authHeader(user))).status).toBe(404);
    expect((await request(app).post('/api/feedback/nope/comments').set(authHeader(user)).send({ body: 'x' })).status).toBe(404);
    expect((await request(app).put('/api/feedback/nope/vote').set(authHeader(user)).send({ voted: true })).status).toBe(404);
    expect((await request(app).put('/api/feedback/nope/lock').set(authHeader(root)).send({ locked: true })).status).toBe(404);
    expect((await request(app).put('/api/feedback/nope/status').set(authHeader(root)).send({ status: 'open' })).status).toBe(404);
    expect((await request(app).delete('/api/feedback/nope').set(authHeader(root))).status).toBe(404);
  });
});

describe('hostile input', () => {
  it('refuses a sort key that is not a column', async () => {
    const user = reporter();
    await fileSuggestion(user);

    const res = await request(app)
      .get('/api/feedback?type=suggestion&scope=all&sort=' + encodeURIComponent("r.id; DROP TABLE feedback;--"))
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'feedback'").get().c).toBe(1);
  });

  it('refuses an inherited property as a sort key', async () => {
    const user = reporter();
    await fileSuggestion(user);

    const res = await request(app).get('/api/feedback?type=suggestion&scope=all&sort=constructor').set(authHeader(user));

    expect(res.status).toBe(200);
  });

  it('refuses an inherited property as a type or status', async () => {
    const user = reporter();

    expect((await request(app).get('/api/feedback?type=constructor').set(authHeader(user))).status).toBe(200);
    expect((await request(app).get('/api/feedback?type=bug&status=constructor').set(authHeader(user))).status).toBe(200);
  });

  it('does not let a client set its own votes or lock at filing time', async () => {
    const user = reporter();

    const res = await fileSuggestion(user, { votes: 999, locked_at: 'now', status: 'planned', id: 'chosen' });

    expect(res.body.data.votes).toBe(1);
    expect(res.body.data.locked).toBe(false);
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.id).not.toBe('chosen');
  });
});
