import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { app, request, db, paths } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const { sweepQuarantine } = require('../src/utils/sweepQuarantine');
const { eraseUser } = require('../src/utils/eraseUser');
const { backupPending, restorePending } = require('../src/utils/backupRestore');

/**
 * Pending updates: an author's edit to an approved listing waits for a mod while players keep the
 * approved version, files included. Approval applies it; rejection and discard drop it.
 *
 * Every read is made as the person the rule is about: a player, the author, or staff.
 */

const as = (req, user) => (user ? req.set(authHeader(user)) : req);
const tag = () => Math.random().toString(16).slice(2, 8);

const admin = () => createUser({ username: `admin-${tag()}`, accountType: 'admin' });
const mod = () => createUser({ username: `mod-${tag()}`, accountType: 'mod' });
const person = (name) => createUser({ username: `${name}-${tag()}` });

const setReview = (value) =>
  request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value });

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));
const edit = (id, user, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);
const download = (id, user) => as(request(app).get(`/api/worlds/${id}/content`), user);
const catalog = (user) => as(request(app).get('/api/worlds'), user);
const queue = (user) => as(request(app).get('/api/reviews'), user);
const count = (user) => as(request(app).get('/api/reviews/count'), user);
const reviewContent = (id, user) => as(request(app).get(`/api/reviews/${id}/content`), user);
const reviewThumbnail = (id, user) => as(request(app).get(`/api/reviews/${id}/thumbnail`), user);
const approve = (id, user) => as(request(app).post(`/api/reviews/${id}/approve`), user);
const reject = (id, user, body = {}) => as(request(app).post(`/api/reviews/${id}/reject`), user).send(body);
const discard = (id, user) => as(request(app).delete(`/api/reviews/${id}`), user);
const trust = (userId) => request(app).put(`/api/users/${userId}/trust`).set(authHeader(admin()));
const auditOf = (action) => request(app).get(`/api/audit?action=${action}`).set(authHeader(admin()));

/** A second image, so a replaced thumbnail is told apart by its bytes. */
const OTHER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = (uri) => Buffer.from(uri.split(',')[1], 'base64');

const pendingFiles = () => fs.readdirSync(paths.PENDING_DIR).sort();
const liveThumbnail = (thumbnailUrl) => path.join(paths.THUMBNAILS_DIR, thumbnailUrl.split('/').pop());
const publicThumbnail = (fileName) => request(app).get(`/api/thumbnails/${fileName}`);

const contentFor = (name) => ({ worldOverview: { name }, stats: [], locations: [], entities: [], traits: [], statUpdates: [] });

/** An approved listing from a normal author, then review on. */
const seedApproved = async (over = {}) => {
  await setReview(false);
  const author = person('author');
  const res = await publish(author, { name: 'Sedge Landing', description: 'A quiet marsh town', ...over });
  expect(res.status).toBe(201);
  await setReview(true);
  return { author, id: res.body.data.id, live: res.body.data, player: person('player'), staff: mod() };
};

/** An approved listing with a held edit to its name, description, thumbnail and content. */
const seedUpdate = async () => {
  const seeded = await seedApproved();
  const res = await edit(seeded.id, seeded.author, {
    name: 'Sedge Landing Redux',
    description: 'A loud marsh town',
    thumbnail: OTHER_PNG,
    contentData: contentFor('Sedge Landing Redux')
  });
  expect(res.status).toBe(200);
  return seeded;
};

