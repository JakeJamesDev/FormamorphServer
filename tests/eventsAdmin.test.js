import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * The events write surface — who may schedule a happening, and what they are allowed to do to one
 * afterwards.
 *
 * Three rules carry the weight. Speaking to everyone at once is the owner's alone, so the moderation
 * team can read these routes and nothing more. At most one contest can be running at any instant, which
 * is held by refusing the write rather than by policing it later — so both the create path and the edit
 * path have to ask. And once something has been announced it can only be called off, never quietly
 * removed: the notice that went out has to still have an event behind it.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const WINDOWS = {
  scheduled: { startsAt: at(60), endsAt: at(120) },
  active: { startsAt: at(-60), endsAt: at(60) },
  ended: { startsAt: at(-120), endsAt: at(-60) }
};

const payload = (over = {}) => ({
  type: 'announcement',
  title: 'Sedge Landing Week',
  bannerText: 'A week of building on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  ...WINDOWS.scheduled,
  ...over
});

/** Seeded straight into the table, so a test can place a window in the past without the create route. */
const seed = (over = {}) => Event.create(payload(over));

const admin = () => createUser({ username: `admin-${Math.random().toString(16).slice(2, 8)}`, accountType: 'admin' });
const mod = () => createUser({ username: `mod-${Math.random().toString(16).slice(2, 8)}`, accountType: 'mod' });
const normal = () => createUser({ username: `user-${Math.random().toString(16).slice(2, 8)}` });

const auditActions = () => db
  .prepare('SELECT action, target_kind, target_name, snippet, actor_username FROM audit_log ORDER BY id')
  .all();

const messageRows = () => db.prepare('SELECT * FROM messages ORDER BY created_at, id').all();

