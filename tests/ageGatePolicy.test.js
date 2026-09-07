import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, db, migrate } from './context.js';
import { authHeader, createUser } from './helpers.js';

const read = (user) => request(app).get('/api/policies/age-gate').set(authHeader(user));

const accept = (user, acceptanceVersion = 1) => request(app)
  .post('/api/policies/age-gate/accept')
  .set(authHeader(user))
  .send({ acceptanceVersion });

describe('account age-gate acceptance', () => {
  it('persists an acceptance for a fresh authenticated read', async () => {
    migrate(db);
    const user = createUser({ username: 'reader' });

    const before = await read(user);
    const written = await accept(user);
    const after = await read(user);

    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      success: true,
      accepted: false,
      requiredVersion: 1,
      acceptedAt: null,
    });
    expect(written.status).toBe(200);
    expect(after.body).toMatchObject({
      success: true,
      accepted: true,
      requiredVersion: 1,
    });
    expect(Date.parse(after.body.acceptedAt)).not.toBeNaN();
  });

  it('rejects a version the client did not display', async () => {
    migrate(db);
    db.prepare("UPDATE policies SET acceptance_version = 2 WHERE id = 'age_gate'").run();
    const user = createUser({ username: 'outdated-reader' });

    const written = await accept(user, 1);
    const after = await read(user);

    expect(written.status).toBe(409);
    expect(written.body).toEqual({
      success: false,
      code: 'AGE_GATE_VERSION_REQUIRED',
      error: 'Update Formamorph to review the current adult-content warning.',
      requiredVersion: 2,
    });
    expect(after.body).toEqual({
      success: true,
      accepted: false,
      requiredVersion: 2,
      acceptedAt: null,
    });
  });

  it('returns the first server time when a committed request is retried', async () => {
    migrate(db);
    const user = createUser({ username: 'retrying-reader' });
    vi.useFakeTimers();

    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    const first = await accept(user);
    vi.setSystemTime(new Date('2026-09-06T12:05:00.000Z'));
    const retried = await accept(user);
    vi.useRealTimers();

    expect(first.body.acceptedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(retried.body.acceptedAt).toBe(first.body.acceptedAt);
  });

  it('derives the account from authentication and keeps answers isolated', async () => {
    migrate(db);
    const accepted = createUser({ username: 'accepted-reader' });
    const other = createUser({ username: 'other-reader' });

    expect((await request(app).post('/api/policies/age-gate/accept').send({ acceptanceVersion: 1 })).status)
      .toBe(401);

    const written = await request(app)
      .post('/api/policies/age-gate/accept')
      .set(authHeader(accepted))
      .send({ acceptanceVersion: 1, userId: other.id });

    expect(written.status).toBe(200);
    expect((await read(accepted)).body.accepted).toBe(true);
    expect((await read(other)).body.accepted).toBe(false);
  });

  it('can be read and accepted before the Privacy Policy is answered', async () => {
    migrate(db);
    db.prepare("UPDATE policies SET enabled = 1 WHERE id = 'privacy_policy'").run();
    const user = createUser({ username: 'policy-reader' });

    expect((await read(user)).status).toBe(200);
    expect((await accept(user)).status).toBe(200);
  });
});
