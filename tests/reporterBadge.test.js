import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * The badge beside the name on a report.
 *
 * Snapshotted at filing, like a reply's and unlike a listing's: a thread is a record of who said
 * something at a moment, so a later promotion or demotion must not restyle what they already sent. Before
 * this the DTO carried no role at all, which left a thread showing badged replies underneath an unbadged
 * opening post by the same team.
 */

const file = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user)).send({
    type: 'suggestion', title: 'A quieter narration mode', category: 'writing', body: 'Two sentences, not two paragraphs.', ...over,
  });

const read = (id, viewer) => request(app).get(`/api/feedback/${id}`).set(authHeader(viewer));

const list = (viewer, query = '?type=suggestion&scope=all') =>
  request(app).get(`/api/feedback${query}`).set(authHeader(viewer));

const setRole = (admin, id, accountType) =>
  request(app).put(`/api/users/${id}/status`).set(authHeader(admin)).send({ accountType });

const admin = () => createUser({ username: `root-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });
const someone = (accountType = 'normal') =>
  createUser({ username: `u-${Math.random().toString(36).slice(2, 8)}`, accountType });

describe('a report’s reporter', () => {
  it('wears their badge in the list', async () => {
    const staff = someone('mod');
    await file(staff);

    const res = await list(staff);

    expect(res.body.data[0].reporter.role).toBe('mod');
  });

  it('wears it on the thread itself, not only in the list', async () => {
    // Two different reads; the thread is where somebody actually looks at the opening post.
    const staff = someone('admin');
    const { body } = await file(staff);

    const res = await read(body.data.id, staff);

    expect(res.body.data.reporter.role).toBe('admin');
  });

  it('wears none when an ordinary account filed it', async () => {
    // Null rather than 'normal': a reader checking for a badge should not have to know the word for none.
    const plain = someone();
    const { body } = await file(plain);

    expect((await read(body.data.id, plain)).body.data.reporter.role).toBeNull();
  });

  it('says so the moment it is filed', async () => {
    const staff = someone('dev');

    expect((await file(staff)).body.data.reporter.role).toBe('dev');
  });
});

describe('what happens when the account changes afterwards', () => {
  it('keeps the badge the report was filed with when they are demoted', async () => {
    // The whole point of the snapshot: they were a mod when they wrote it, and the thread still says so.
    const root = admin();
    const staff = someone('mod');
    const { body } = await file(staff);

    await setRole(root, staff.id, 'normal');

    expect((await read(body.data.id, root)).body.data.reporter.role).toBe('mod');
  });

  it('does not badge an old report when they are promoted later', async () => {
    // The other half: promoting somebody must not turn their old reports into official team statements.
    const root = admin();
    const plain = someone();
    const { body } = await file(plain);

    await setRole(root, plain.id, 'mod');

    expect((await read(body.data.id, root)).body.data.reporter.role).toBeNull();
  });

  it('badges what they file after the promotion', async () => {
    const root = admin();
    const plain = someone();
    await setRole(root, plain.id, 'mod');
    // The role change cuts their sessions loose, so they sign in again as the app would.
    const after = await request(app).post('/api/auth/login')
      .send({ username: plain.username, password: plain.password });
    const { body } = await request(app).post('/api/feedback')
      .set('Authorization', `Bearer ${after.body.token}`)
      .send({ type: 'suggestion', title: 'Filed as a mod', category: 'writing', body: 'After the promotion.' });

    expect(body.data.reporter.role).toBe('mod');
  });
});

describe('a report filed before the column existed', () => {
  it('falls back to the live account type rather than losing its badge', async () => {
    // Nothing knows what anybody was on an unmigrated row, so the old live join is the best available
    // answer — which is exactly what every row did before the snapshot.
    const staff = someone('mod');
    const { body } = await file(staff);
    db.prepare('UPDATE feedback SET reporter_role = NULL WHERE id = ?').run(body.data.id);

    expect((await read(body.data.id, staff)).body.data.reporter.role).toBe('mod');
  });
});
