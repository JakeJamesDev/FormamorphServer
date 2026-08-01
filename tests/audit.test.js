import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, createTables, createIndexes } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * `/api/audit` — the append-only record of what was done to accounts and to published work.
 *
 * Two things it has to get right: an entry still reads after the thing it describes is gone (names are
 * snapshots, not joins), and writing one can never turn a completed action into a failure.
 */

const admin = (username = 'root-admin') => createUser({ username, accountType: 'admin' });

const log = (user, query = '') => request(app).get(`/api/audit${query}`).set(authHeader(user));

const entries = async (user, query = '') => (await log(user, query)).body.data;

const setStatus = (actor, target, status) =>
  request(app).put(`/api/users/${target.id}/status`).set(authHeader(actor)).send({ status });

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const comment = (user, worldId, content) =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content });

describe('who may read the log', () => {
  it('is open to an admin', async () => {
    expect((await log(admin())).status).toBe(200);
  });

  it('is refused to an ordinary account', async () => {
    // It names who did what to whom; that is the team's record, not the room's.
    expect((await log(createUser({ username: 'nosy' }))).status).toBe(403);
  });

  it('is refused to a signed-out visitor', async () => {
    expect((await request(app).get('/api/audit')).status).toBe(401);
  });
});

describe('suspensions', () => {
  it('records who suspended whom', async () => {
    const root = admin();
    const user = createUser({ username: 'trouble' });

    await setStatus(root, user, 'suspended');

    const [entry] = await entries(root);
    expect(entry).toMatchObject({
      action: 'user_suspended',
      actor: { username: 'root-admin', wasAdmin: true },
      targetUser: { username: 'trouble' }
    });
  });

  it('records the reinstatement separately', async () => {
    const root = admin();
    const user = createUser({ username: 'trouble', status: 'suspended' });

    await setStatus(root, user, 'normal');

    expect((await entries(root))[0].action).toBe('user_unsuspended');
  });

  it('says nothing when the status did not actually change', async () => {
    // Re-saving the same status is not an event, and a log full of them is a log nobody reads.
    const root = admin();
    const user = createUser({ username: 'quiet' });

    await setStatus(root, user, 'normal');

    expect(await entries(root)).toHaveLength(0);
  });

  it('says nothing when an already-suspended account is suspended again', async () => {
    // The case the "did it change" check is actually for: without it this writes a second entry saying
    // something happened that did not.
    const root = admin();
    const user = createUser({ username: 'trouble', status: 'suspended' });

    await setStatus(root, user, 'suspended');

    expect(await entries(root)).toHaveLength(0);
  });

  it('leaves the entry standing after the account is deleted', async () => {
    // The whole point of snapshotting the name: "who was that" must survive the row going away.
    const root = admin();
    const user = createUser({ username: 'trouble' });
    await setStatus(root, user, 'suspended');

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    const [entry] = await entries(root);
    expect(entry.targetUser.username).toBe('trouble');
  });
});

describe('terms resets', () => {
  const writeGate = (root) =>
    request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: true, title: 'Terms', body: 'Be excellent.' });

  it('records a reset aimed at one person', async () => {
    const root = admin();
    const user = createUser({ username: 'contributor' });
    await writeGate(root);

    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({ userId: user.id });

    expect((await entries(root))[0]).toMatchObject({
      action: 'terms_reset_user',
      targetUser: { username: 'contributor' }
    });
  });

  it('records a reset of everyone as one entry, not one each', async () => {
    // It was one action, however many accounts it reached.
    const root = admin();
    createUser({ username: 'a' });
    createUser({ username: 'b' });
    await writeGate(root);

    await request(app).post('/api/policies/upload-gate/reset').set(authHeader(root)).send({});

    const all = await entries(root);
    expect(all.filter((e) => e.action === 'terms_reset_all')).toHaveLength(1);
    expect(all[0].targetUser).toBeNull();
  });
});

