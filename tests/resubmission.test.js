import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const { sweepQuarantine } = require('../src/utils/sweepQuarantine');

/**
 * A rejected listing the author fixes and sends back: its place in the queue, the deadline it keeps, and
 * how approval or a staff release ends the quarantine.
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
const edit = (user, id, over = {}) =>
  request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(worldPayload({ name: 'Sedge Landing', ...over }));
const setSpoiler = (user, id) =>
  request(app).put(`/api/worlds/${id}/spoiler`).set(authHeader(user)).send({ spoiler: true });

const queue = (user) => as(request(app).get('/api/reviews'), user);
const count = (user) => as(request(app).get('/api/reviews/count'), user);
const approve = (id, user) => as(request(app).post(`/api/reviews/${id}/approve`), user);
const reject = (id, user, body = {}) => as(request(app).post(`/api/reviews/${id}/reject`), user).send(body);
const quarantine = (id, user, body = {}) => as(request(app).put(`/api/worlds/${id}/quarantine`), user).send(body);
const release = (id, user) => as(request(app).delete(`/api/worlds/${id}/quarantine`), user);
const readOne = (id, user) => as(request(app).get(`/api/worlds/${id}`), user);
const catalog = (user) => as(request(app).get('/api/worlds'), user);
const auditOf = (action) => request(app).get(`/api/audit?action=${action}`).set(authHeader(admin()));

const ids = (rows) => rows.map((row) => row.id);
const itemFor = async (id, user) => (await queue(user)).body.data.find((item) => item.id === id);
const DAY = 24 * 60 * 60 * 1000;

/** Publish a pending listing from a normal author and reject it for `days`. */
const seedRejected = async (days = 3) => {
  await setReview(true);
  const author = person('author');
  const res = await publish(author, { name: 'Sedge Landing' });
  expect(res.status).toBe(201);
  const id = res.body.data.id;
  const staff = mod();
  const rejected = await reject(id, staff, { days });
  expect(rejected.status).toBe(200);
  return { author, id, staff, player: person('player'), deadline: rejected.body.data.quarantineExpiresAt };
};

/** A rejected listing its author has fixed once. */
const seedResubmitted = async () => {
  const seeded = await seedRejected();
  expect((await edit(seeded.author, seeded.id, { description: 'Fixed.' })).status).toBe(200);
  return seeded;
};

