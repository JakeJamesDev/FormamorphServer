import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Feedback = require('../src/models/Feedback');

/**
 * Guest reads: the website shows the Votable boards to signed-out visitors. A bug never leaves the
 * accounts, and a guest read leaves nothing behind.
 */

const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });
const player = (username = 'poster') => createUser({ username });

const REPORT = { type: 'bug', title: 'Save button does nothing', category: 'crash', body: 'Pressing save just spins.' };
const SUGGESTION = { type: 'suggestion', title: 'Let me rename a save', category: 'interface', body: 'Renaming means re-saving.' };
const QUESTION = { type: 'question', title: 'How do I load a local model?', category: 'setup', body: 'The list stays empty.' };

const file = async (user, payload) =>
  (await request(app).post('/api/feedback').set(authHeader(user)).send(payload)).body.data;
const reply = (user, id, body = 'Which version?') =>
  request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body });

const guestGet = (path) => request(app).get(`/api/feedback${path}`);

afterEach(() => { vi.restoreAllMocks(); });

describe('a guest reading the meta', () => {
  it('gets the same body as a signed-in reader', async () => {
    const signedIn = await request(app).get('/api/feedback/meta').set(authHeader(player()));

    const res = await guestGet('/meta');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(signedIn.body);
  });
});

describe('a guest listing threads', () => {
  for (const payload of [SUGGESTION, QUESTION]) {
    it(`lists the ${payload.type} board with scope=all`, async () => {
      const poster = player();
      const thread = await file(poster, payload);
      await reply(poster, thread.id);

      const res = await guestGet(`?type=${payload.type}&scope=all`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ id: thread.id, title: payload.title, voted: false, unread: false });
    });
  }

  it('runs no vote or unread lookup', async () => {
    await file(player(), SUGGESTION);
    const votedAmong = vi.spyOn(Feedback, 'votedAmong');
    const unreadAmong = vi.spyOn(Feedback, 'unreadAmong');

    expect((await guestGet('?type=suggestion&scope=all')).status).toBe(200);

    expect(votedAmong).not.toHaveBeenCalled();
    expect(unreadAmong).not.toHaveBeenCalled();
  });

  it('refuses the bug queue', async () => {
    await file(player(), REPORT);

    const res = await guestGet('?type=bug&scope=all');

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a list with no type, which means the bug queue', async () => {
    await file(player(), REPORT);

    expect((await guestGet('?scope=all')).status).toBe(401);
  });

  it('refuses a board list without scope=all', async () => {
    await file(player(), SUGGESTION);

    expect((await guestGet('?type=suggestion')).status).toBe(401);
  });
});

describe('a guest reading one thread', () => {
  for (const payload of [SUGGESTION, QUESTION]) {
    it(`reads a ${payload.type} with its comments`, async () => {
      const poster = player();
      const thread = await file(poster, payload);
      await reply(poster, thread.id, 'More detail here.');

      const res = await guestGet(`/${thread.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: thread.id, voted: false, unread: false });
      expect(res.body.comments.map((c) => c.body)).toEqual(['More detail here.']);
    });
  }

  it('gets a bug answered as not found, like a missing thread', async () => {
    const bug = await file(player(), REPORT);
    const missing = await guestGet('/no-such-thread');

    const res = await guestGet(`/${bug.id}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(missing.body);
  });

  it('writes no seen-marker and runs no vote lookup', async () => {
    const thread = await file(player(), SUGGESTION);
    const before = db.prepare('SELECT COUNT(*) AS n FROM feedback_reads').get().n;
    const hasVoted = vi.spyOn(Feedback, 'hasVoted');
    const markSeen = vi.spyOn(Feedback, 'markSeen');

    expect((await guestGet(`/${thread.id}`)).status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_reads').get().n).toBe(before);
    expect(hasVoted).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
  });
});

describe('what a guest still cannot do', () => {
  const writes = (id, commentId) => [
    ['get', '/api/feedback/unread-count', undefined],
    ['post', '/api/feedback', SUGGESTION],
    ['post', `/api/feedback/${id}/comments`, { body: 'Hi' }],
    ['put', `/api/feedback/${id}/comments/${commentId}`, { body: 'Edited' }],
    ['delete', `/api/feedback/${id}/comments/${commentId}`, undefined],
    ['put', `/api/feedback/${id}/vote`, { voted: true }],
    ['put', `/api/feedback/${id}/answer`, { commentId }],
    ['put', `/api/feedback/${id}`, { title: 'Rewritten' }],
    ['put', `/api/feedback/${id}/status`, { status: 'planned' }],
    ['put', `/api/feedback/${id}/lock`, { locked: true }],
    ['delete', `/api/feedback/${id}`, undefined]
  ];

  it('gets 401 on unread-count and every write', async () => {
    const poster = player();
    const thread = await file(poster, QUESTION);
    const commentId = (await reply(poster, thread.id)).body.data.id;

    for (const [method, path, body] of writes(thread.id, commentId)) {
      const call = request(app)[method](path);
      const res = await (body ? call.send(body) : call);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('a caller who sends a token', () => {
  it('is refused on a bad token rather than served as a guest', async () => {
    await file(player(), SUGGESTION);

    const res = await guestGet('?type=suggestion&scope=all').set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(401);
  });

  it('meets the Privacy Policy gate rather than being served as a guest', async () => {
    const thread = await file(player(), SUGGESTION);
    await request(app).put('/api/policies/privacy_policy').set(authHeader(admin())).send({
      enabled: true, title: 'Privacy Policy', body: 'What we store about you.'
    });
    const reader = createUser({ username: 'reader' });

    for (const path of ['/meta', '?type=suggestion&scope=all', `/${thread.id}`]) {
      const res = await guestGet(path).set(authHeader(reader));
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('PRIVACY_REQUIRED');
    }
  });
});
