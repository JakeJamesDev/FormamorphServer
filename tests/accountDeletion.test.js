import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { app, db, paths } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const { sweepDeletions } = require('../src/utils/sweepDeletions');
const deleteUser = require('../src/utils/deleteUser');
const bcrypt = require('bcryptjs');
const {
  PLACEHOLDER_ID, PLACEHOLDER_USERNAME, GRACE_PERIOD_DAYS, NO_PASSWORD
} = require('../src/config/accountDeletion');

/**
 * Leaving.
 *
 * A user asks, nothing happens for seven days, and then everything of theirs goes at once. The four things
 * that have to hold: only the account's owner can start it, signing in inside the window takes it back
 * whole, the erasure itself leaves no trace of the name, and the person who chose to leave their work
 * behind still has work behind them.
 */

const { DAY_MS } = require('../src/config/time');

/** A 1x1 lossless WebP, which is the shape the crop step produces. */
const TINY_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

/**
 * The credential routes share one limiter of twenty attempts per address, and supertest sends every
 * request from the same one. Each call here declares an address of its own, exactly as a request through
 * Cloudflare arrives with one, so a file with thirty logins in it is not testing the rate limiter.
 */
let caller = 0;
const fromItsOwnAddress = (req) => req.set('CF-Connecting-IP', `203.0.113.${(caller += 1) % 250}`);

const askToDelete = (user, body) => fromItsOwnAddress(
  request(app).post('/api/auth/delete-account').set(authHeader(user)).send(body)
);

const login = (user, password = user.password) => fromItsOwnAddress(
  request(app).post('/api/auth/login').send({ username: user.username, password })
);

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const comment = (user, worldId, content = 'A remark') =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content });

const like = (user, worldId) =>
  request(app).put(`/api/worlds/${worldId}/like`).set(authHeader(user)).send({ liked: true });

const follow = (user, id) => request(app).put(`/api/users/${id}/follow`).set(authHeader(user));

const setAvatar = (user) =>
  request(app).put('/api/users/me/avatar').set(authHeader(user)).send({ image: TINY_WEBP });

const readListing = (id) => request(app).get(`/api/worlds/${id}`);

const readComments = (worldId) => request(app).get(`/api/worlds/${worldId}/comments`);

const readProfile = (id) => request(app).get(`/api/users/${id}/profile`);

const auditEntries = async (staff) =>
  (await request(app).get('/api/audit?limit=100').set(authHeader(staff))).body.data;

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

const worldRow = (id) => db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);

const signalCount = (userId) => db
  .prepare('SELECT COUNT(*) AS count FROM signals WHERE user_id = ?')
  .get(userId).count;

const acceptanceCount = (userId) => db
  .prepare('SELECT COUNT(*) AS count FROM policy_acceptances WHERE user_id = ?')
  .get(userId).count;

/** Record an answer to the upload gate. The policy it answers has to exist for the row's key to hold. */
const answerPolicy = (user) => {
  db.prepare(`
    INSERT OR IGNORE INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
    VALUES ('upload_gate', 1, 'Terms', 'The terms.', '[]', 1, ?)
  `).run(new Date().toISOString());

  db.prepare(`
    INSERT INTO policy_acceptances (policy_id, user_id, accepted_version, accepted_at, response)
    VALUES ('upload_gate', ?, 1, ?, 'accepted')
  `).run(user.id, new Date().toISOString());
};

const onDisk = (dir, file) => Boolean(file) && fs.existsSync(path.join(dir, file));

/** Move a standing request back in time, so the sweeper has something due without the suite waiting. */
const backdateRequest = (user, days) => db
  .prepare('UPDATE users SET deletion_requested_at = ? WHERE id = ?')
  .run(new Date(Date.now() - days * DAY_MS).toISOString(), user.id);

/** Ask, put the request past the window, and run the sweeper: the whole route from asking to gone. */
const askAndSweep = async (user, deleteContent) => {
  await askToDelete(user, { password: user.password, deleteContent });
  backdateRequest(user, GRACE_PERIOD_DAYS + 1);
  return sweepDeletions();
};

/** An author with one listing, one comment on it, and a profile image. */
const seedAuthor = async (over = {}) => {
  const author = createUser({ username: 'wren_hallow', ...over });
  const listing = (await publish(author, { name: 'Sedge Landing' })).body.data;
  await comment(author, listing.id, 'My own note');
  await setAvatar(author);

  return { author, listing, avatarFile: userRow(author.id).avatar_file };
};

