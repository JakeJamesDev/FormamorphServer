import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, Event, cancelEvent, createTables, createIndexes } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Server events — timed community happenings, and the notices the server posts about them.
 *
 * Three things have to hold. The state of an event is its window and nothing else, so two callers asking
 * at the same instant can never disagree about whether something is running. The lists show each caller
 * what they are entitled to: everyone sees what has been announced, staff also see what has not. And the
 * transitions leave exactly one trail — a pinned notice while it runs, taken down when it is over — no
 * matter how often the sweeper runs or how long the server was down over a deadline.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

/** Windows named by where they sit relative to now, so the tests read as states rather than arithmetic. */
const WINDOWS = {
  scheduled: { startsAt: at(60), endsAt: at(120) },
  active: { startsAt: at(-60), endsAt: at(60) },
  ended: { startsAt: at(-120), endsAt: at(-60) }
};

const makeEvent = (over = {}) => Event.create({
  type: 'announcement',
  title: 'Sedge Landing Week',
  bannerText: 'A week of building on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  ...WINDOWS.active,
  ...over
});

const activeList = (user) => {
  const r = request(app).get('/api/events/active');
  return user ? r.set(authHeader(user)) : r;
};

const list = (user) => {
  const r = request(app).get('/api/events');
  return user ? r.set(authHeader(user)) : r;
};

const slimList = (user) => {
  const r = request(app).get('/api/events?slim=1');
  return user ? r.set(authHeader(user)) : r;
};

const detail = (id, user) => {
  const r = request(app).get(`/api/events/${id}`);
  return user ? r.set(authHeader(user)) : r;
};

const idsOf = (response) => response.body.data.map((event) => event.id);

const inbox = async (user) =>
  (await request(app).get('/api/messages').set(authHeader(user))).body.data;

const messageRow = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id);

/** A reader who existed before anything was posted, so broadcast scope is never why they miss one. */
const reader = () => createUser({ username: 'reader', createdAt: '2000-01-01T00:00:00.000Z' });

describe('the events table', () => {
  it('is created by the boot schema step and survives it running again', async () => {
    const event = makeEvent();

    createTables();
    createIndexes();
    createTables();
    createIndexes();

    expect(Event.findById(event.id).title).toBe('Sedge Landing Week');
  });
});

describe('an event state', () => {
  it('is scheduled before its window, active inside it, and ended after', () => {
    const event = makeEvent({ startsAt: '2026-06-01T12:00:00.000Z', endsAt: '2026-06-08T12:00:00.000Z' });

    expect(Event.findById(event.id, '2026-05-31T23:59:59.000Z').state).toBe('scheduled');
    expect(Event.findById(event.id, '2026-06-04T00:00:00.000Z').state).toBe('active');
    expect(Event.findById(event.id, '2026-06-09T00:00:00.000Z').state).toBe('ended');
  });

  it('starts on its opening instant and is over on its closing one', () => {
    // Half-open, `starts_at ≤ now < ends_at`: back-to-back events must not both read active for the
    // instant they share.
    const event = makeEvent({ startsAt: '2026-06-01T12:00:00.000Z', endsAt: '2026-06-08T12:00:00.000Z' });

    expect(Event.findById(event.id, '2026-06-01T12:00:00.000Z').state).toBe('active');
    expect(Event.findById(event.id, '2026-06-08T12:00:00.000Z').state).toBe('ended');
  });

  it('reads the same from an instant written the way the other tables write theirs', () => {
    // The documented trap: this table writes ISO, while `users` and `messages` default to
    // CURRENT_TIMESTAMP. Compared as raw strings 'T' sorts above ' ', so a mixed pair orders backwards
    // and a running event reads as one that has not started.
    // Same calendar day as the start, so the space-versus-'T' at character eleven is what decides it.
    const event = makeEvent({ startsAt: '2026-06-04T12:00:00.000Z', endsAt: '2026-06-08T12:00:00.000Z' });

    expect(Event.findById(event.id, '2026-06-04 13:00:00').state).toBe('active');
    expect(Event.findById(event.id, '2026-06-08 13:00:00').state).toBe('ended');
  });

  it('is cancelled whatever its window says', () => {
    const event = makeEvent(WINDOWS.active);
    Event.cancel(event.id);

    expect(Event.findById(event.id).state).toBe('cancelled');
  });
});

