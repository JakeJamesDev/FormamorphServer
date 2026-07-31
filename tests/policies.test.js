import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * `/api/policies` — two authored publish-time popups.
 *
 * `upload_gate` blocks publishing until the user accepts it; `tag_notice` is advisory and only tells the
 * client what to show. Neither exists until an admin writes one, so an untouched server gates nothing.
 */

const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });

/** Author and switch on the gate, so it actually blocks. */
const enableGate = async (adminUser, over = {}) =>
  request(app).put('/api/policies/upload_gate').set(authHeader(adminUser)).send({
    enabled: true, title: 'Contributor terms', body: 'Be excellent.', ...over,
  });

const enableTagNotice = async (adminUser, tags) =>
  request(app).put('/api/policies/tag_notice').set(authHeader(adminUser)).send({
    enabled: true, title: 'Heads up', body: 'These tags need care.', tags,
  });

const publish = (user) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload());

describe('with no policy authored', () => {
  it('reports nothing to show', async () => {
    const res = await request(app).get('/api/policies').set(authHeader(createUser({ username: 'u' })));

    expect(res.body.uploadGate).toBeNull();
    expect(res.body.tagNotice).toBeNull();
  });

  it('leaves publishing exactly as it was', async () => {
    // Deploying this must change nothing until an admin turns a gate on.
    const res = await publish(createUser({ username: 'u' }));

    expect(res.status).toBe(201);
  });
});

describe('authoring', () => {
  it('rejects a non-admin', async () => {
    const res = await enableGate(createUser({ username: 'plain' }));
    expect(res.status).toBe(403);
  });

  it('404s an unknown policy', async () => {
    const res = await request(app).put('/api/policies/whatever').set(authHeader(admin()))
      .send({ enabled: false, title: 'x', body: 'y' });

    expect(res.status).toBe(404);
  });

  it('refuses to enable a popup with no text', async () => {
    // An enabled but empty gate is a wall with nothing written on it.
    const res = await request(app).put('/api/policies/upload_gate').set(authHeader(admin()))
      .send({ enabled: true, title: '', body: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title and body/i);
  });

  it('allows a half-written draft while it stays off', async () => {
    const res = await request(app).put('/api/policies/upload_gate').set(authHeader(admin()))
      .send({ enabled: false, title: 'Work in progress', body: '' });

    expect(res.status).toBe(200);
  });

  it('rejects an oversize title or body', async () => {
    const root = admin();

    const longTitle = await enableGate(root, { title: 'a'.repeat(121) });
    const longBody = await enableGate(root, { body: 'a'.repeat(4001) });

    expect(longTitle.status).toBe(400);
    expect(longBody.status).toBe(400);
  });

  it('hands the admin editor a blank draft before anything is written', async () => {
    const res = await request(app).get('/api/policies/manage').set(authHeader(admin()));

    expect(res.status).toBe(200);
    expect(res.body.uploadGate).toMatchObject({ enabled: false, title: '', body: '' });
  });

  it('shows the admin a disabled draft the public view hides', async () => {
    const root = admin();
    await request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: false, title: 'Draft', body: 'Not live yet.' });

    const manage = await request(app).get('/api/policies/manage').set(authHeader(root));
    const publicView = await request(app).get('/api/policies').set(authHeader(root));

    expect(manage.body.uploadGate.title).toBe('Draft');
    expect(publicView.body.uploadGate).toBeNull();
  });
});

