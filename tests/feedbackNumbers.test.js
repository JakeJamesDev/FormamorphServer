import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/** `number` — the short name a thread has, from one sequence shared by every type. */

const file = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'suggestion', title: 'An idea', category: 'gameplay', body: 'Body.', ...over });

const BUG = { type: 'bug', category: 'crash', title: 'It crashed' };
const QUESTION = { type: 'question', category: 'setup', title: 'How?' };

describe('a thread number', () => {
  it('comes from one sequence across bugs, suggestions and questions', async () => {
    const user = createUser({ username: 'filer' });

    const bug = await file(user, BUG);
    const suggestion = await file(user);
    const question = await file(user, QUESTION);

    expect([bug, suggestion, question].map((res) => res.body.data.number)).toEqual([1, 2, 3]);
  });

  it('continues after the highest number already stored', async () => {
    const user = createUser({ username: 'filer' });
    db.prepare(`
      INSERT INTO feedback (id, type, reporter_id, title, category, body, number, created_at, updated_at)
      VALUES ('old', 'suggestion', ?, 'Old', 'gameplay', 'b', 41, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(user.id);

    const res = await file(user);

    expect(res.body.data.number).toBe(42);
  });

  it('is never handed out again after its thread is deleted', async () => {
    const root = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'filer' });
    await file(user);
    const { body: { data: newest } } = await file(user);

    await request(app).delete(`/api/feedback/${newest.id}`).set(authHeader(root));
    const next = await file(user);

    expect(next.body.data.number).toBe(3);
    expect((await request(app).get('/api/feedback/2').set(authHeader(user))).status).toBe(404);
  });

  it('is on every row of a list', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);
    await file(user);

    const res = await request(app).get('/api/feedback?type=suggestion&scope=all').set(authHeader(user));

    expect(res.body.data.map((row) => row.number).sort()).toEqual([1, 2]);
  });

  it('is on the thread read, by UUID and by number alike', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);
    const { body: { data: second } } = await file(user);

    const byId = await request(app).get(`/api/feedback/${second.id}`).set(authHeader(user));
    const byNumber = await request(app).get('/api/feedback/2').set(authHeader(user));

    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.number).toBe(2);
    expect(byNumber.body).toEqual(byId.body);
  });

  it('opens a suggestion to a guest by number, as by UUID', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);

    const res = await request(app).get('/api/feedback/1');

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('An idea');
  });

  it('keeps a bug unreadable to a guest by number, like a missing thread', async () => {
    const user = createUser({ username: 'filer' });
    await file(user, BUG);

    const bug = await request(app).get('/api/feedback/1');
    const missing = await request(app).get('/api/feedback/99');

    expect(bug.status).toBe(404);
    expect(bug.body).toEqual(missing.body);
  });

  it('does not read a number padded with zeros as the thread', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);

    const res = await request(app).get('/api/feedback/001').set(authHeader(user));

    expect(res.status).toBe(404);
  });

  it('answers a number nobody holds with not found', async () => {
    const user = createUser({ username: 'filer' });

    const res = await request(app).get('/api/feedback/7').set(authHeader(user));

    expect(res.status).toBe(404);
  });

  it('marks the thread seen when read by number, as by UUID', async () => {
    const asker = createUser({ username: 'asker' });
    const helper = createUser({ username: 'helper' });
    const { body: { data: thread } } = await file(asker, QUESTION);
    await request(app).post(`/api/feedback/${thread.id}/comments`).set(authHeader(helper)).send({ body: 'Try this.' });
    const before = await request(app).get('/api/feedback/unread-count').set(authHeader(asker));
    expect(before.body.unread).toBe(1);

    await request(app).get(`/api/feedback/${thread.number}`).set(authHeader(asker));

    const after = await request(app).get('/api/feedback/unread-count').set(authHeader(asker));
    expect(after.body.unread).toBe(0);
  });
});
