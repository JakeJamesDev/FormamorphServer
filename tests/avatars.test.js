import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app, db, paths } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

/**
 * Profile images.
 *
 * The three things worth guarding: only the owner (or an admin) can change one, the file on disk and the
 * row pointing at it stay in step, and the URL reaches every place a name is shown — a name with an
 * avatar beside it in one list and not in another reads as two different people.
 */

/** A 1x1 lossless WebP, which is the shape the crop step produces. */
const TINY_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

const admin = (username = 'root-admin') => createUser({ username, accountType: 'admin' });

const setAvatar = (user, image = TINY_WEBP) =>
  request(app).put('/api/users/me/avatar').set(authHeader(user)).send({ image });

const removeMine = (user) => request(app).delete('/api/users/me/avatar').set(authHeader(user));

const removeTheirs = (actor, id) => request(app).delete(`/api/users/${id}/avatar`).set(authHeader(actor));

/** The `avatar_file` column as stored, which is what the URL is built from. */
const storedFile = (id) => db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(id).avatar_file;

const onDisk = (file) => fs.existsSync(path.join(paths.AVATARS_DIR, file));

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

describe('setting your own', () => {
  it('stores the image and answers with its URL', async () => {
    const user = createUser({ username: 'wren_hallow' });

    const res = await setAvatar(user);

    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBe(`/api/avatars/${storedFile(user.id)}`);
    expect(onDisk(storedFile(user.id))).toBe(true);
  });

  it('records when it changed, which is not the same as having one', async () => {
    const user = createUser();
    await setAvatar(user);

    const row = db.prepare('SELECT avatar_updated_at FROM users WHERE id = ?').get(user.id);

    expect(row.avatar_updated_at).toBeTruthy();
  });

  it('deletes the one it replaces rather than leaving it on disk', async () => {
    // Nothing points at the old file once the row moves, so leaving it is litter nothing ever sweeps.
    const user = createUser();
    await setAvatar(user);
    const first = storedFile(user.id);

    await setAvatar(user);
    const second = storedFile(user.id);

    expect(second).not.toBe(first);
    expect(onDisk(first)).toBe(false);
    expect(onDisk(second)).toBe(true);
  });

  it('gives each upload its own name, so a replacement cannot come from a cache', async () => {
    const user = createUser();
    const first = (await setAvatar(user)).body.data.avatarUrl;

    const second = (await setAvatar(user)).body.data.avatarUrl;

    expect(second).not.toBe(first);
  });

  it('refuses a format the crop step never produces', async () => {
    // The client always re-encodes to lossless WebP (or PNG where the canvas cannot). A JPEG arriving
    // here means something other than the crop dialog sent it.
    const user = createUser();

    const res = await setAvatar(user, TINY_PNG.replace('image/png', 'image/jpeg'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported avatar type/);
  });

  it('accepts the PNG fallback, for a browser whose canvas cannot encode WebP', async () => {
    const user = createUser();

    const res = await setAvatar(user, TINY_PNG);

    expect(res.status).toBe(200);
    expect(storedFile(user.id).endsWith('.png')).toBe(true);
  });

  it('refuses something that is not an image at all', async () => {
    const user = createUser();

    const res = await setAvatar(user, 'not-a-data-uri');

    expect(res.status).toBe(400);
  });

  it('refuses an empty request', async () => {
    const user = createUser();

    const res = await request(app).put('/api/users/me/avatar').set(authHeader(user)).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image is required/i);
  });

  it('takes nothing from a stranger', async () => {
    const res = await request(app).put('/api/users/me/avatar').send({ image: TINY_WEBP });

    expect(res.status).toBe(401);
  });

  it('refuses a suspended account, like every other write', async () => {
    const user = createUser({ status: 'suspended' });

    const res = await setAvatar(user);

    expect(res.status).toBe(403);
  });
});

describe('removing your own', () => {
  it('clears the row and the file', async () => {
    const user = createUser();
    await setAvatar(user);
    const file = storedFile(user.id);

    const res = await removeMine(user);

    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
    expect(storedFile(user.id)).toBeNull();
    expect(onDisk(file)).toBe(false);
  });

  it('is fine when there was none', async () => {
    // Nothing to undo, and an error here would strand a client whose state had drifted.
    const user = createUser();

    expect((await removeMine(user)).status).toBe(200);
  });
});