describe('the events write routes', () => {
  const routes = [
    ['post', '/api/events', payload()],
    ['put', '/api/events/:id', { title: 'Renamed' }],
    ['post', '/api/events/:id/cancel', {}],
    ['delete', '/api/events/:id', {}]
  ];

  it.each(routes)('refuse %s %s to a signed-out caller', async (method, path, body) => {
    const event = seed();

    const response = await request(app)[method](path.replace(':id', event.id)).send(body);

    expect(response.status).toBe(401);
  });

  it.each(routes)('refuse %s %s to an ordinary account', async (method, path, body) => {
    const event = seed();

    const response = await request(app)[method](path.replace(':id', event.id))
      .set(authHeader(normal()))
      .send(body);

    expect(response.status).toBe(403);
  });

  it.each(routes)('refuse %s %s to staff who are not administrators', async (method, path, body) => {
    // Staff read these routes and pick a winner; scheduling and withdrawing an event is the owner's,
    // exactly as sending a broadcast is.
    const event = seed();

    const response = await request(app)[method](path.replace(':id', event.id))
      .set(authHeader(mod()))
      .send(body);

    expect(response.status).toBe(403);
  });

  it.each(routes)('admit %s %s to an administrator', async (method, path, body) => {
    const event = seed();

    const response = await request(app)[method](path.replace(':id', event.id))
      .set(authHeader(admin()))
      .send(body);

    expect(response.status).toBeLessThan(400);
  });

  it('answer 404 for an event that does not exist', async () => {
    const header = authHeader(admin());
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await request(app).put(`/api/events/${missing}`).set(header).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/events/${missing}/cancel`).set(header).send({})).status).toBe(404);
    expect((await request(app).delete(`/api/events/${missing}`).set(header)).status).toBe(404);
  });
});

describe('scheduling an event', () => {
  it('stores what was sent and answers with it', async () => {
    const response = await request(app).post('/api/events')
      .set(authHeader(admin()))
      .send(payload({ type: 'contest', rulesText: 'One entry each.' }));

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      type: 'contest',
      state: 'scheduled',
      title: 'Sedge Landing Week',
      rulesText: 'One entry each.'
    });
    expect(Event.findById(response.body.data.id).created_by).toBeTruthy();
  });

  it('opens immediately when its window has already started', async () => {
    // Scheduling something for right now has to send the notice now. The sweeper alone would leave the
    // banner missing until the next tick, up to an hour later.
    const response = await request(app).post('/api/events')
      .set(authHeader(admin()))
      .send(payload(WINDOWS.active));

    expect(response.body.data.state).toBe('active');
    expect(response.body.data.startMessageId).toBeTruthy();
  });

  it('normalizes the window to ISO whatever format it arrived in', async () => {
    const response = await request(app).post('/api/events')
      .set(authHeader(admin()))
      .send(payload({ startsAt: 'June 1, 2026 12:00:00 UTC', endsAt: 'June 8, 2026 12:00:00 UTC' }));

    expect(response.body.data.startsAt).toBe('2026-06-01T12:00:00.000Z');
    expect(response.body.data.endsAt).toBe('2026-06-08T12:00:00.000Z');
  });

  it.each([
    ['a missing title', { title: '   ' }],
    ['a missing banner line', { bannerText: '' }],
    ['a missing body', { body: undefined }],
    ['an unknown type', { type: 'jamboree' }],
    ['an unreadable start', { startsAt: 'whenever' }],
    ['an unreadable end', { endsAt: null }],
    ['an end before its start', { startsAt: at(120), endsAt: at(60) }],
    ['a zero-length window', { startsAt: at(60), endsAt: at(60) }],
    ['an over-long title', { title: 'x'.repeat(121) }],
    ['an over-long banner line', { bannerText: 'x'.repeat(281) }]
  ])('refuses %s', async (_case, over) => {
    const response = await request(app).post('/api/events')
      .set(authHeader(admin()))
      .send(payload(over));

    expect(response.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get().n).toBe(0);
  });
});

describe('the one-active-contest rule', () => {
  const window = { startsAt: '2026-06-01T12:00:00.000Z', endsAt: '2026-06-08T12:00:00.000Z' };

  const postContest = (over = {}) => request(app).post('/api/events')
    .set(authHeader(admin()))
    .send(payload({ type: 'contest', ...window, ...over }));

  it('refuses a contest overlapping another one', async () => {
    seed({ type: 'contest', ...window });

    const response = await postContest({ startsAt: '2026-06-07T12:00:00.000Z', endsAt: '2026-06-14T12:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Sedge Landing Week');
  });

  it('allows a contest that starts exactly as another ends', async () => {
    // The window is half-open everywhere else, so back-to-back contests are never both running.
    seed({ type: 'contest', ...window });

    const response = await postContest({ startsAt: window.endsAt, endsAt: '2026-06-15T12:00:00.000Z' });

    expect(response.status).toBe(201);
  });

  it('allows a contest overlapping one that was called off', async () => {
    const cancelled = seed({ type: 'contest', ...window });
    Event.cancel(cancelled.id);

    expect((await postContest()).status).toBe(201);
  });

  it('allows a contest overlapping an announcement, and an announcement overlapping a contest', async () => {
    seed({ type: 'announcement', ...window });
    expect((await postContest()).status).toBe(201);

    const response = await request(app).post('/api/events')
      .set(authHeader(admin()))
      .send(payload({ type: 'announcement', ...window }));

    expect(response.status).toBe(201);
  });

  it('refuses an edit that extends a contest into another one', async () => {
    // The check is on the resulting window, not on the field that moved — the start never changed here.
    const first = seed({ type: 'contest', ...window });
    seed({ type: 'contest', startsAt: '2026-07-01T12:00:00.000Z', endsAt: '2026-07-08T12:00:00.000Z' });

    const response = await request(app).put(`/api/events/${first.id}`)
      .set(authHeader(admin()))
      .send({ endsAt: '2026-07-04T12:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(Event.findById(first.id).ends_at).toBe(window.endsAt);
  });

  it('lets a contest keep its own window on an unrelated edit', async () => {
    const contest = seed({ type: 'contest', ...window });

    const response = await request(app).put(`/api/events/${contest.id}`)
      .set(authHeader(admin()))
      .send({ title: 'Sedge Landing Fortnight' });

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Sedge Landing Fortnight');
  });
});

describe('editing an event', () => {
  it('writes only the fields that were sent', async () => {
    const event = seed({ rulesText: 'One entry each.' });

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ bannerText: 'Two days left.' });

    expect(response.body.data).toMatchObject({
      bannerText: 'Two days left.',
      title: 'Sedge Landing Week',
      rulesText: 'One entry each.'
    });
  });

  it('clears the rules when they are sent empty', async () => {
    const event = seed({ rulesText: 'One entry each.' });

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ rulesText: '' });

    expect(response.body.data.rulesText).toBeNull();
  });

  it('refuses moving the start of an event that has begun', async () => {
    const event = seed(WINDOWS.active);

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ startsAt: at(-10) });

    expect(response.status).toBe(400);
    expect(Event.findById(event.id).starts_at).toBe(event.starts_at);
  });

  it('accepts the unchanged start of an event that has begun', async () => {
    // An editor that sends the whole form back must not be refused for the field it did not touch.
    const event = seed(WINDOWS.active);

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ startsAt: event.starts_at, endsAt: at(180) });

    expect(response.status).toBe(200);
    expect(response.body.data.endsAt).toBe(Event.findById(event.id).ends_at);
  });

  it('allows moving the start of an event that has not begun', async () => {
    const event = seed();

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ startsAt: at(180), endsAt: at(240) });

    expect(response.status).toBe(200);
    expect(response.body.data.startsAt).not.toBe(event.starts_at);
  });

  it('refuses changing what kind of event it is', async () => {
    const event = seed({ type: 'contest' });

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ type: 'announcement' });

    expect(response.status).toBe(400);
    expect(Event.findById(event.id).type).toBe('contest');
  });

  it('refuses an end moved before the start', async () => {
    const event = seed();

    const response = await request(app).put(`/api/events/${event.id}`)
      .set(authHeader(admin()))
      .send({ endsAt: at(30) });

    expect(response.status).toBe(400);
  });

  it('never re-fires the notices', async () => {
    // Wording that has already gone out is fixed through the message edit route. An edit that posted
    // again would announce the same event twice and re-pin something people had already seen.
    const admins = admin();
    const created = await request(app).post('/api/events').set(authHeader(admins)).send(payload(WINDOWS.active));
    const before = messageRows();

    await request(app).put(`/api/events/${created.body.data.id}`)
      .set(authHeader(admins))
      .send({ title: 'Sedge Landing Fortnight', bannerText: 'Now with two weeks.', endsAt: at(240) });

    const after = messageRows();
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.subject)).toEqual(before.map((row) => row.subject));
  });
});

describe('cancelling an event', () => {
  it('stamps the row and drops it from the public lists', async () => {
    const event = seed(WINDOWS.active);

    const response = await request(app).post(`/api/events/${event.id}/cancel`)
      .set(authHeader(admin()))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('cancelled');
    expect((await request(app).get('/api/events/active')).body.data).toHaveLength(0);
  });

  it('takes the pin down and says so, once, however often it is called', async () => {
    const actor = admin();
    const created = await request(app).post('/api/events').set(authHeader(actor)).send(payload(WINDOWS.active));
    const id = created.body.data.id;

    await request(app).post(`/api/events/${id}/cancel`).set(authHeader(actor)).send({});
    const afterFirst = messageRows();

    await request(app).post(`/api/events/${id}/cancel`).set(authHeader(actor)).send({});

    expect(messageRows()).toHaveLength(afterFirst.length);
    expect(afterFirst.filter((row) => row.subject.includes('cancelled'))).toHaveLength(1);
    expect(afterFirst.find((row) => row.id === Event.findById(id).start_message_id).recalled_at).toBeTruthy();
    expect(auditActions().filter((row) => row.action === 'event_cancelled')).toHaveLength(1);
  });

  it('says nothing about an event nobody was ever told about', async () => {
    const event = seed();

    await request(app).post(`/api/events/${event.id}/cancel`).set(authHeader(admin())).send({});

    expect(messageRows()).toHaveLength(0);
    expect(Event.findById(event.id).cancelled_at).toBeTruthy();
  });

  it('releases the worlds entered into it', async () => {
    // The clear is still guarded on the column existing, for a database that has not migrated yet. What
    // this checks is the other half: that it lands on this event's entries and leaves the rest alone.
    const owner = createUser({ username: 'entrant' });
    const contest = seed({ type: 'contest', ...WINDOWS.active });
    const other = seed({ type: 'contest', ...WINDOWS.ended });
    const world = (name, eventId) => {
      const id = `world-${name}`;
      db.prepare(`
        INSERT INTO worlds (id, name, description, author_id, thumbnail_file, content_file, contest_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, 'entered', owner.id, `${id}.png`, `${id}.json`, eventId);
      return id;
    };
    const entered = world('entered', contest.id);
    const elsewhere = world('elsewhere', other.id);

    await request(app).post(`/api/events/${contest.id}/cancel`).set(authHeader(admin())).send({});

    const flagOf = (id) => db.prepare('SELECT contest_event_id FROM worlds WHERE id = ?').get(id).contest_event_id;
    expect(flagOf(entered)).toBeNull();
    expect(flagOf(elsewhere)).toBe(other.id);
  });

  it('works on a database that has no entry column yet', async () => {
    const event = seed({ type: 'contest', ...WINDOWS.active });

    expect((await request(app).post(`/api/events/${event.id}/cancel`).set(authHeader(admin())).send({})).status).toBe(200);
  });
});