describe('holding an edit to an approved listing', () => {
  it('keeps the approved version, files included, for players', async () => {
    const before = pendingFiles();
    const { id, live, player } = await seedUpdate();

    const res = await readOne(id, player);
    expect(res.body.data).toEqual(expect.objectContaining({
      name: 'Sedge Landing',
      description: 'A quiet marsh town',
      thumbnailUrl: live.thumbnailUrl
    }));
    expect(res.body.data).not.toHaveProperty('has_pending_update');
    expect(res.body.data).not.toHaveProperty('pending_update');

    expect((await download(id, player)).body.data.contentData.worldOverview.name).toBe('Sedge Landing');
    expect(fs.existsSync(liveThumbnail(live.thumbnailUrl))).toBe(true);
    expect((await publicThumbnail(live.thumbnailUrl.split('/').pop())).status).toBe(200);

    // The held content and thumbnail live in the pending directory, under names of their own.
    const added = pendingFiles().filter((name) => !before.includes(name));
    expect(added).toHaveLength(2);
    expect(added).not.toContain(`${id}.json`);
  });

  it('shows the author and staff the change beside the approved values', async () => {
    const { id, author, staff } = await seedUpdate();

    for (const reader of [author, staff]) {
      const res = await readOne(id, reader);
      expect(res.body.data.has_pending_update).toBe(true);
      expect(res.body.data.pending_update).toEqual({
        fields: {
          name: { approved: 'Sedge Landing', pending: 'Sedge Landing Redux' },
          description: { approved: 'A quiet marsh town', pending: 'A loud marsh town' }
        },
        changelog: [],
        content_changed: true,
        thumbnail_url: `/api/reviews/${id}/thumbnail`
      });
    }
  });

  it('answers the edit with the approved listing and the pending update', async () => {
    const { id, author } = await seedApproved();

    // The name is sent unchanged, so it is not listed as a change.
    const res = await edit(id, author, { name: 'Sedge Landing', description: 'A loud marsh town' });

    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('A quiet marsh town');
    expect(res.body.data.has_pending_update).toBe(true);
    expect(res.body.data.pending_update.fields).toEqual({
      description: { approved: 'A quiet marsh town', pending: 'A loud marsh town' }
    });
    expect(res.body.data.pending_update.content_changed).toBe(false);
    expect(res.body.data.pending_update).not.toHaveProperty('thumbnail_url');
  });

  it('marks list rows for the author and staff, never for a player', async () => {
    const { id, author, staff, player } = await seedUpdate();

    const row = async (reader) => (await catalog(reader)).body.data.find((world) => world.id === id);
    expect((await row(author)).has_pending_update).toBe(true);
    expect((await row(staff)).has_pending_update).toBe(true);
    expect(await row(player)).not.toHaveProperty('has_pending_update');
    expect(await row(null)).not.toHaveProperty('has_pending_update');
  });

  describe('the catalog pending preview', () => {
    const rowOf = async (id, reader) => (await catalog(reader)).body.data.find((world) => world.id === id);
    const queuedAt = (id) => db.prepare('SELECT queued_at FROM pending_updates WHERE world_id = ?').get(id).queued_at;

    it('gives staff and the author the pending name, queue time and thumbnail', async () => {
      const { id, author, staff } = await seedUpdate();

      for (const reader of [author, staff]) {
        expect((await rowOf(id, reader)).pending_preview).toEqual({
          name: 'Sedge Landing Redux',
          queued_at: queuedAt(id),
          thumbnail_url: `/api/reviews/${id}/thumbnail`
        });
      }
    });

    it('never gives another signed-in user or an anonymous reader the preview', async () => {
      const { id, player } = await seedUpdate();

      expect(await rowOf(id, player)).not.toHaveProperty('pending_preview');
      expect(await rowOf(id, null)).not.toHaveProperty('pending_preview');
    });

    it('names the approved name when the update leaves it alone, and omits an absent thumbnail', async () => {
      const { id, author, staff } = await seedApproved();
      await edit(id, author, { description: 'A loud marsh town' });

      const preview = (await rowOf(id, staff)).pending_preview;
      expect(preview).toEqual({ name: 'Sedge Landing', queued_at: queuedAt(id) });
      expect(preview).not.toHaveProperty('thumbnail_url');
    });

    it('leaves a row with no pending update without a preview', async () => {
      const { id, staff } = await seedApproved();

      expect(await rowOf(id, staff)).not.toHaveProperty('pending_preview');
    });

    it('leaves no helper column on a row', async () => {
      const { id, staff } = await seedUpdate();
      const row = await rowOf(id, staff);

      expect(Object.keys(row).filter((key) => key.startsWith('pending_'))).toEqual(['pending_preview']);
    });
  });

  it('applies at once with review off', async () => {
    await setReview(false);
    const author = person('author');
    const { id } = (await publish(author, { name: 'Sedge Landing' })).body.data;

    await edit(id, author, { name: 'Sedge Landing Redux' });

    expect((await readOne(id, person('player'))).body.data.name).toBe('Sedge Landing Redux');
    expect((await readOne(id, author)).body.data.has_pending_update).toBe(false);
  });

  it('applies a trusted author or staff edit at once and logs the auto-approval', async () => {
    const { id: trustedId, author } = await seedApproved();
    expect((await trust(author.id)).status).toBe(200);
    const staffAuthor = mod();
    const { id: staffId } = (await publish(staffAuthor, { name: 'Staff Landing' })).body.data;

    await edit(trustedId, author, { name: 'Trusted Redux' });
    await edit(staffId, staffAuthor, { name: 'Staff Redux' });

    const player = person('player');
    expect((await readOne(trustedId, player)).body.data.name).toBe('Trusted Redux');
    expect((await readOne(staffId, player)).body.data.name).toBe('Staff Redux');
    const logged = (await auditOf('listing_auto_approved')).body.data.map((entry) => entry.target.id);
    expect(logged).toEqual(expect.arrayContaining([trustedId, staffId]));
  });

  it('leaves the pending update when staff edit the listing, and applies the staff edit at once', async () => {
    const { id, author, player } = await seedUpdate();

    await edit(id, admin(), { description: 'Fixed by staff' });

    expect((await readOne(id, player)).body.data.description).toBe('Fixed by staff');
    expect((await readOne(id, author)).body.data.has_pending_update).toBe(true);
  });

  it('takes the author\'s next edit into the waiting update even after review is turned off', async () => {
    const { id, author, player } = await seedUpdate();
    await setReview(false);

    await edit(id, author, { description: 'Edited with review off' });

    expect((await readOne(id, player)).body.data.description).toBe('A quiet marsh town');
    expect((await readOne(id, author)).body.data.pending_update.fields.description.pending).toBe('Edited with review off');
  });
});

