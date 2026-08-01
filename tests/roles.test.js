import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

/**
 * The mod team.
 *
 * `dev` and `mod` are peers with different names: same moderation reach, neither able to change what
 * anybody is. Three things have to hold — they can do the everyday work, they cannot promote or demote,
 * and they cannot turn on each other or on an administrator.
 */

let seq = 0;
const staffAs = (accountType) => (username = `${accountType}-${++seq}`) => createUser({ username, accountType });
const admin = staffAs('admin');
const mod = staffAs('mod');
const dev = staffAs('dev');

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const setStatus = (actor, id, body) =>
  request(app).put(`/api/users/${id}/status`).set(authHeader(actor)).send(body);

const roleOf = (id) => db.prepare('SELECT account_type FROM users WHERE id = ?').get(id).account_type;

const fileBug = (user, title = 'Tide puzzle unsolvable') =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'bug', title, category: 'other', body: 'Selling the lantern early locks it.' });

describe('what a moderator can do', () => {
  it('reads the user table', async () => {
    for (const staff of [mod('m1'), dev('d1')]) {
      expect((await request(app).get('/api/users').set(authHeader(staff))).status).toBe(200);
    }
  });

  it('reads the log', async () => {
    expect((await request(app).get('/api/audit').set(authHeader(mod()))).status).toBe(200);
  });

  it('suspends and reinstates an ordinary account', async () => {
    const moderator = mod();
    const user = createUser({ username: 'trouble' });

    expect((await setStatus(moderator, user.id, { status: 'suspended' })).status).toBe(200);
    expect((await setStatus(moderator, user.id, { status: 'normal' })).status).toBe(200);
  });

  it('quarantines and releases a listing', async () => {
    const moderator = dev();
    const author = createUser();
    const id = (await publish(author)).body.data.id;

    expect((await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(moderator)).send({ days: 7 })).status).toBe(200);
    expect((await request(app).delete(`/api/worlds/${id}/quarantine`).set(authHeader(moderator))).status).toBe(200);
  });

  it('deletes somebody else’s listing', async () => {
    const moderator = mod();
    const author = createUser();
    const id = (await publish(author)).body.data.id;

    expect((await request(app).delete(`/api/worlds/${id}`).set(authHeader(moderator))).status).toBe(200);
  });

  it('triages, locks and deletes a feedback thread', async () => {
    const moderator = dev();
    const reporter = createUser();
    const id = (await fileBug(reporter)).body.data.id;

    expect((await request(app).put(`/api/feedback/${id}/status`).set(authHeader(moderator)).send({ status: 'confirmed' })).status).toBe(200);
    expect((await request(app).put(`/api/feedback/${id}/lock`).set(authHeader(moderator)).send({ locked: true })).status).toBe(200);
    expect((await request(app).delete(`/api/feedback/${id}`).set(authHeader(moderator))).status).toBe(200);
  });

  it('clears somebody’s profile image', async () => {
    const moderator = mod();
    const user = createUser();
    await request(app).put('/api/users/me/avatar').set(authHeader(user)).send({ image: TINY_PNG });

    expect((await request(app).delete(`/api/users/${user.id}/avatar`).set(authHeader(moderator))).status).toBe(200);
  });

  it('resets one person’s answer to the terms', async () => {
    const moderator = dev();
    const user = createUser();
    await request(app).put('/api/policies/upload_gate').set(authHeader(admin()))
      .send({ enabled: true, title: 'Terms', body: 'Be excellent.', tags: [] });

    expect((await request(app).post('/api/policies/upload-gate/reset').set(authHeader(moderator))
      .send({ userId: user.id })).status).toBe(200);
  });

  it('writes to one person, which is how a suspension gets explained', async () => {
    const moderator = mod();
    const user = createUser();

    const res = await request(app).post('/api/messages').set(authHeader(moderator))
      .send({ recipientIds: [user.id], subject: 'About your account', body: 'Please read the rules.' });

    expect(res.status).toBe(201);
  });
});

