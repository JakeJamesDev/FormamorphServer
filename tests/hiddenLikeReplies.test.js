import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, seedLikes, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME, CODES } = require('../src/config/anonymousLikes');

/**
 * What a like press answers with on a contest entry whose count is hidden: the heart's new state and no
 * number, so pressing and unpressing cannot be used to read it. The reply keeps its `data` envelope.
 *
 * Every path that answers a like runs the same table of contest state, so a path that forgets the rule
 * fails here rather than leaking one number to a curious reader.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const publish = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(body));

const install = () => crypto.randomUUID();

const LIKES = 2;

const accountLike = (user, id, liked) =>
  request(app).put(`/api/worlds/${id}/like`).set(authHeader(user)).send({ liked });

const guestLike = (id, installId, liked) =>
  fromItsOwnAddress(request(app).put(`/api/worlds/${id}/anonymous-like`).set(INSTALL_HEADER_NAME, installId).send({ liked }));

const claim = (user, installId) =>
  request(app).post('/api/users/me/anonymous-likes/claim').set(authHeader(user)).set(INSTALL_HEADER_NAME, installId);

/** A contest entry with two account likes, its contest moved into `state`. `inContest: false` makes a plain listing. */
const seed = async (state, { inContest = true } = {}) => {
  const author = createUser({ username: 'reedwright' });
  const liker = createUser({ username: 'fenlark' });
  const staff = createUser({ username: 'a-mod', accountType: 'mod' });
  const admin = createUser({ username: 'an-admin', accountType: 'admin' });

  const event = Event.create({
    type: 'contest',
    title: 'Sedge Landing Contest',
    bannerText: 'Build on Sedge Landing.',
    body: 'Build something on Sedge Landing.',
    startsAt: at(-60),
    endsAt: at(60)
  });

  const entry = (await publish(author, {
    name: 'Marsh Warden',
    kind: 'entity',
    ...(inContest ? { contestEventId: event.id } : {})
  })).body.data;

  seedLikes(entry.id, Array.from({ length: LIKES }, () => createUser()));

  if (state === 'judging' || state === 'announced') {
    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
  }
  if (state === 'announced') Event.announceResults(event.id);
  if (state === 'withdrawn') {
    expect((await request(app).delete(`/api/worlds/${entry.id}/contest`).set(authHeader(author))).status).toBe(200);
  }
  if (state === 'canceled') {
    expect((await request(app).post(`/api/events/${event.id}/cancel`).set(authHeader(admin))).status).toBe(200);
  }

  return { entry, author, liker, staff };
};

const HIDING_STATES = ['live', 'judging'];
const OPEN_STATES = ['announced', 'withdrawn', 'canceled'];

const expectHidden = (body, liked) => {
  expect(body.success).toBe(true);
  expect(body.data).toEqual({ liked, likesHidden: true });
};

const expectCount = (body, liked, likes, extra = {}) => {
  expect(body.success).toBe(true);
  expect(body.data).toEqual({ liked, likes, ...extra });
};

describe.each(HIDING_STATES)('a like press on an entry whose contest is %s', (state) => {
  it('answers an account like and unlike with the heart and no count', async () => {
    const { entry, liker } = await seed(state);

    const like = await accountLike(liker, entry.id, true);
    expect(like.status).toBe(200);
    expectHidden(like.body, true);

    const unlike = await accountLike(liker, entry.id, false);
    expect(unlike.status).toBe(200);
    expectHidden(unlike.body, false);
  });

  it('answers staff with the count, marked private', async () => {
    const { entry, staff } = await seed(state);

    const res = await accountLike(staff, entry.id, true);

    expect(res.status).toBe(200);
    expectCount(res.body, true, LIKES + 1, { likesPrivate: true });
  });

  it('answers a guest like and unlike with the heart and no count', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry } = await seed(state);
    const installId = install();

    const like = await guestLike(entry.id, installId, true);
    expect(like.status).toBe(200);
    expectHidden(like.body, true);

    const unlike = await guestLike(entry.id, installId, false);
    expect(unlike.status).toBe(200);
    expectHidden(unlike.body, false);
  });

  it('answers a clear press with no count while the feature is switched off', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry } = await seed(state);
    const installId = install();
    await guestLike(entry.id, installId, true);
    Setting.set(ANONYMOUS_LIKES, false);

    const res = await guestLike(entry.id, installId, false);

    expect(res.status).toBe(200);
    expectHidden(res.body, false);
  });

  it('answers a guest press whose claiming account already likes it with no count', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry, liker } = await seed(state);
    const installId = install();
    expect((await claim(liker, installId)).status).toBe(200);
    await accountLike(liker, entry.id, true);

    const like = await guestLike(entry.id, installId, true);
    expect(like.status).toBe(200);
    expect(like.body.code).toBe(CODES.ACCOUNT_ALREADY_LIKED);
    expectHidden(like.body, true);
  });

  it('answers a clear press whose claiming account already likes it with no count', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry, liker } = await seed(state);
    const installId = install();
    expect((await claim(liker, installId)).status).toBe(200);
    await guestLike(entry.id, installId, true);
    await accountLike(liker, entry.id, true);

    const res = await guestLike(entry.id, installId, false);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(CODES.ACCOUNT_ALREADY_LIKED);
    expectHidden(res.body, true);
  });
});

describe.each(OPEN_STATES)('a like press on an entry whose contest is %s', (state) => {
  it('answers an account like with the plain count', async () => {
    const { entry, liker } = await seed(state);

    const res = await accountLike(liker, entry.id, true);

    expect(res.status).toBe(200);
    expectCount(res.body, true, LIKES + 1);
  });

  it('answers a guest like with the plain count', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry } = await seed(state);

    const res = await guestLike(entry.id, install(), true);

    expect(res.status).toBe(200);
    expectCount(res.body, true, LIKES + 1);
  });

  it('answers staff with the plain count and no private mark', async () => {
    const { entry, staff } = await seed(state);

    const res = await accountLike(staff, entry.id, true);

    expect(res.status).toBe(200);
    expectCount(res.body, true, LIKES + 1);
  });
});

describe('a like press on a listing outside any contest', () => {
  it('answers with the plain count on every path', async () => {
    Setting.set(ANONYMOUS_LIKES, true);
    const { entry, liker } = await seed('live', { inContest: false });
    const installId = install();
    expect((await claim(liker, installId)).status).toBe(200);

    expectCount((await accountLike(liker, entry.id, true)).body, true, LIKES + 1);
    expectCount((await guestLike(entry.id, installId, true)).body, true, LIKES + 1);
    expectCount((await guestLike(entry.id, installId, false)).body, true, LIKES + 1);
    expectCount((await accountLike(liker, entry.id, false)).body, false, LIKES);
  });
});

describe('staff removing a like from a hidden entry', () => {
  it('answers with the count as before', async () => {
    const { entry, liker, staff } = await seed('live');
    await accountLike(liker, entry.id, true);

    const res = await request(app).delete(`/api/worlds/${entry.id}/likes/${liker.id}`).set(authHeader(staff));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ likes: LIKES });
  });
});