/** Enable the Privacy Policy, which refuses every authenticated route until it is accepted. */
const enablePrivacyPolicy = () => db.prepare(`
  INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
  VALUES ('privacy_policy', 1, 'Privacy Policy', 'What we store.', '[]', 1, ?)
`).run(new Date().toISOString());

describe('asking to be deleted', () => {
  it('stamps the request and answers with the date the erasure runs', async () => {
    const user = createUser({ username: 'wren_hallow' });

    const res = await askToDelete(user, { password: user.password, deleteContent: false });

    expect(res.status).toBe(200);
    const stamped = userRow(user.id).deletion_requested_at;
    expect(stamped).toBeTruthy();
    expect(new Date(res.body.deletionScheduledFor).getTime())
      .toBe(new Date(stamped).getTime() + GRACE_PERIOD_DAYS * DAY_MS);
  });

  it('changes nothing else, so there is nothing for a cancellation to restore', async () => {
    const { author, listing } = await seedAuthor();

    await askToDelete(author, { password: author.password, deleteContent: true });

    const shown = await readListing(listing.id);
    expect(shown.status).toBe(200);
    expect(shown.body.data.author.username).toBe('wren_hallow');
    expect((await readComments(listing.id)).body.data).toHaveLength(1);
    expect((await readProfile(author.id)).status).toBe(200);
  });

  it('refuses a wrong password, and stamps nothing', async () => {
    const user = createUser({ username: 'wren_hallow' });

    const res = await askToDelete(user, { password: 'not-the-password', deleteContent: true });

    expect(res.status).toBe(401);
    expect(userRow(user.id).deletion_requested_at).toBeNull();
  });

  it('refuses a suspended account, and points it at Feedback', async () => {
    // A suspension is evidence about somebody. The account it is about does not get to erase it, and is
    // told where the path it does have is rather than being refused with nothing.
    const user = createUser({ username: 'wren_hallow', status: 'suspended' });

    const res = await askToDelete(user, { password: user.password, deleteContent: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Feedback/);
    expect(userRow(user.id).deletion_requested_at).toBeNull();
  });

  it('requires the content choice rather than assuming one', async () => {
    const user = createUser({ username: 'wren_hallow' });

    const res = await askToDelete(user, { password: user.password });

    expect(res.status).toBe(400);
    expect(userRow(user.id).deletion_requested_at).toBeNull();
  });

  it('leaves a standing request exactly as it is when it is asked again', async () => {
    // Idempotent rather than re-stamped: asking twice must not push the date out, or an account could be
    // held inside the window for as long as somebody kept asking.
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'wren_hallow' });
    const first = await askToDelete(user, { password: user.password, deleteContent: false });
    const stamped = userRow(user.id).deletion_requested_at;

    const second = await askToDelete(user, { password: user.password, deleteContent: true });

    expect(second.status).toBe(200);
    expect(second.body.deletionScheduledFor).toBe(first.body.deletionScheduledFor);
    expect(userRow(user.id).deletion_requested_at).toBe(stamped);
    expect(userRow(user.id).deletion_removes_content).toBe(0);
    const requests = (await auditEntries(staff)).filter((e) => e.action === 'account_deletion_requested');
    expect(requests).toHaveLength(1);
  });

  it('is allowed while the Privacy Policy is refusing everything else', async () => {
    // The policy prompt's third button is Delete my account, so the gate cannot stand in front of the one
    // route that gets somebody out from behind it.
    const user = createUser({ username: 'wren_hallow' });
    enablePrivacyPolicy();

    const refused = await request(app).get('/api/users/me').set(authHeader(user));
    const res = await askToDelete(user, { password: user.password, deleteContent: true });

    expect(refused.body.code).toBe('PRIVACY_REQUIRED');
    expect(res.status).toBe(200);
  });

  it('writes the request to the audit log with the content choice', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'wren_hallow' });

    await askToDelete(user, { password: user.password, deleteContent: true });

    const entry = (await auditEntries(staff)).find((e) => e.action === 'account_deletion_requested');
    expect(entry.actor.username).toBe('wren_hallow');
    expect(entry.snippet).toBe('content deleted');
  });

  it('is refused to a signed-out visitor', async () => {
    const user = createUser({ username: 'wren_hallow' });

    const res = await fromItsOwnAddress(
      request(app).post('/api/auth/delete-account').send({ password: user.password, deleteContent: true })
    );

    expect(res.status).toBe(401);
    expect(userRow(user.id).deletion_requested_at).toBeNull();
  });
});