describe('deleting an event', () => {
  it('removes one that has not started', async () => {
    const event = seed();

    const response = await request(app).delete(`/api/events/${event.id}`).set(authHeader(admin()));

    expect(response.status).toBe(200);
    expect(Event.findById(event.id)).toBeUndefined();
  });

  it('refuses one that has started', async () => {
    const event = seed(WINDOWS.active);

    const response = await request(app).delete(`/api/events/${event.id}`).set(authHeader(admin()));

    expect(response.status).toBe(409);
    expect(Event.findById(event.id)).toBeTruthy();
  });

  it('refuses one that has ended', async () => {
    const event = seed(WINDOWS.ended);

    expect((await request(app).delete(`/api/events/${event.id}`).set(authHeader(admin()))).status).toBe(409);
  });

  it('refuses one that started and was then cancelled', async () => {
    // Cancelling does not make a delete legal again: the notice that went out still needs an event
    // behind it.
    const event = seed(WINDOWS.active);
    Event.cancel(event.id);

    expect((await request(app).delete(`/api/events/${event.id}`).set(authHeader(admin()))).status).toBe(409);
  });

  it('removes one that was cancelled before it started', async () => {
    const event = seed();
    Event.cancel(event.id);

    expect((await request(app).delete(`/api/events/${event.id}`).set(authHeader(admin()))).status).toBe(200);
  });
});