describe('re-editing a pending update', () => {
  it('merges the edit, replaces the held thumbnail and keeps the queue place', async () => {
    const { id, author, staff } = await seedUpdate();
    const queuedBefore = (await queue(staff)).body.data.find((item) => item.id === id).queuedAt;
    const filesBefore = pendingFiles();

    await edit(id, author, { description: 'Louder still', thumbnail: TINY_PNG });

    const update = (await readOne(id, author)).body.data.pending_update;
    expect(update.fields.name.pending).toBe('Sedge Landing Redux');
    expect(update.fields.description.pending).toBe('Louder still');
    expect(update.content_changed).toBe(true);
    expect((await queue(staff)).body.data.find((item) => item.id === id).queuedAt).toBe(queuedBefore);

    // One thumbnail out, one in; the held content stays.
    const filesAfter = pendingFiles();
    expect(filesAfter).toHaveLength(filesBefore.length);
    expect(filesAfter.filter((name) => !filesBefore.includes(name))).toHaveLength(1);
    expect((await reviewThumbnail(id, staff)).body).toEqual(pngBytes(TINY_PNG));
  });
});

describe('the review queue', () => {
  it('lists an update with its changed fields, and counts it', async () => {
    const { id, author, staff } = await seedUpdate();

    const item = (await queue(staff)).body.data.find((entry) => entry.id === id);

    expect(item).toEqual(expect.objectContaining({
      id,
      kind: 'world',
      name: 'Sedge Landing',
      type: 'update',
      author: expect.objectContaining({ id: author.id }),
      contest: null
    }));
    expect(item.pendingUpdate.fields.name).toEqual({ approved: 'Sedge Landing', pending: 'Sedge Landing Redux' });
    expect(item.pendingUpdate.content_changed).toBe(true);
    expect(item.quarantineExpiresAt).toBeNull();

    const listed = (await queue(staff)).body.data.length;
    expect((await count(staff)).body.data.count).toBe(listed);
  });

  it('shows the deadline of an update to a quarantined listing', async () => {
    const { id, staff } = await seedUpdate();
    const quarantined = await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(admin())).send({ days: 7 });
    expect(quarantined.status).toBe(200);

    const item = (await queue(staff)).body.data.find((entry) => entry.id === id);

    expect(item.type).toBe('update');
    expect(item.quarantineExpiresAt).toBe(quarantined.body.data.quarantineExpiresAt);
  });

  it('orders updates and new listings by how long they waited', async () => {
    const { id: updateId, staff } = await seedUpdate();
    const newId = (await publish(person('newcomer'), { name: 'Newer Landing' })).body.data.id;
    db.prepare('UPDATE pending_updates SET queued_at = ? WHERE world_id = ?').run('2000-01-01T00:00:00.000Z', updateId);
    db.prepare('UPDATE worlds SET moderation_queued_at = ? WHERE id = ?').run('2000-01-02T00:00:00.000Z', newId);

    const order = (await queue(staff)).body.data.map((item) => item.id);

    expect(order.indexOf(updateId)).toBeLessThan(order.indexOf(newId));
  });
});