describe('what a moderator cannot do', () => {
  it('cannot promote anybody', async () => {
    const moderator = mod();
    const user = createUser();

    const res = await setStatus(moderator, user.id, { accountType: 'mod' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/administrator/i);
    expect(roleOf(user.id)).toBe('normal');
  });

  it('cannot demote anybody either', async () => {
    const moderator = dev();
    const other = mod('other-mod');

    expect((await setStatus(moderator, other.id, { accountType: 'normal' })).status).toBe(403);
    expect(roleOf(other.id)).toBe('mod');
  });

  it('cannot slip a promotion in alongside a suspension', async () => {
    // One route carries both, and the suspension half is theirs — the role half never is.
    const moderator = mod();
    const user = createUser();

    const res = await setStatus(moderator, user.id, { status: 'suspended', accountType: 'dev' });

    expect(res.status).toBe(403);
    expect(roleOf(user.id)).toBe('normal');
    expect(db.prepare('SELECT status FROM users WHERE id = ?').get(user.id).status).toBe('normal');
  });

  it('cannot message everyone', async () => {
    const res = await request(app).post('/api/messages').set(authHeader(mod()))
      .send({ broadcast: true, subject: 'Hello all', body: 'Listen up.' });

    expect(res.status).toBe(403);
  });

  it('cannot reset the terms for everyone', async () => {
    await request(app).put('/api/policies/upload_gate').set(authHeader(admin()))
      .send({ enabled: true, title: 'Terms', body: 'Be excellent.', tags: [] });

    const res = await request(app).post('/api/policies/upload-gate/reset').set(authHeader(mod())).send({});

    expect(res.status).toBe(403);
  });

  it('cannot author a policy', async () => {
    const res = await request(app).put('/api/policies/tag_notice').set(authHeader(dev()))
      .send({ enabled: true, title: 'Tagged', body: 'Careful.', tags: ['mature'] });

    expect(res.status).toBe(403);
  });

  it('cannot read the policy drafts', async () => {
    expect((await request(app).get('/api/policies/manage').set(authHeader(mod()))).status).toBe(403);
  });
});

describe('staff moderate the room, not each other', () => {
  it('stops a mod suspending another mod', async () => {
    // One compromised moderator account could otherwise suspend the whole team before anybody noticed.
    const moderator = mod('m1');
    const other = mod('m2');

    const res = await setStatus(moderator, other.id, { status: 'suspended' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/staff account/i);
  });

  it('stops a mod suspending a dev, and a dev suspending a mod', async () => {
    expect((await setStatus(mod('m1'), dev('d1').id, { status: 'suspended' })).status).toBe(403);
    expect((await setStatus(dev('d2'), mod('m2').id, { status: 'suspended' })).status).toBe(403);
  });

  it('stops anybody suspending an administrator', async () => {
    const owner = admin('owner');

    expect((await setStatus(mod(), owner.id, { status: 'suspended' })).status).toBe(403);
    expect((await setStatus(admin('other-admin'), owner.id, { status: 'suspended' })).status).toBe(403);
  });

  it('lets an administrator suspend a mod', async () => {
    const moderator = mod();

    expect((await setStatus(admin(), moderator.id, { status: 'suspended' })).status).toBe(200);
  });

  it('stops a mod clearing another moderator’s picture', async () => {
    const moderator = mod('m1');
    const other = dev('d1');
    await request(app).put('/api/users/me/avatar').set(authHeader(other)).send({ image: TINY_PNG });

    const res = await request(app).delete(`/api/users/${other.id}/avatar`).set(authHeader(moderator));

    expect(res.status).toBe(403);
    expect(db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(other.id).avatar_file).not.toBeNull();
  });

  it('says the same thing whether or not there was a picture to clear', async () => {
    // Otherwise the two answers tell a probing moderator which staff accounts have one.
    const moderator = mod('m1');
    const withOne = dev('d1');
    const without = dev('d2');
    await request(app).put('/api/users/me/avatar').set(authHeader(withOne)).send({ image: TINY_PNG });

    const a = await request(app).delete(`/api/users/${withOne.id}/avatar`).set(authHeader(moderator));
    const b = await request(app).delete(`/api/users/${without.id}/avatar`).set(authHeader(moderator));

    expect(a.status).toBe(b.status);
    expect(a.body.error).toBe(b.body.error);
  });

  it('stops a mod quarantining another moderator’s listing', async () => {
    // Found live: the route's staff gate let this through, and a quarantine deletes the listing when its
    // deadline passes — so a moderator could destroy another moderator's work on a three-day timer.
    const moderator = mod('m1');
    const other = dev('d1');
    const id = (await publish(other)).body.data.id;

    const res = await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(moderator)).send({ days: 3 });

    expect(res.status).toBe(403);
    expect(db.prepare('SELECT quarantined_at FROM worlds WHERE id = ?').get(id).quarantined_at).toBeNull();
  });

  it('stops a mod releasing another moderator’s listing', async () => {
    // The other direction is moderation too: lifting a quarantine an administrator set is overruling them.
    const moderator = mod('m1');
    const other = dev('d1');
    const id = (await publish(other)).body.data.id;
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(admin())).send({ days: 3 });

    const res = await request(app).delete(`/api/worlds/${id}/quarantine`).set(authHeader(moderator));

    expect(res.status).toBe(403);
    expect(db.prepare('SELECT quarantined_at FROM worlds WHERE id = ?').get(id).quarantined_at).not.toBeNull();
  });

  it('still lets a mod quarantine an ordinary listing', async () => {
    // The case that isolates the two above: absent this, they would pass for the wrong reason.
    const moderator = mod('m1');
    const author = createUser();
    const id = (await publish(author)).body.data.id;

    expect((await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(moderator)).send({ days: 3 })).status).toBe(200);
  });

  it('stops a mod deleting another moderator’s listing', async () => {
    const moderator = mod('m1');
    const other = dev('d1');
    const id = (await publish(other)).body.data.id;

    expect((await request(app).delete(`/api/worlds/${id}`).set(authHeader(moderator))).status).toBe(403);
  });

  it('lets an administrator delete a mod’s listing', async () => {
    const moderator = mod();
    const id = (await publish(moderator)).body.data.id;

    expect((await request(app).delete(`/api/worlds/${id}`).set(authHeader(admin()))).status).toBe(200);
  });

  it('stops a mod deleting an administrator’s comment', async () => {
    const owner = admin('owner');
    const moderator = mod();
    const author = createUser();
    const worldId = (await publish(author)).body.data.id;
    const comment = await request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(owner))
      .send({ content: 'Looks good to me.' });

    const res = await request(app).delete(`/api/comments/${comment.body.data.id}`).set(authHeader(moderator));

    expect(res.status).toBe(403);
  });

  it('stops a mod writing to an administrator', async () => {
    const res = await request(app).post('/api/messages').set(authHeader(mod()))
      .send({ recipientIds: [admin('owner').id], subject: 'Hello', body: 'A word.' });

    expect(res.status).toBe(403);
  });

  it('leaves everybody able to act on their own things', async () => {
    // The self case is not moderation — an admin clearing their own picture is not moderating an admin.
    const owner = admin();
    await request(app).put('/api/users/me/avatar').set(authHeader(owner)).send({ image: TINY_PNG });

    expect((await request(app).delete(`/api/users/${owner.id}/avatar`).set(authHeader(owner))).status).toBe(200);
  });
});