describe('the grace period', () => {
  it('is cancelled by signing in, which says so', async () => {
    const user = createUser({ username: 'wren_hallow' });
    await askToDelete(user, { password: user.password, deleteContent: true });

    const res = await login(user);

    expect(res.status).toBe(200);
    expect(res.body.deletionCanceled).toBe(true);
    expect(userRow(user.id).deletion_requested_at).toBeNull();
    expect(userRow(user.id).deletion_removes_content).toBe(0);
  });

  it('says so once, on the login that did it', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'wren_hallow' });
    await askToDelete(user, { password: user.password, deleteContent: true });
    await login(user);

    const again = await login(user);

    expect(again.body.deletionCanceled).toBeUndefined();
    const cancelled = (await auditEntries(staff)).filter((e) => e.action === 'account_deletion_canceled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].actor.username).toBe('wren_hallow');
  });

  it('says nothing on a login by an account that never asked', async () => {
    const user = createUser({ username: 'wren_hallow' });

    expect((await login(user)).body.deletionCanceled).toBeUndefined();
  });

  it('is not shortened by a failed sign-in', async () => {
    const user = createUser({ username: 'wren_hallow' });
    await askToDelete(user, { password: user.password, deleteContent: true });

    const res = await login(user, 'not-the-password');

    expect(res.status).toBe(401);
    expect(userRow(user.id).deletion_requested_at).toBeTruthy();
  });

  it('holds the account until it has run out', async () => {
    const user = createUser({ username: 'wren_hallow' });
    await askToDelete(user, { password: user.password, deleteContent: true });

    const erased = await sweepDeletions(new Date(Date.now() + (GRACE_PERIOD_DAYS - 1) * DAY_MS).toISOString());

    expect(erased).toBe(0);
    expect(userRow(user.id)).toBeTruthy();
  });

  it('runs the whole way round: ask, cancel by signing in, ask again, seven days, gone', async () => {
    const { author, listing } = await seedAuthor();

    await askToDelete(author, { password: author.password, deleteContent: true });
    expect((await login(author)).body.deletionCanceled).toBe(true);
    expect((await readListing(listing.id)).status).toBe(200);

    await askToDelete(author, { password: author.password, deleteContent: true });
    expect(await sweepDeletions(new Date(Date.now() + 6 * DAY_MS).toISOString())).toBe(0);
    expect(await sweepDeletions(new Date(Date.now() + 8 * DAY_MS).toISOString())).toBe(1);

    expect(userRow(author.id)).toBeUndefined();
    expect((await readListing(listing.id)).status).toBe(404);
  });
});

describe('erasing an account that took its work with it', () => {
  const erase = (user) => askAndSweep(user, true);

  it('takes the listings, their files and the comments on them', async () => {
    const { author, listing } = await seedAuthor();
    const stored = worldRow(listing.id);

    expect(await erase(author)).toBe(1);

    expect(worldRow(listing.id)).toBeUndefined();
    expect(onDisk(paths.WORLDS_DIR, stored.content_file)).toBe(false);
    expect(onDisk(paths.THUMBNAILS_DIR, stored.thumbnail_file)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count).toBe(0);
  });

  it('takes the comments they left elsewhere, and the counts with them', async () => {
    const host = createUser({ username: 'host' });
    const leaver = createUser({ username: 'wren_hallow' });
    const listing = (await publish(host, { name: 'Sedge Landing' })).body.data;
    await comment(leaver, listing.id, 'Passing through');
    await comment(host, listing.id, 'Thanks');

    await erase(leaver);

    const remaining = (await readComments(listing.id)).body.data;
    expect(remaining.map((c) => c.author.username)).toEqual(['host']);
    expect(worldRow(listing.id).comment_count).toBe(1);
  });

  it('takes the profile image with it', async () => {
    const { author, avatarFile } = await seedAuthor();

    await erase(author);

    expect(onDisk(paths.AVATARS_DIR, avatarFile)).toBe(false);
  });

  it('takes the likes, the follows and the Signals it left behind', async () => {
    const host = createUser({ username: 'host' });
    const leaver = createUser({ username: 'wren_hallow' });
    const listing = (await publish(host, { name: 'Sedge Landing' })).body.data;
    await like(leaver, listing.id);
    await follow(leaver, host.id);
    await login(leaver);

    await erase(leaver);

    expect((await readListing(listing.id)).body.data.likes).toBe(0);
    expect((await readProfile(host.id)).body.data.followers).toBe(0);
    // Signals have no endpoint of their own until the staff views land, so the cascade that clears them is
    // read where it happens. The host's own Signals stay, or this would pass against an empty table.
    expect(signalCount(leaver.id)).toBe(0);
    expect(signalCount(host.id)).toBeGreaterThan(0);
  });

  it('takes the policy answers and the read state with it', async () => {
    const leaver = createUser({ username: 'wren_hallow' });
    const host = createUser({ username: 'host' });
    for (const user of [leaver, host]) answerPolicy(user);

    await erase(leaver);

    expect(acceptanceCount(leaver.id)).toBe(0);
    expect(acceptanceCount(host.id)).toBe(1);
  });

  it('writes the erasure to the audit log under the name that is now gone', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'wren_hallow' });

    await erase(user);

    const entry = (await auditEntries(staff)).find((e) => e.action === 'account_deleted');
    expect(entry.targetUser.username).toBe('wren_hallow');
    expect(entry.snippet).toBe('content deleted');
  });
});

