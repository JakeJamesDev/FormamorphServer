import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * What a suspension actually costs an account.
 *
 * Login used to refuse a suspended user outright, which denied them nothing but the sight of their own
 * account — every browse route is public, so they could read and download the whole catalog by signing
 * out. What it did cost them was the message explaining the suspension. Suspension is enforced per
 * request by `protect` (no writes), so signing in is read-only either way.
 *
 * These tests run few logins on purpose: `authLimiter` allows 20 attempts per window per worker.
 */

const suspended = (over = {}) => createUser({ username: 'benched', status: 'suspended', ...over });

const login = (user) =>
  request(app).post('/api/auth/login').send({ username: user.username, password: user.password });

describe('login', () => {
  it('admits a suspended account', async () => {
    const res = await login(suspended());

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('reports the account as suspended so the client can say so', async () => {
    // Without this the session is indistinguishable from a healthy one and the banner never shows.
    const res = await login(suspended());

    expect(res.body.user.status).toBe('suspended');
  });

  it('still refuses a wrong password', async () => {
    const user = suspended();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('admits a normal account unchanged', async () => {
    const res = await login(createUser({ username: 'healthy' }));

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('normal');
  });
});

describe('what a suspended session may read', () => {
  it('sees its own profile', async () => {
    const res = await request(app).get('/api/auth/me').set(authHeader(suspended()));

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');
  });

  it('sees its own published worlds', async () => {
    const res = await request(app).get('/api/users/me/worlds').set(authHeader(suspended()));

    expect(res.status).toBe(200);
  });

  it('sees its inbox', async () => {
    // The whole point: the notice explaining the suspension has to be reachable.
    const res = await request(app).get('/api/messages').set(authHeader(suspended()));

    expect(res.status).toBe(200);
  });
});

describe('what a suspended session may not do', () => {
  // Every write the community can see. Blocked by `protect`, unchanged by the login rule.
  const writes = [
    ['post', '/api/worlds', worldPayload(), 'publish a world'],
    ['put', '/api/worlds/some-id', worldPayload(), 'update a world'],
    ['delete', '/api/worlds/some-id', undefined, 'delete a world'],
    ['post', '/api/worlds/some-id/comments', { content: 'hi' }, 'post a comment'],
    ['put', '/api/comments/some-id', { content: 'edited' }, 'edit a comment'],
    ['delete', '/api/comments/some-id', undefined, 'delete a comment'],
    ['post', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'password456' }, 'change its password'],
  ];

  for (const [method, path, body, label] of writes) {
    it(`cannot ${label}`, async () => {
      const req = request(app)[method](path).set(authHeader(suspended()));
      const res = await (body ? req.send(body) : req);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/suspended/i);
    });
  }

  it('cannot reach an admin route even so', async () => {
    const res = await request(app).get('/api/users').set(authHeader(suspended()));

    expect(res.status).toBe(403);
  });
});

describe('a suspended session may still clear its own messages', () => {
  const seedNotice = async () => {
    const admin = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = suspended();

    const sent = await request(app)
      .post('/api/messages')
      .set(authHeader(admin))
      .send({ subject: 'You are suspended', body: 'Reason.', severity: 'urgent', recipientIds: [user.id] });

    return { user, messageId: sent.body.data[0].id };
  };

  it('marks the notice read', async () => {
    const { user, messageId } = await seedNotice();

    const res = await request(app).post(`/api/messages/${messageId}/read`).set(authHeader(user));

    expect(res.status).toBe(200);
  });

  it('dismisses the notice', async () => {
    const { user, messageId } = await seedNotice();

    const res = await request(app).delete(`/api/messages/${messageId}`).set(authHeader(user));

    expect(res.status).toBe(200);
  });
});