describe('approving an update', () => {
  it('applies every field and both files, raising the revision once', async () => {
    const { id, staff, player, live } = await seedUpdate();
    const before = (await readOne(id, staff)).body.data;
    const filesBefore = pendingFiles();

    const res = await approve(id, staff);

    expect(res.status).toBe(200);
    expect(res.body.data.revision).toBe(before.revision + 1);
    expect(res.body.data.updatedAt > before.updated_at).toBe(true);

    const after = (await readOne(id, player)).body.data;
    expect(after.name).toBe('Sedge Landing Redux');
    expect(after.description).toBe('A loud marsh town');
    expect(after.thumbnailUrl).not.toBe(live.thumbnailUrl);
    expect((await publicThumbnail(after.thumbnailUrl.split('/').pop())).body).toEqual(pngBytes(OTHER_PNG));
    expect(fs.existsSync(liveThumbnail(live.thumbnailUrl))).toBe(false);
    expect((await download(id, player)).body.data.contentData.worldOverview.name).toBe('Sedge Landing Redux');

    expect(pendingFiles()).toHaveLength(filesBefore.length - 2);
    expect((await readOne(id, staff)).body.data.has_pending_update).toBe(false);
    expect((await queue(staff)).body.data.map((item) => item.id)).not.toContain(id);
  });

  it('logs update_approved with the listing id, and refuses a second decision', async () => {
    const { id, staff } = await seedUpdate();

    await approve(id, staff);

    const entry = (await auditOf('update_approved')).body.data.find((row) => row.target.id === id);
    expect(entry).toBeTruthy();
    expect((await approve(id, mod())).status).toBe(409);
    expect((await reject(id, mod())).status).toBe(409);
  });

  it('applies nothing when a held file is missing', async () => {
    const before = pendingFiles();
    const { id, staff, player, live } = await seedUpdate();
    const heldThumbnail = pendingFiles().find((name) => !before.includes(name) && !name.endsWith('.json'));
    fs.unlinkSync(path.join(paths.PENDING_DIR, heldThumbnail));

    expect((await approve(id, staff)).status).toBe(500);

    const after = (await readOne(id, player)).body.data;
    expect(after.name).toBe('Sedge Landing');
    expect(after.thumbnailUrl).toBe(live.thumbnailUrl);
    expect(fs.existsSync(liveThumbnail(live.thumbnailUrl))).toBe(true);
    expect((await readOne(id, staff)).body.data.has_pending_update).toBe(true);
  });

  it('refuses a mod on an admin\'s pending update', async () => {
    await setReview(true);
    const seeded = await seedUpdate();
    db.prepare("UPDATE users SET account_type = 'admin' WHERE id = ?").run(seeded.author.id);

    expect((await approve(seeded.id, mod())).status).toBe(403);
    expect((await readOne(seeded.id, seeded.staff)).body.data.has_pending_update).toBe(true);
  });
});

describe('rejecting an update', () => {
  it('drops it, leaves every live file intact and answers the author', async () => {
    const { id, author, staff, player, live } = await seedUpdate();
    const filesBefore = pendingFiles();

    const res = await reject(id, staff, { days: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, author: expect.objectContaining({ id: author.id, username: author.username }) });

    const after = (await readOne(id, player)).body.data;
    expect(after.name).toBe('Sedge Landing');
    expect(after.thumbnailUrl).toBe(live.thumbnailUrl);
    expect(after.quarantined_at ?? null).toBeNull();
    expect(fs.existsSync(liveThumbnail(live.thumbnailUrl))).toBe(true);
    expect((await download(id, player)).body.data.contentData.worldOverview.name).toBe('Sedge Landing');

    expect(pendingFiles()).toHaveLength(filesBefore.length - 2);
    expect((await readOne(id, author)).body.data.has_pending_update).toBe(false);
    expect((await auditOf('update_rejected')).body.data.map((row) => row.target.id)).toContain(id);
  });
});