describe('GET /api/events/active', () => {
  it('serves the running events to a signed-out visitor', async () => {
    const running = makeEvent(WINDOWS.active);
    makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    makeEvent({ ...WINDOWS.ended, title: 'Last month' });

    const response = await activeList();

    expect(response.status).toBe(200);
    expect(idsOf(response)).toEqual([running.id]);
  });

  it('carries every type, so a client can filter to what it understands', async () => {
    const contest = makeEvent({ ...WINDOWS.active, type: 'contest', title: 'Build-off' });
    const announcement = makeEvent(WINDOWS.active);

    const response = await activeList();

    expect(idsOf(response).sort()).toEqual([contest.id, announcement.id].sort());
    expect(response.body.data.map((event) => event.type).sort()).toEqual(['announcement', 'contest']);
  });

  it('drops a cancelled event for staff as well as for everyone else', async () => {
    const event = makeEvent(WINDOWS.active);
    Event.cancel(event.id);

    expect(idsOf(await activeList())).toEqual([]);
    expect(idsOf(await activeList(createUser({ username: 'mod', accountType: 'mod' })))).toEqual([]);
  });

  it('names the notice it posted, so the banner and the inbox badge agree', async () => {
    makeEvent(WINDOWS.active);

    const [event] = (await activeList()).body.data;

    expect(event.startMessageId).toBeTruthy();
    expect(messageRow(event.startMessageId).scope).toBe('pinned');
  });

  it('carries the contest fields a contest needs', async () => {
    makeEvent({ ...WINDOWS.active, type: 'contest', rulesText: 'One entry per author.' });

    const [event] = (await activeList()).body.data;

    expect(event.rulesText).toBe('One entry per author.');
    expect(event.winnerWorldId).toBeNull();
  });
});

describe('GET /api/events', () => {
  it('shows a visitor what has started, ended ones included', async () => {
    const running = makeEvent(WINDOWS.active);
    const over = makeEvent({ ...WINDOWS.ended, title: 'Last month' });
    makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });

    expect(idsOf(await list()).sort()).toEqual([running.id, over.id].sort());
  });

  it('hides what is still scheduled and what was called off from an ordinary account', async () => {
    makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    const cancelled = makeEvent(WINDOWS.active);
    Event.cancel(cancelled.id);

    expect(idsOf(await list(createUser({ username: 'player' })))).toEqual([]);
  });

  it('shows both to staff, who are the ones who scheduled them', async () => {
    const scheduled = makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    const cancelled = makeEvent(WINDOWS.active);
    Event.cancel(cancelled.id);

    const response = await list(createUser({ username: 'mod', accountType: 'mod' }));

    expect(idsOf(response).sort()).toEqual([scheduled.id, cancelled.id].sort());
    expect(response.body.data.find((event) => event.id === cancelled.id).state).toBe('cancelled');
  });
});