describe('the audit trail', () => {
  it('records who did what to which event', async () => {
    const actor = admin();
    const header = authHeader(actor);

    const created = await request(app).post('/api/events').set(header).send(payload());
    const id = created.body.data.id;
    await request(app).put(`/api/events/${id}`).set(header).send({ title: 'Sedge Landing Fortnight' });
    await request(app).post(`/api/events/${id}/cancel`).set(header).send({});

    const doomed = await request(app).post('/api/events').set(header).send(payload({ startsAt: at(300), endsAt: at(360) }));
    await request(app).delete(`/api/events/${doomed.body.data.id}`).set(header);

    expect(auditActions().map((row) => row.action)).toEqual([
      'event_created', 'event_edited', 'event_cancelled', 'event_created', 'event_deleted'
    ]);
    expect(auditActions()[1]).toMatchObject({
      target_kind: 'event',
      target_name: 'Sedge Landing Fortnight',
      snippet: id,
      actor_username: actor.username
    });
  });

  it('offers the event actions on the admin filter list', async () => {
    const response = await request(app).get('/api/audit/meta').set(authHeader(admin()));

    expect(response.body.actions).toEqual(expect.arrayContaining([
      'event_created', 'event_edited', 'event_cancelled', 'event_deleted'
    ]));
  });
});