describe('discarding an update', () => {
  it('lets the author withdraw it and nobody else', async () => {
    const { id, author, staff, player } = await seedUpdate();
    const filesBefore = pendingFiles();

    expect((await discard(id, player)).status).toBe(404);
    expect((await discard(id, staff)).status).toBe(404);
    expect((await discard(id, author)).status).toBe(200);

    expect((await readOne(id, author)).body.data.has_pending_update).toBe(false);
    expect((await readOne(id, player)).body.data.name).toBe('Sedge Landing');
    expect(pendingFiles()).toHaveLength(filesBefore.length - 2);
    expect((await discard(id, author)).status).toBe(404);
  });
});

describe('the pending files', () => {
  it('serves the held thumbnail to staff and the author only', async () => {
    const { id, author, staff, player } = await seedUpdate();

    for (const reader of [author, staff]) {
      const res = await reviewThumbnail(id, reader);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(pngBytes(OTHER_PNG));
    }
    expect((await reviewThumbnail(id, player)).status).toBe(404);
    expect((await reviewThumbnail(id, null)).status).toBe(401);
  });

  it('never serves a held file from the public thumbnails route', async () => {
    const before = pendingFiles();
    await seedUpdate();
    const held = pendingFiles().filter((name) => !before.includes(name) && !name.endsWith('.json'));

    expect(held).toHaveLength(1);
    expect((await publicThumbnail(held[0])).status).toBe(404);
  });

  it('serves the held content to a mod, and nothing when content did not change', async () => {
    const { id, staff, player } = await seedUpdate();

    const res = await reviewContent(id, staff);
    expect(res.status).toBe(200);
    expect(res.body.data.contentData.worldOverview.name).toBe('Sedge Landing Redux');
    expect((await reviewContent(id, player)).status).toBe(404);

    const other = await seedApproved();
    await edit(other.id, other.author, { name: 'Only The Name' });
    expect((await reviewContent(other.id, other.staff)).status).toBe(404);
  });
});

describe('deleting a listing with a pending update', () => {
  it('removes the held files when the author deletes it', async () => {
    const before = pendingFiles();
    const { id, author } = await seedUpdate();

    expect((await request(app).delete(`/api/worlds/${id}`).set(authHeader(author))).status).toBe(200);

    expect(pendingFiles()).toEqual(before);
  });

  it('removes the held files when the quarantine sweep deletes it', async () => {
    const before = pendingFiles();
    const { id } = await seedUpdate();
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(admin())).send({});
    db.prepare('UPDATE worlds SET quarantine_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);

    await sweepQuarantine();

    expect(db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c).toBe(0);
    expect(pendingFiles()).toEqual(before);
  });

  it('removes the held files when the account is erased with its content', async () => {
    const before = pendingFiles();
    const { author } = await seedUpdate();

    await eraseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(author.id), { removeContent: true });

    expect(pendingFiles()).toEqual(before);
  });

  it('drops the pending update when the account is erased and its content kept', async () => {
    const before = pendingFiles();
    const { id, author, staff, player } = await seedUpdate();

    await eraseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(author.id), { removeContent: false });

    expect(pendingFiles()).toEqual(before);
    expect((await queue(staff)).body.data.map((item) => item.id)).not.toContain(id);
    expect((await readOne(id, staff)).body.data.has_pending_update).toBe(false);
    expect((await readOne(id, player)).body.data.name).toBe('Sedge Landing');
  });

  it('deletes waiting and rejected new listings, files included, when the content is kept', async () => {
    const { id: approvedId, author, staff } = await seedApproved();
    const waiting = (await publish(author, { name: 'Waiting Landing' })).body.data;
    const rejected = (await publish(author, { name: 'Rejected Landing' })).body.data;
    expect((await reject(rejected.id, staff, { days: 3 })).status).toBe(200);

    await eraseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(author.id), { removeContent: false });

    for (const gone of [waiting, rejected]) {
      expect((await readOne(gone.id, staff)).status).toBe(404);
      expect(fs.existsSync(liveThumbnail(gone.thumbnailUrl))).toBe(false);
      expect(fs.existsSync(path.join(paths.WORLDS_DIR, `${gone.id}.json`))).toBe(false);
    }
    expect((await readOne(approvedId, person('player'))).status).toBe(200);
  });
});

describe('backup and restore', () => {
  it('carry the pending directory', async () => {
    await seedUpdate();
    const held = pendingFiles();
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-backup-'));

    await backupPending(backupDir);
    for (const name of held) fs.unlinkSync(path.join(paths.PENDING_DIR, name));
    await restorePending(backupDir);

    expect(pendingFiles()).toEqual(held);
  });
});