describe('the gate blocks publishing', () => {
  it('refuses a publish with a code an updated client can act on', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'contributor' });

    const res = await publish(user);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_REQUIRED');
    // Older clients surface `error` verbatim, so it has to tell them what to do.
    expect(res.body.error).toMatch(/update formamorph/i);
  });

  it('lets the publish through once accepted', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'contributor' });

    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));

    expect((await publish(user)).status).toBe(201);
  });

  it('blocks an update to an existing listing too', async () => {
    // Otherwise a reset would not actually stop an established contributor.
    const root = admin();
    const user = createUser({ username: 'contributor' });
    const created = await publish(user);
    await enableGate(root);

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(user))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_REQUIRED');
  });

  it('never blocks taking your own work down', async () => {
    // Someone who declined the terms must still be able to remove what they already published.
    const root = admin();
    const user = createUser({ username: 'contributor' });
    const created = await publish(user);
    await enableGate(root);

    const res = await request(app)
      .delete(`/api/worlds/${created.body.data.id}`)
      .set(authHeader(user));

    expect(res.status).toBe(200);
  });

  it('never blocks flagging your own work as a spoiler', async () => {
    const root = admin();
    const user = createUser({ username: 'contributor' });
    const created = await publish(user);
    await enableGate(root);

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/spoiler`)
      .set(authHeader(user))
      .send({ spoiler: true });

    expect(res.status).toBe(200);
  });

  it('does not block on an enabled row with no text', async () => {
    // The editor refuses to enable an empty gate, so this is only reachable by a direct database edit —
    // but a wall with nothing written on it would be unexplainable to the user who hit it.
    admin();
    db.prepare(`
      INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
      VALUES ('upload_gate', 1, '', '', '[]', 1, '2026-01-01T00:00:00.000Z')
    `).run();

    expect((await publish(createUser({ username: 'u' }))).status).toBe(201);
  });

  it('does not block while the gate is switched off', async () => {
    const root = admin();
    await request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: false, title: 'Terms', body: 'Text.' });

    expect((await publish(createUser({ username: 'u' }))).status).toBe(201);
  });
});

describe('acceptance', () => {
  it('reports whether this user has accepted', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'contributor' });

    const before = await request(app).get('/api/policies').set(authHeader(user));
    expect(before.body.uploadGate.accepted).toBe(false);

    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));

    const after = await request(app).get('/api/policies').set(authHeader(user));
    expect(after.body.uploadGate.accepted).toBe(true);
  });

  it('is per user', async () => {
    const root = admin();
    await enableGate(root);
    const accepted = createUser({ username: 'yes' });
    const other = createUser({ username: 'no' });

    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(accepted));

    expect((await publish(accepted)).status).toBe(201);
    expect((await publish(other)).status).toBe(403);
  });

  it('404s an accept when there is nothing to accept', async () => {
    const res = await request(app).post('/api/policies/upload-gate/accept')
      .set(authHeader(createUser({ username: 'u' })));

    expect(res.status).toBe(404);
  });

  it('is idempotent', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'contributor' });
    const url = '/api/policies/upload-gate/accept';

    await request(app).post(url).set(authHeader(user));
    const second = await request(app).post(url).set(authHeader(user));

    expect(second.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c).toBe(1);
  });
});

describe('re-acceptance', () => {
  const seedAccepted = async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'contributor' });
    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));
    return { root, user };
  };

  it('survives an ordinary edit', async () => {
    // Most edits fix a typo; re-prompting the whole userbase for one would be noise.
    const { root, user } = await seedAccepted();

    await enableGate(root, { body: 'Be excellent. (typo fixed)' });

    expect((await publish(user)).status).toBe(201);
  });

  it('is required again when the admin asks for it', async () => {
    const { root, user } = await seedAccepted();

    await request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: true, title: 'Contributor terms', body: 'Materially different.', requireReaccept: true });

    const res = await publish(user);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_REQUIRED');
  });

  it('can be given again after a re-accept edit', async () => {
    const { root, user } = await seedAccepted();
    await request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: true, title: 'Contributor terms', body: 'Materially different.', requireReaccept: true });

    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));

    expect((await publish(user)).status).toBe(201);
  });
});

describe('reset', () => {
  const seedTwoAccepted = async () => {
    const root = admin();
    await enableGate(root);
    const a = createUser({ username: 'alice' });
    const b = createUser({ username: 'bob' });
    for (const u of [a, b]) {
      await request(app).post('/api/policies/upload-gate/accept').set(authHeader(u));
    }
    return { root, a, b };
  };

  it('rejects a non-admin', async () => {
    const { a } = await seedTwoAccepted();
    const res = await request(app).post('/api/policies/upload-gate/reset').set(authHeader(a)).send({});

    expect(res.status).toBe(403);
  });

  it('blocks one named user without touching anyone else', async () => {
    const { root, a, b } = await seedTwoAccepted();

    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({ userId: a.id });

    expect((await publish(a)).status).toBe(403);
    expect((await publish(b)).status).toBe(201);
  });

  it('blocks everyone at once', async () => {
    const { root, a, b } = await seedTwoAccepted();

    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({});

    expect((await publish(a)).status).toBe(403);
    expect((await publish(b)).status).toBe(403);
  });

  it('invalidates everyone without deleting a single acceptance row', async () => {
    // A version bump is one write however many accounts exist, and avoids comparing dates written in
    // two different formats.
    const { root } = await seedTwoAccepted();
    const before = db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c;

    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({});

    expect(db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c).toBe(before);
  });

  it('lets a reset user accept again', async () => {
    const { root, a } = await seedTwoAccepted();
    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({ userId: a.id });

    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(a));

    expect((await publish(a)).status).toBe(201);
  });

  it('404s an unknown user', async () => {
    const { root } = await seedTwoAccepted();
    const res = await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root))
      .send({ userId: 'no-such-user' });

    expect(res.status).toBe(404);
  });

  it('404s when there is no gate to reset', async () => {
    const res = await request(app).post('/api/policies/upload-gate/reset').set(authHeader(admin())).send({});
    expect(res.status).toBe(404);
  });
});

describe('tag notice', () => {
  it('matches a listed tag regardless of case or padding', async () => {
    // Both the stored list and the incoming tags are normalized, or a stray space silently never matches.
    const root = admin();
    await enableTagNotice(root, ['  Mature  ', 'Gore']);
    const user = createUser({ username: 'u' });

    const res = await request(app).post('/api/policies/tag-notice/match').set(authHeader(user))
      .send({ tags: ['MATURE', 'fantasy'] });

    expect(res.body.matched).toEqual(['mature']);
  });

  it('matches whole tags only', async () => {
    const root = admin();
    await enableTagNotice(root, ['mature']);
    const user = createUser({ username: 'u' });

    const res = await request(app).post('/api/policies/tag-notice/match').set(authHeader(user))
      .send({ tags: ['immature', 'mature themes'] });

    expect(res.body.matched).toEqual([]);
  });

  it('matches nothing while the notice is off', async () => {
    const root = admin();
    await request(app).put('/api/policies/tag_notice').set(authHeader(root))
      .send({ enabled: false, title: 'Heads up', body: 'Text.', tags: ['mature'] });

    const res = await request(app).post('/api/policies/tag-notice/match')
      .set(authHeader(createUser({ username: 'u' }))).send({ tags: ['mature'] });

    expect(res.body.matched).toEqual([]);
  });

  it('never blocks a publish', async () => {
    // The notice is advisory; only the gate stops anything.
    const root = admin();
    await enableTagNotice(root, ['mature']);

    const res = await request(app).post('/api/worlds')
      .set(authHeader(createUser({ username: 'u' })))
      .send({ ...worldPayload(), tags: ['mature'] });

    expect(res.status).toBe(201);
  });

  it('reports duplicates once', async () => {
    const root = admin();
    await enableTagNotice(root, ['mature']);

    const res = await request(app).post('/api/policies/tag-notice/match')
      .set(authHeader(createUser({ username: 'u' }))).send({ tags: ['Mature', 'mature', ' MATURE '] });

    expect(res.body.matched).toEqual(['mature']);
  });

  it('survives a missing or malformed tag list', async () => {
    const root = admin();
    await enableTagNotice(root, ['mature']);
    const user = createUser({ username: 'u' });

    const missing = await request(app).post('/api/policies/tag-notice/match').set(authHeader(user)).send({});
    const wrongType = await request(app).post('/api/policies/tag-notice/match').set(authHeader(user))
      .send({ tags: 'mature' });

    expect(missing.body.matched).toEqual([]);
    expect(wrongType.body.matched).toEqual([]);
  });
});

describe('access', () => {
  it('requires authentication to read policies', async () => {
    expect((await request(app).get('/api/policies')).status).toBe(401);
  });

  it('requires admin to read the editor view', async () => {
    const res = await request(app).get('/api/policies/manage')
      .set(authHeader(createUser({ username: 'plain' })));

    expect(res.status).toBe(403);
  });
});

describe('the admin user list', () => {
  const listUsers = (adminUser) =>
    request(app).get('/api/users?limit=100').set(authHeader(adminUser));

  const responseOf = (res, username) =>
    res.body.data.find((user) => user.username === username).termsResponse;

  const decline = (user) =>
    request(app).post('/api/policies/upload-gate/decline').set(authHeader(user));

  it('reports each of the three answers', async () => {
    const root = admin();
    await enableGate(root);
    const yes = createUser({ username: 'said-yes' });
    const no = createUser({ username: 'said-no' });
    createUser({ username: 'never-asked' });
    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(yes));
    await decline(no);

    const res = await listUsers(root);

    expect(responseOf(res, 'said-yes')).toBe('accepted');
    expect(responseOf(res, 'said-no')).toBe('declined');
    expect(responseOf(res, 'never-asked')).toBe('unanswered');
  });

  it('puts a stale answer back to unanswered', async () => {
    // A version bump invalidates every answer without touching a row; the column must follow it,
    // otherwise the admin sees a green tick for someone the gate is about to stop.
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'stale' });
    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));
    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({});

    expect(responseOf(await listUsers(root), 'stale')).toBe('unanswered');
  });

  it('reports everyone as unanswered when no gate exists', async () => {
    const root = admin();
    createUser({ username: 'nobody' });

    expect(responseOf(await listUsers(root), 'nobody')).toBe('unanswered');
  });
});

describe('declining', () => {
  const decline = (user) =>
    request(app).post('/api/policies/upload-gate/decline').set(authHeader(user));

  it('leaves publishing blocked, exactly as not answering does', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'refuser' });

    await decline(user);

    const res = await publish(user);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_REQUIRED');
  });

  it('can be changed to an acceptance', async () => {
    // Declining is a decision, not a punishment: the gate has to still be acceptable afterwards.
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'changed-mind' });

    await decline(user);
    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));

    expect((await publish(user)).status).toBe(201);
  });

  it('keeps one row however many times it is answered', async () => {
    const root = admin();
    await enableGate(root);
    const user = createUser({ username: 'indecisive' });

    await decline(user);
    await request(app).post('/api/policies/upload-gate/accept').set(authHeader(user));
    await decline(user);

    expect(db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c).toBe(1);
  });

  it('404s when there is nothing to decline', async () => {
    const res = await decline(createUser({ username: 'early' }));
    expect(res.status).toBe(404);
  });

  it('rejects a signed-out visitor', async () => {
    await enableGate(admin());
    const res = await request(app).post('/api/policies/upload-gate/decline');
    expect(res.status).toBe(401);
  });
});