const queuedAt = (id) => db.prepare('SELECT moderation_queued_at AS at FROM worlds WHERE id = ?').get(id).at;
const expire = (id) =>
  db.prepare("UPDATE worlds SET quarantine_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
const exists = (id) => db.prepare('SELECT COUNT(*) AS c FROM worlds WHERE id = ?').get(id).c === 1;

describe('the author fixing a rejected listing', () => {
  it('sends it back to the queue as resubmitted, with its deadline, behind what already waits', async () => {
    const { author, id, staff, deadline } = await seedRejected();
    const before = queuedAt(id);
    expect(await itemFor(id, staff)).toBeUndefined();

    expect((await edit(author, id, { description: 'Fixed.' })).status).toBe(200);

    const item = await itemFor(id, staff);
    expect(item).toMatchObject({ type: 'resubmitted' });
    expect(Date.parse(item.queuedAt)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(item.quarantineExpiresAt)).toBe(Date.parse(deadline) + 7 * DAY);
    expect((await count(staff)).body.data.count).toBe(1);
    expect((await readOne(id, author)).body.data.moderation_state).toBe('pending');
  });

  it('extends the deadline once and logs each fix, through the quarantine path', async () => {
    const { author, id, deadline } = await seedRejected();

    await edit(author, id, { description: 'Fixed.' });
    await edit(author, id, { description: 'Fixed again.' });

    const own = (await readOne(id, author)).body.data;
    expect(Date.parse(own.quarantine_expires_at)).toBe(Date.parse(deadline) + 7 * DAY);
    const log = (await auditOf('quarantine_updated')).body.data;
    expect(log).toHaveLength(2);
    expect(log[1].snippet).toMatch(/extended by 7 days/i);
    expect(log[0].snippet).toMatch(/already been extended/i);
  });

  it('resubmits with review off, and for a trusted author', async () => {
    const { author, id, staff } = await seedRejected();
    await setReview(false);
    await request(app).put(`/api/users/${author.id}/trust`).set(authHeader(admin()));

    await edit(author, id, { description: 'Fixed.' });

    expect((await itemFor(id, staff)).type).toBe('resubmitted');
  });

  it('is only the main update: a side route and a staff edit leave it rejected', async () => {
    const { id, staff } = await seedRejected();

    expect((await setSpoiler(staff, id)).status).toBe(200);
    expect((await edit(admin(), id, { description: 'Staff note.' })).status).toBe(200);

    expect((await readOne(id, staff)).body.data.moderation_state).toBe('rejected');
    expect(await itemFor(id, staff)).toBeUndefined();
  });

  it('labels a new listing new, with no deadline', async () => {
    await setReview(true);
    const { body } = await publish(person('author'));
    const staff = mod();

    expect(await itemFor(body.data.id, staff)).toMatchObject({ type: 'new', quarantineExpiresAt: null });
  });
});

describe('rejecting a resubmission', () => {
  it('keeps the deadline and the extension, and ignores days', async () => {
    const { author, id, staff } = await seedResubmitted();
    const kept = (await readOne(id, author)).body.data;

    const res = await reject(id, staff, { days: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      author: { id: author.id },
      quarantinedAt: kept.quarantined_at,
      quarantineExpiresAt: kept.quarantine_expires_at,
      quarantineExtended: true
    });
    expect((await readOne(id, author)).body.data.moderation_state).toBe('rejected');
    expect(await itemFor(id, staff)).toBeUndefined();

    const log = (await auditOf('listing_rejected')).body.data;
    expect(log[0].snippet).toContain(kept.quarantine_expires_at);
  });

  it('gives no second extension on the next fix', async () => {
    const { author, id, staff } = await seedResubmitted();
    const kept = (await readOne(id, author)).body.data.quarantine_expires_at;
    await reject(id, staff);

    await edit(author, id, { description: 'Third try.' });

    expect((await itemFor(id, staff)).quarantineExpiresAt).toBe(kept);
  });
});

describe('approving a resubmission', () => {
  it('ends the quarantine and puts it live as new', async () => {
    const { author, id, staff, player } = await seedResubmitted();

    const res = await approve(id, staff);

    expect(res.status).toBe(200);
    const own = (await readOne(id, author)).body.data;
    expect(own).toMatchObject({
      moderation_state: 'approved',
      quarantined_at: null,
      quarantine_expires_at: null
    });
    expect(own.quarantine_extended).toBeFalsy();
    expect(own.listed_at).toBe(res.body.data.listedAt);
    expect(ids((await catalog(player)).body.data)).toContain(id);
    expect((await count(staff)).body.data.count).toBe(0);
  });
});

describe('a pending listing quarantined through the quarantine route', () => {
  it('waits as resubmitted, and a release lifts only the quarantine', async () => {
    await setReview(true);
    const author = person('author');
    const id = (await publish(author)).body.data.id;
    const root = admin();
    await quarantine(id, root, { days: 5 });

    expect((await itemFor(id, root)).type).toBe('resubmitted');

    expect((await release(id, root)).status).toBe(200);
    expect(await itemFor(id, root)).toMatchObject({ type: 'new', quarantineExpiresAt: null });
    expect((await readOne(id, author)).body.data.moderation_state).toBe('pending');
  });
});

describe('a staff release of a rejected listing', () => {
  it('approves it into the catalog and logs the approval', async () => {
    const { author, id, player } = await seedRejected();
    const root = admin();

    expect((await release(id, root)).status).toBe(200);

    const own = (await readOne(id, author)).body.data;
    expect(own.moderation_state).toBe('approved');
    expect(own.quarantined_at).toBeNull();
    expect(Date.parse(own.listed_at)).toBe(Date.parse(own.updated_at));
    expect(ids((await catalog(player)).body.data)).toContain(id);

    const approved = (await auditOf('listing_approved')).body.data;
    expect(approved).toHaveLength(1);
    expect(approved[0].target).toMatchObject({ id });
    expect((await auditOf('quarantine_released')).body.data).toHaveLength(0);
  });
});

describe('the quarantine sweep', () => {
  it('deletes a rejected listing at its deadline', async () => {
    const { id } = await seedRejected();
    expire(id);

    await sweepQuarantine();

    expect(exists(id)).toBe(false);
  });

  it('deletes a resubmission at its deadline: the clock keeps running in the queue', async () => {
    const { id } = await seedResubmitted();
    expire(id);

    await sweepQuarantine();

    expect(exists(id)).toBe(false);
  });
});

describe('staff reviewing their own listing', () => {
  // Promoted after submitting, which is the one way a staff member's listing waits.
  const promote = (user, role) => db.prepare('UPDATE users SET account_type = ? WHERE id = ?').run(role, user.id);

  it('is refused on approve and reject, for an admin too, while the content stays readable', async () => {
    await setReview(true);
    const author = person('author');
    const id = (await publish(author)).body.data.id;
    promote(author, 'admin');

    expect((await approve(id, author)).status).toBe(403);
    expect((await reject(id, author)).status).toBe(403);
    expect((await request(app).get(`/api/reviews/${id}/content`).set(authHeader(author))).status).toBe(200);
    expect((await readOne(id, author)).body.data.moderation_state).toBe('pending');
  });

  it('is refused on the release that approves', async () => {
    const { author, id } = await seedRejected();
    promote(author, 'admin');

    expect((await release(id, author)).status).toBe(403);
    expect((await readOne(id, author)).body.data.moderation_state).toBe('rejected');
  });
});