describe('GET /api/events?slim', () => {
  it('leaves the prose out of every row, and leaves the rest alone', async () => {
    const event = makeEvent({ ...WINDOWS.active, type: 'contest', rulesText: 'One entry per author.' });

    const [row] = (await slimList()).body.data;

    expect('body' in row).toBe(false);
    expect('rulesText' in row).toBe(false);
    expect(row.id).toBe(event.id);
    expect(row.title).toBe('Sedge Landing Week');
    expect(row.bannerText).toBe('A week of building on Sedge Landing.');
    expect(row.startsAt).toBe(event.starts_at);
  });

  it('keeps a decided contest’s winner aboard, so a badge earned years ago still rides the list', async () => {
    const contest = makeEvent({ ...WINDOWS.ended, type: 'contest', title: 'Build-off' });
    const author = createUser({ username: 'wren' });
    const published = await request(app).post('/api/worlds')
      .set(authHeader(author))
      .send(worldPayload({ name: 'Sedge Landing' }));
    Event.setWinner(contest.id, { worldId: published.body.data.id, name: 'Sedge Landing', authorName: 'wren' });

    const [row] = (await slimList()).body.data;

    expect(row.winnerWorldId).toBe(published.body.data.id);
    expect(row.winnerName).toBe('Sedge Landing');
    expect(row.winnerAuthorName).toBe('wren');
  });

  it('is ignored when it is not asked for, so an older client still gets the prose', async () => {
    makeEvent({ ...WINDOWS.active, type: 'contest', rulesText: 'One entry per author.' });

    const [row] = (await list()).body.data;

    expect(row.body).toBe('Build something on Sedge Landing before the week is out.');
    expect(row.rulesText).toBe('One entry per author.');
  });

  it('shows the same rows the full list would, staff visibility included', async () => {
    const running = makeEvent(WINDOWS.active);
    makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    const staff = createUser({ username: 'mod', accountType: 'mod' });

    expect(idsOf(await slimList())).toEqual([running.id]);
    expect(idsOf(await slimList(staff)).length).toBe(2);
  });
});

describe('GET /api/events/:id', () => {
  it('answers a signed-out visitor with the full prose of a started event', async () => {
    const event = makeEvent({ ...WINDOWS.active, type: 'contest', rulesText: 'One entry per author.' });

    const response = await detail(event.id);

    expect(response.status).toBe(200);
    expect(response.body.data.body).toBe('Build something on Sedge Landing before the week is out.');
    expect(response.body.data.rulesText).toBe('One entry per author.');
  });

  it('answers for one that has ended, which is what an archive is read from', async () => {
    const event = makeEvent({ ...WINDOWS.ended, title: 'Last month' });

    expect((await detail(event.id)).status).toBe(200);
  });

  it('hides a scheduled or cancelled event from an ordinary account, as the list does', async () => {
    const scheduled = makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    const cancelled = makeEvent(WINDOWS.active);
    Event.cancel(cancelled.id);
    const player = createUser({ username: 'player' });

    expect((await detail(scheduled.id, player)).status).toBe(404);
    expect((await detail(cancelled.id, player)).status).toBe(404);
  });

  it('shows both to staff', async () => {
    const scheduled = makeEvent({ ...WINDOWS.scheduled, title: 'Next month' });
    const staff = createUser({ username: 'mod', accountType: 'mod' });

    expect((await detail(scheduled.id, staff)).status).toBe(200);
  });

  it('is a 404 for an id nobody ever had', async () => {
    expect((await detail('no-such-event')).status).toBe(404);
  });

  it('is not read as an event named active', async () => {
    makeEvent(WINDOWS.active);

    expect((await detail('active')).status).toBe(200);
    expect(Array.isArray((await detail('active')).body.data)).toBe(true);
  });
});


describe('an event starting', () => {
  it('pins a notice every reader gets, and cannot clear', async () => {
    const staff = createUser({ username: 'host', accountType: 'admin' });
    const player = reader();
    makeEvent({ ...WINDOWS.active, createdBy: staff.id });

    await activeList();
    const [message] = await inbox(player);

    expect(message.subject).toBe('Sedge Landing Week');
    expect(message.body).toContain('A week of building on Sedge Landing.');
    expect(message.scope).toBe('pinned');
    expect(message.senderAs).toBe('team');

    const dismissed = await request(app).delete(`/api/messages/${message.id}`).set(authHeader(player));
    expect(dismissed.status).toBe(403);
  });

  it('posts once however often the sweeper runs', async () => {
    const player = reader();
    makeEvent(WINDOWS.active);

    await activeList();
    await activeList();
    await list();

    expect(await inbox(player)).toHaveLength(1);
  });

  it('announces nothing that has not started', async () => {
    const player = reader();
    makeEvent(WINDOWS.scheduled);

    await activeList();

    expect(await inbox(player)).toHaveLength(0);
  });

  it('announces nothing for an event called off before it began', async () => {
    const player = reader();
    const event = makeEvent(WINDOWS.scheduled);
    cancelEvent(Event.findById(event.id));

    await activeList();

    expect(await inbox(player)).toHaveLength(0);
  });
});