describe('takedowns', () => {
  it('records an admin removing somebody else’s listing, and whose it was', async () => {
    const root = admin();
    const author = createUser({ username: 'author' });
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(root));

    expect((await entries(root))[0]).toMatchObject({
      action: 'listing_deleted',
      actor: { username: 'root-admin' },
      targetUser: { username: 'author' },
      target: { kind: 'world', name: 'Sedge Landing' }
    });
  });

  it('records an author removing their own, with nobody on the other end', async () => {
    // Same disappearance to anyone asking where it went; the entry says which it was.
    const root = admin();
    const author = createUser({ username: 'author' });
    const id = (await publish(author, { name: 'Sedge Landing' })).body.data.id;

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author));

    const [entry] = await entries(root);
    expect(entry).toMatchObject({ action: 'listing_deleted', actor: { username: 'author', wasAdmin: false } });
    expect(entry.targetUser).toBeNull();
  });

  it('keeps the kind, so a character is not filed as a world', async () => {
    const root = admin();
    const author = createUser({ username: 'author' });
    const id = (await publish(author, { name: 'Ilsa', kind: 'entity' })).body.data.id;

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(root));

    expect((await entries(root))[0].target).toMatchObject({ kind: 'entity', name: 'Ilsa' });
  });
});

describe('deleted feedback', () => {
  const fileBug = (user) =>
    request(app).post('/api/feedback').set(authHeader(user))
      .send({ type: 'bug', title: 'Save button spins', category: 'crash', body: 'Pressing save just spins.' });

  const fileSuggestion = (user) =>
    request(app).post('/api/feedback').set(authHeader(user))
      .send({ type: 'suggestion', title: 'Let me rename a save', category: 'interface', body: 'Renaming means re-saving.' });

  it('records a deleted bug report, and whose it was', async () => {
    // Deleting a thread takes the whole conversation with it — the disappearance the log explains.
    const root = admin();
    const reporter = createUser({ username: 'finder' });
    const id = (await fileBug(reporter)).body.data.id;

    await request(app).delete(`/api/feedback/${id}`).set(authHeader(root));

    expect((await entries(root))[0]).toMatchObject({
      action: 'feedback_deleted',
      actor: { username: 'root-admin' },
      targetUser: { username: 'finder' },
      target: { kind: 'bug', name: 'Save button spins' },
      snippet: 'Pressing save just spins.'
    });
  });

  it('keeps the branch, so a suggestion is not filed as a bug', async () => {
    const root = admin();
    const reporter = createUser({ username: 'finder' });
    const id = (await fileSuggestion(reporter)).body.data.id;

    await request(app).delete(`/api/feedback/${id}`).set(authHeader(root));

    expect((await entries(root))[0].target).toMatchObject({ kind: 'suggestion', name: 'Let me rename a save' });
  });

  it('names nobody when an admin deletes their own', async () => {
    const root = admin();
    const id = (await fileBug(root)).body.data.id;

    await request(app).delete(`/api/feedback/${id}`).set(authHeader(root));

    expect((await entries(root))[0].targetUser).toBeNull();
  });

  it('still records it when the reporter’s account is already gone', async () => {
    // `reporter_id` is SET NULL, so the thread outlives its author — and so must the entry.
    const root = admin();
    const reporter = createUser({ username: 'finder' });
    const id = (await fileBug(reporter)).body.data.id;
    db.prepare('DELETE FROM users WHERE id = ?').run(reporter.id);

    await request(app).delete(`/api/feedback/${id}`).set(authHeader(root));

    const [entry] = await entries(root);
    expect(entry.action).toBe('feedback_deleted');
    expect(entry.targetUser).toBeNull();
  });
});

describe('deleted comments', () => {
  const seedComment = async (author, text) => {
    const owner = createUser({ username: 'owner' });
    const worldId = (await publish(owner, { name: 'Sedge Landing' })).body.data.id;
    const id = (await comment(author, worldId, text)).body.data.id;
    return { worldId, id };
  };

  it('keeps what was said, since the row itself is gone', async () => {
    const root = admin();
    const author = createUser({ username: 'commenter' });
    const { id } = await seedComment(author, 'Something worth keeping a record of.');

    await request(app).delete(`/api/comments/${id}`).set(authHeader(root));

    expect((await entries(root))[0]).toMatchObject({
      action: 'comment_deleted',
      actor: { username: 'root-admin' },
      targetUser: { username: 'commenter' },
      target: { kind: 'comment', name: 'Sedge Landing' },
      snippet: 'Something worth keeping a record of.'
    });
  });

  it('records somebody deleting their own', async () => {
    const root = admin();
    const author = createUser({ username: 'commenter' });
    const { id } = await seedComment(author, 'Never mind.');

    await request(app).delete(`/api/comments/${id}`).set(authHeader(author));

    const [entry] = await entries(root);
    expect(entry.action).toBe('comment_deleted');
    expect(entry.targetUser).toBeNull();
  });

  it('truncates a long comment rather than archiving it', async () => {
    // Enough to know what was removed, never the whole of it.
    const root = admin();
    const author = createUser({ username: 'commenter' });
    const { id } = await seedComment(author, 'x'.repeat(500));

    await request(app).delete(`/api/comments/${id}`).set(authHeader(root));

    expect((await entries(root))[0].snippet).toHaveLength(200);
  });
});