describe('erasing an account that left its work behind', () => {
  const erase = (user) => askAndSweep(user, false);

  it('hands the listings and the comments to the placeholder, name and all', async () => {
    const { author, listing } = await seedAuthor();

    expect(await erase(author)).toBe(1);

    const shown = await readListing(listing.id);
    expect(shown.status).toBe(200);
    expect(shown.body.data.author.username).toBe(PLACEHOLDER_USERNAME);
    const comments = (await readComments(listing.id)).body.data;
    expect(comments.map((c) => c.author.username)).toEqual([PLACEHOLDER_USERNAME]);
  });

  it('leaves the original name in no listing, comment, placement or profile', async () => {
    const { author, listing } = await seedAuthor();
    db.prepare(`
      INSERT INTO events (id, type, title, banner_text, body, starts_at, ends_at, created_at, updated_at)
      VALUES ('e-1', 'contest', 'Autumn Ruins', 'Banner', 'Body', ?, ?, ?, ?)
    `).run(new Date(Date.now() - 2 * DAY_MS).toISOString(), new Date(Date.now() - DAY_MS).toISOString(),
      new Date().toISOString(), new Date().toISOString());
    db.prepare(`
      INSERT INTO event_placements (event_id, place, world_id, world_name, author_name, created_at)
      VALUES ('e-1', 1, ?, 'Sedge Landing', 'wren_hallow', ?)
    `).run(listing.id, new Date().toISOString());

    await erase(author);

    const placement = db.prepare("SELECT * FROM event_placements WHERE event_id = 'e-1'").get();
    expect(placement.world_name).toBe('Sedge Landing');
    expect(placement.author_name).toBe(PLACEHOLDER_USERNAME);
    expect((await readProfile(author.id)).status).toBe(404);
    expect(JSON.stringify((await readListing(listing.id)).body)).not.toMatch(/wren_hallow/);
    expect(JSON.stringify((await readComments(listing.id)).body)).not.toMatch(/wren_hallow/);
  });

  it('leaves the listing files where they are', async () => {
    const { author, listing } = await seedAuthor();
    const stored = worldRow(listing.id);

    await erase(author);

    expect(onDisk(paths.WORLDS_DIR, stored.content_file)).toBe(true);
    expect(onDisk(paths.THUMBNAILS_DIR, stored.thumbnail_file)).toBe(true);
  });

  it('still takes the profile image, which is the face and not the work', async () => {
    const { author, avatarFile } = await seedAuthor();

    await erase(author);

    expect(onDisk(paths.AVATARS_DIR, avatarFile)).toBe(false);
    expect(userRow(PLACEHOLDER_ID).avatar_file).toBeNull();
  });

  it('still takes the likes, follows, Signals and policy answers, which are the account and not the work', async () => {
    // Keeping the work is a choice about listings and comments. Everything else the account did is gone on
    // this path exactly as it is on the other.
    const host = createUser({ username: 'host' });
    const leaver = createUser({ username: 'wren_hallow' });
    const listing = (await publish(host, { name: 'Sedge Landing' })).body.data;
    await like(leaver, listing.id);
    await follow(leaver, host.id);
    await login(leaver);
    answerPolicy(leaver);

    await erase(leaver);

    expect((await readListing(listing.id)).body.data.likes).toBe(0);
    expect((await readProfile(host.id)).body.data.followers).toBe(0);
    expect(signalCount(leaver.id)).toBe(0);
    expect(acceptanceCount(leaver.id)).toBe(0);
  });

  it('says which path it took in the audit log', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'wren_hallow' });

    await erase(user);

    const entry = (await auditEntries(staff)).find((e) => e.action === 'account_deleted');
    expect(entry.snippet).toBe('content kept');
  });
});