describe('an administrator removing somebody else', () => {
  it('clears it and says so in the log', async () => {
    const moderator = admin();
    const user = createUser({ username: 'osk_tinder' });
    await setAvatar(user);
    const file = storedFile(user.id);

    const res = await removeTheirs(moderator, user.id);

    expect(res.status).toBe(200);
    expect(storedFile(user.id)).toBeNull();
    expect(onDisk(file)).toBe(false);

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'avatar_removed'").get();
    expect(entry.actor_username).toBe('root-admin');
    expect(entry.target_username).toBe('osk_tinder');
    expect(entry.target_name).toBe('osk_tinder');
  });

  it('is not something an ordinary account can do to another', async () => {
    const user = createUser();
    const other = createUser();
    await setAvatar(other);

    const res = await removeTheirs(user, other.id);

    expect(res.status).toBe(403);
    expect(storedFile(other.id)).not.toBeNull();
  });

  it('says so when there is nothing to remove', async () => {
    const moderator = admin();
    const user = createUser();

    const res = await removeTheirs(moderator, user.id);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no profile image/i);
  });

  it('404s on an account that does not exist', async () => {
    const moderator = admin();

    expect((await removeTheirs(moderator, 'no-such-user')).status).toBe(404);
  });

  it('names nobody else when an admin clears their own', async () => {
    // The actor already reads as the person; a target user as well would say it twice.
    const moderator = admin();
    await setAvatar(moderator);

    await removeTheirs(moderator, moderator.id);

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'avatar_removed'").get();
    expect(entry.target_username).toBeNull();
    expect(entry.target_name).toBe('root-admin');
  });
});

describe('serving the image', () => {
  it('is public, so a signed-out visitor sees the same faces', async () => {
    // The catalog and its comments are open to signed-out visitors, so the name beside the avatar is
    // already public. Gating the image would leave a page of blank circles for nothing.
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
  });

  it('is cacheable forever, because the name never gets reused', async () => {
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;

    const res = await request(app).get(url);

    expect(res.headers['cache-control']).toMatch(/immutable/);
    // The client and the server are different origins, so Helmet's default would block the image.
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('404s on a name nothing is stored under', async () => {
    expect((await request(app).get('/api/avatars/nope.webp')).status).toBe(404);
  });

  it('refuses an extension nothing is ever written as', async () => {
    // A type this route would have to guess at cannot name a real avatar.
    expect((await request(app).get('/api/avatars/anything.svg')).status).toBe(404);
  });

  it('cannot be walked out of its own directory', async () => {
    // Isolates the traversal strip from the extension allowlist: a target the allowlist would wave
    // through, sitting one directory up. Without `path.basename` this serves a file nothing published.
    const outside = path.join(paths.STORAGE_ROOT, 'not-an-avatar.webp');
    fs.writeFileSync(outside, 'secret');

    try {
      const res = await request(app).get('/api/avatars/..%2fnot-an-avatar.webp');

      expect(res.status).toBe(404);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('turns away a name whose extension it would have to guess at', async () => {
    const res = await request(app).get('/api/avatars/..%2f..%2fdata%2fexotic-dangerous.db');

    expect(res.status).toBe(404);
  });
});

describe('where the avatar shows', () => {
  it('rides along with a catalog listing author', async () => {
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;
    await publish(user);

    const res = await request(app).get('/api/worlds');

    expect(res.body.data[0].author.avatarUrl).toBe(url);
  });

  it('rides along with one listing read on its own', async () => {
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;
    const id = (await publish(user)).body.data.id;

    const res = await request(app).get(`/api/worlds/${id}`);

    expect(res.body.data.author.avatarUrl).toBe(url);
  });

  it('rides along with a comment', async () => {
    const author = createUser();
    const commenter = createUser();
    const url = (await setAvatar(commenter)).body.data.avatarUrl;
    const id = (await publish(author)).body.data.id;
    await request(app).post(`/api/worlds/${id}/comments`).set(authHeader(commenter))
      .send({ content: 'The tide puzzle is excellent.' });

    const res = await request(app).get(`/api/worlds/${id}/comments`);

    expect(res.body.data[0].author.avatarUrl).toBe(url);
  });

  it('rides along with a feedback thread and its replies', async () => {
    const reporter = createUser();
    const url = (await setAvatar(reporter)).body.data.avatarUrl;
    const filed = await request(app).post('/api/feedback').set(authHeader(reporter))
      .send({ type: 'bug', title: 'Tide puzzle unsolvable', category: 'other', body: 'Selling the lantern early locks it.' });
    const id = filed.body.data.id;
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(reporter)).send({ body: 'Still happening.' });

    const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(reporter));

    expect(res.body.data.reporter.avatarUrl).toBe(url);
    expect(res.body.comments[0].author.avatarUrl).toBe(url);
  });

  it('rides along with the admin user table', async () => {
    const moderator = admin();
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;

    const res = await request(app).get('/api/users?limit=100').set(authHeader(moderator));

    expect(res.body.data.find((u) => u.id === user.id).avatarUrl).toBe(url);
  });

  it('rides along with your own profile', async () => {
    const user = createUser();
    const url = (await setAvatar(user)).body.data.avatarUrl;

    const res = await request(app).get('/api/users/me').set(authHeader(user));

    expect(res.body.user.avatarUrl).toBe(url);
  });

  it('is null for somebody who has never set one', async () => {
    // Null rather than absent: the client renders a fallback circle, and an undefined field would make
    // "no avatar" indistinguishable from an endpoint that forgot to send it.
    const user = createUser();
    await publish(user);

    const res = await request(app).get('/api/worlds');

    expect(res.body.data[0].author.avatarUrl).toBeNull();
  });
});