describe('changing what somebody is', () => {
  it('is an administrator’s, and it sticks', async () => {
    const user = createUser({ username: 'osk_tinder' });

    const res = await setStatus(admin(), user.id, { accountType: 'mod' });

    expect(res.status).toBe(200);
    expect(res.body.user.accountType).toBe('mod');
    expect(roleOf(user.id)).toBe('mod');
  });

  it('goes both ways', async () => {
    const user = createUser();
    await setStatus(admin(), user.id, { accountType: 'dev' });

    await setStatus(admin(), user.id, { accountType: 'normal' });

    expect(roleOf(user.id)).toBe('normal');
  });

  it('refuses to make anybody an administrator', async () => {
    // Administrators are made by hand on the server and nowhere else, so a compromised admin account
    // cannot quietly grow the set of accounts that can do this.
    const user = createUser();

    const res = await setStatus(admin(), user.id, { accountType: 'admin' });

    expect(res.status).toBe(400);
    expect(roleOf(user.id)).toBe('normal');
  });

  it('refuses to change an existing administrator', async () => {
    const owner = admin('owner');

    const res = await setStatus(admin('other-admin'), owner.id, { accountType: 'normal' });

    expect(res.status).toBe(403);
    expect(roleOf(owner.id)).toBe('admin');
  });

  it('refuses a role nobody has heard of', async () => {
    const user = createUser();

    expect((await setStatus(admin(), user.id, { accountType: 'owner' })).status).toBe(400);
    expect(roleOf(user.id)).toBe('normal');
  });

  it('goes in the log, with both ends of the change', async () => {
    // "Made a mod" reads differently depending on what they were before.
    const user = createUser({ username: 'osk_tinder' });
    await setStatus(admin('root-admin'), user.id, { accountType: 'mod' });

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'role_changed'").get();

    expect(entry.actor_username).toBe('root-admin');
    expect(entry.target_username).toBe('osk_tinder');
    expect(entry.snippet).toBe('normal to mod');
  });

  it('is not an event when the role does not change', async () => {
    const user = createUser();
    await setStatus(admin(), user.id, { accountType: 'mod' });
    db.exec('DELETE FROM audit_log');

    await setStatus(admin(), user.id, { accountType: 'mod' });

    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'role_changed'").get().n).toBe(0);
  });
});