describe('the reserved placeholder account', () => {
  it('cannot be signed in as, whatever is offered', async () => {
    const attempts = await Promise.all(
      ['*', '', 'password123'].map((password) => login({ username: PLACEHOLDER_USERNAME }, password))
    );

    expect(attempts.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(attempts.every((res) => res.body.error === 'Invalid credentials')).toBe(true);
  });

  it('is refused even by a password that would otherwise match', async () => {
    // The stored value is nothing bcrypt can match, but that is the second line of defense and not the
    // first. Give the row a real hash — as a bad migration or a curious operator could — and the status
    // still has to turn the login away, or the account every departed user's work points at is a way in.
    db.prepare('UPDATE users SET password = ? WHERE id = ?')
      .run(bcrypt.hashSync('password123', 10), PLACEHOLDER_ID);

    const res = await login({ username: PLACEHOLDER_USERNAME }, 'password123');

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();

    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(NO_PASSWORD, PLACEHOLDER_ID);
  });

  it('is not one of the accounts staff manage', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });

    const res = await request(app).get('/api/users?limit=100').set(authHeader(staff));

    expect(res.body.data.map((user) => user.username)).toEqual(['root-admin']);
    expect(res.body.total).toBe(1);
  });

  it('cannot be given an ordinary status, which would open the login it refuses', async () => {
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });

    const res = await request(app)
      .put(`/api/users/${PLACEHOLDER_ID}/status`)
      .set(authHeader(staff))
      .send({ status: 'normal' });

    expect(res.status).toBe(403);
    expect(userRow(PLACEHOLDER_ID).status).toBe('system');
  });

  it('cannot itself be erased', async () => {
    const result = await deleteUser(PLACEHOLDER_USERNAME);

    expect(result.success).toBe(false);
    expect(userRow(PLACEHOLDER_ID)).toBeTruthy();
  });
});

describe('the command-line tool', () => {
  it('erases exactly as the sweeper does', async () => {
    const { author, listing } = await seedAuthor();
    const stored = worldRow(listing.id);

    const result = await deleteUser('wren_hallow');

    expect(result.success).toBe(true);
    expect(result.deletedData).toMatchObject({ user: 'wren_hallow', worlds: 1, comments: 1 });
    expect(userRow(author.id)).toBeUndefined();
    expect(worldRow(listing.id)).toBeUndefined();
    expect(onDisk(paths.WORLDS_DIR, stored.content_file)).toBe(false);
  });

  it('can take the other path and leave the work behind', async () => {
    const { author, listing } = await seedAuthor();

    const result = await deleteUser('wren_hallow', { keepContent: true });

    expect(result.success).toBe(true);
    expect(userRow(author.id)).toBeUndefined();
    expect((await readListing(listing.id)).body.data.author.username).toBe(PLACEHOLDER_USERNAME);
  });

  it('reports a name it cannot find rather than erasing something else', async () => {
    const result = await deleteUser('nobody-by-that-name');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('a file that cannot be removed', () => {
  it('still leaves the account wholly erased', async () => {
    // Rows commit before any file is touched, so a failed unlink costs an orphaned file and nothing else.
    const staff = createUser({ username: 'root-admin', accountType: 'admin' });
    const { author, listing } = await seedAuthor();
    const stored = worldRow(listing.id);
    const contentPath = path.join(paths.WORLDS_DIR, stored.content_file);
    fs.unlinkSync(contentPath);
    fs.mkdirSync(contentPath); // a directory where the file was: unlink refuses it

    const result = await deleteUser('wren_hallow');

    expect(result.success).toBe(true);
    expect(userRow(author.id)).toBeUndefined();
    expect(worldRow(listing.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count).toBe(0);
    // And the trail still says it happened. An audit written after the files would skip exactly the
    // erasures worth reading about later.
    const entry = (await auditEntries(staff)).find((e) => e.action === 'account_deleted');
    expect(entry.targetUser.username).toBe('wren_hallow');

    fs.rmdirSync(contentPath);
  });
});