describe('reading the log', () => {
  const seed = (count, action = 'user_suspended') => {
    for (let i = 0; i < count; i += 1) {
      db.prepare(`
        INSERT INTO audit_log (action, actor_username, target_username, created_at)
        VALUES (?, ?, ?, ?)
      `).run(action, 'root-admin', `target-${i}`, new Date().toISOString());
    }
  };

  it('lists newest first', async () => {
    const root = admin();
    seed(3);

    expect((await entries(root)).map((e) => e.targetUser.username)).toEqual(['target-2', 'target-1', 'target-0']);
  });

  it('pages without repeating a row when timestamps tie', async () => {
    // Ordered by the autoincrementing id, not the clock — these are all written in the same millisecond.
    const root = admin();
    seed(25);

    const page = async (n) => (await entries(root, `?limit=10&page=${n}`)).map((e) => e.id);
    const seen = [...(await page(1)), ...(await page(2)), ...(await page(3))];

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('narrows to one kind of event', async () => {
    const root = admin();
    seed(2, 'user_suspended');
    seed(3, 'listing_deleted');

    const res = await log(root, '?action=listing_deleted');

    expect(res.body.total).toBe(3);
    expect(res.body.data.every((e) => e.action === 'listing_deleted')).toBe(true);
  });

  it('ignores an action it does not know rather than rejecting it', async () => {
    const root = admin();
    seed(2);

    const res = await log(root, '?action=nonsense');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('searches the actor, the target account and the target’s name', async () => {
    const root = admin();
    db.prepare(`
      INSERT INTO audit_log (action, actor_username, target_username, target_name, created_at)
      VALUES ('listing_deleted', 'root-admin', 'author', 'Sedge Landing', ?)
    `).run(new Date().toISOString());
    seed(1);

    expect((await log(root, '?search=author')).body.total).toBe(1);
    expect((await log(root, '?search=Sedge')).body.total).toBe(1);
    expect((await log(root, '?search=root-admin')).body.total).toBe(2);
  });

  it('treats a wildcard as the character somebody typed', async () => {
    const root = admin();
    seed(3);

    expect((await log(root, '?search=%25')).body.total).toBe(0);
  });

  it('reports the actions the filter may offer', async () => {
    const res = await request(app).get('/api/audit/meta').set(authHeader(admin()));

    expect(res.body.actions).toContain('user_suspended');
    expect(res.body.actions).toContain('listing_deleted');
  });
});

describe('the log as a record', () => {
  it('offers no way to change or remove an entry', async () => {
    // An audit trail somebody can edit is not one, so there is simply no route for it.
    const root = admin();
    const user = createUser({ username: 'trouble' });
    await setStatus(root, user, 'suspended');
    const [entry] = await entries(root);

    expect((await request(app).delete(`/api/audit/${entry.id}`).set(authHeader(root))).status).toBe(404);
    expect((await request(app).put(`/api/audit/${entry.id}`).set(authHeader(root)).send({ action: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/audit').set(authHeader(root)).send({ action: 'x' })).status).toBe(404);
    expect(await entries(root)).toHaveLength(1);
  });

  it('lets the action stand when the log itself cannot be written', async () => {
    // A gap in the trail is bad; an action that reports failure after succeeding is worse.
    const root = admin();
    const user = createUser({ username: 'trouble' });
    db.exec('DROP TABLE audit_log');

    try {
      const res = await setStatus(root, user, 'suspended');

      expect(res.status).toBe(200);
      expect(res.body.user.status).toBe('suspended');
    } finally {
      // Put back what this deliberately broke — the shared teardown clears this table by name.
      createTables();
      createIndexes();
    }
  });
});