describe('a reply’s signature', () => {
  it('records what the writer was at the time', async () => {
    const moderator = mod();
    const reporter = createUser();
    const id = (await fileBug(reporter)).body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(moderator)).send({ body: 'Looking at it.' });

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));

    expect(res.body.comments[0].author.role).toBe('mod');
  });

  it('does not change when the writer is demoted afterwards', async () => {
    // The bug this fixes: the label used to be a live join, so a demotion rewrote every reply somebody
    // had ever left — and a promotion turned their old replies into official team statements.
    const moderator = dev('soon-normal');
    const reporter = createUser();
    const id = (await fileBug(reporter)).body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(moderator)).send({ body: 'Looking at it.' });

    await setStatus(admin(), moderator.id, { accountType: 'normal' });

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));
    expect(res.body.comments[0].author.role).toBe('dev');
  });

  it('does not appear when somebody is promoted afterwards', async () => {
    const reporter = createUser({ username: 'soon-mod' });
    const id = (await fileBug(reporter)).body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(reporter)).send({ body: 'Same here.' });

    await setStatus(admin(), reporter.id, { accountType: 'mod' });

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));
    expect(res.body.comments[0].author.role).toBeNull();
  });

  it('wears no badge for an ordinary reply', async () => {
    const reporter = createUser();
    const id = (await fileBug(reporter)).body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(reporter)).send({ body: 'Still happening.' });

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));

    expect(res.body.comments[0].author.role).toBeNull();
  });

  it('falls back to the live account for a reply written before the column existed', async () => {
    // No backfill is possible — there is no way to know what somebody was then, which is the whole point.
    const moderator = mod();
    const reporter = createUser();
    const id = (await fileBug(reporter)).body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(moderator)).send({ body: 'Looking at it.' });
    db.prepare('UPDATE feedback_comments SET author_role = NULL').run();

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));

    expect(res.body.comments[0].author.role).toBe('mod');
  });
});

describe('an ordinary account', () => {
  it('is turned away from everything staff', async () => {
    const user = createUser();
    const other = createUser();

    expect((await request(app).get('/api/users').set(authHeader(user))).status).toBe(403);
    expect((await request(app).get('/api/audit').set(authHeader(user))).status).toBe(403);
    expect((await setStatus(user, other.id, { status: 'suspended' })).status).toBe(403);
    expect((await request(app).delete(`/api/users/${other.id}/avatar`).set(authHeader(user))).status).toBe(403);
  });
});