describe('an event ending', () => {
  it('takes the pin down', async () => {
    const player = reader();
    const event = makeEvent(WINDOWS.active);
    await activeList();
    const pinned = Event.findById(event.id).start_message_id;

    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
    await activeList();

    expect(messageRow(pinned).recalled_at).toBeTruthy();
    expect(await inbox(player)).toHaveLength(0);
  });

  it('tells a contest\'s readers that judging has begun', async () => {
    const player = reader();
    const event = makeEvent({ ...WINDOWS.active, type: 'contest', title: 'Build-off' });
    await activeList();

    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
    await activeList();

    const messages = await inbox(player);
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('Build-off has closed');
    expect(messages[0].scope).toBe('new');
    expect(Event.findById(event.id).end_message_id).toBe(messages[0].id);
  });

  it('leaves an announcement with nothing further to say', async () => {
    const player = reader();
    const event = makeEvent(WINDOWS.active);
    await activeList();

    db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(at(-1), event.id);
    await activeList();

    expect(await inbox(player)).toHaveLength(0);
    expect(Event.findById(event.id).end_message_id).toBeNull();
  });

  it('opens and closes an event whose whole window passed while the server was down', async () => {
    const player = reader();
    const event = makeEvent({ ...WINDOWS.ended, type: 'contest', title: 'Build-off' });

    await activeList();

    const row = Event.findById(event.id);
    expect(messageRow(row.start_message_id).recalled_at).toBeTruthy();
    expect((await inbox(player)).map((m) => m.subject)).toEqual(['Build-off has closed']);
  });

  it('says it once however often the sweeper runs', async () => {
    const player = reader();
    makeEvent({ ...WINDOWS.ended, type: 'contest', title: 'Build-off' });

    await activeList();
    await activeList();
    await list();

    expect(await inbox(player)).toHaveLength(1);
  });
});

describe('an event cancelled after it started', () => {
  it('takes the pin down and says so', async () => {
    const player = reader();
    const event = makeEvent({ ...WINDOWS.active, title: 'Build-off', type: 'contest' });
    await activeList();
    const pinned = Event.findById(event.id).start_message_id;

    cancelEvent(Event.findById(event.id));

    expect(messageRow(pinned).recalled_at).toBeTruthy();
    expect((await inbox(player)).map((m) => m.subject)).toEqual(['Build-off has been cancelled']);
  });

  it('says it once, however many times it is called off', async () => {
    const player = reader();
    const event = makeEvent(WINDOWS.active);
    await activeList();

    cancelEvent(Event.findById(event.id));
    cancelEvent(Event.findById(event.id));

    expect(await inbox(player)).toHaveLength(1);
  });

  it('tells them even when it had already closed', async () => {
    // A contest cancelled during judging: the readers who were told judging had begun are the ones who
    // most need to hear it was called off.
    const player = reader();
    const event = makeEvent({ ...WINDOWS.ended, type: 'contest', title: 'Build-off' });
    await activeList();

    cancelEvent(Event.findById(event.id));

    expect((await inbox(player)).map((m) => m.subject)).toContain('Build-off has been cancelled');
  });

  it('is not swept back open afterwards', async () => {
    const player = reader();
    const event = makeEvent(WINDOWS.active);
    await activeList();
    cancelEvent(Event.findById(event.id));

    await activeList();

    expect(idsOf(await activeList())).toEqual([]);
    expect((await inbox(player)).map((m) => m.subject)).toEqual(['Sedge Landing Week has been cancelled']);
  });
});
