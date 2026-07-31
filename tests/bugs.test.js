import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * `/api/bugs` — user-filed reports with a comment thread on each.
 *
 * This is the one channel that runs user→admin. Messages are deliberately one-way, so the reply here is
 * scoped to a thread on a report somebody opened rather than an inbox anyone can write into.
 */

const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });
const reporter = (username = 'finder') => createUser({ username });

const REPORT = { title: 'Save button does nothing', category: 'crash', body: 'Pressing save just spins.' };

const file = (user, over = {}) =>
  request(app).post('/api/bugs').set(authHeader(user)).send({ ...REPORT, ...over });

const read = (user, id) => request(app).get(`/api/bugs/${id}`).set(authHeader(user));

const comment = (user, id, body = 'Which version?') =>
  request(app).post(`/api/bugs/${id}/comments`).set(authHeader(user)).send({ body });

const edit = (user, id, commentId, body) =>
  request(app).put(`/api/bugs/${id}/comments/${commentId}`).set(authHeader(user)).send({ body });

const removeComment = (user, id, commentId) =>
  request(app).delete(`/api/bugs/${id}/comments/${commentId}`).set(authHeader(user));

const unread = (user) => request(app).get('/api/bugs/unread-count').set(authHeader(user));

/** File one report and hand back the reporter, an admin, and the report's ID. */
const seedReport = async () => {
  const root = admin();
  const user = reporter();
  const res = await file(user);
  return { root, user, id: res.body.data.id };
};

describe('filing a report', () => {
  it('stores it against the reporter, open', async () => {
    const user = reporter();

    const res = await file(user);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Save button does nothing',
      category: 'crash',
      status: 'open',
      reporter: { id: user.id, username: 'finder' }
    });
  });

  it('requires a signed-in account', async () => {
    const res = await request(app).post('/api/bugs').send(REPORT);
    expect(res.status).toBe(401);
  });

  it('rejects a title or description that is only whitespace', async () => {
    const user = reporter();

    expect((await file(user, { title: '   ' })).status).toBe(400);
    expect((await file(user, { body: '  \n ' })).status).toBe(400);
  });

  it('rejects a category the server does not know', async () => {
    // The dropdown is fixed, so anything else is a hand-rolled request.
    const res = await file(reporter(), { category: 'gameplay' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });

  it('rejects text past the caps', async () => {
    const user = reporter();

    expect((await file(user, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await file(user, { body: 'x'.repeat(4001) })).status).toBe(400);
  });

  it('keeps the diagnostics the client reported', async () => {
    const res = await file(reporter(), { diagnostics: { version: '2.8.0', platform: 'desktop' } });

    expect(res.body.data.diagnostics).toEqual({ version: '2.8.0', platform: 'desktop' });
  });

  it('stores no diagnostics rather than trusting a non-object', async () => {
    // The field is never read by the server, only displayed — but it must still be a shape the UI can render.
    const res = await file(reporter(), { diagnostics: 'everything is broken' });

    expect(res.body.data.diagnostics).toEqual({});
  });

  it('refuses diagnostics being used as free storage', async () => {
    const res = await file(reporter(), { diagnostics: { blob: 'x'.repeat(3000) } });

    expect(res.status).toBe(400);
  });
});

describe('listing reports', () => {
  it('shows a reporter only their own', async () => {
    const mine = reporter('mine');
    const theirs = reporter('theirs');
    await file(mine, { title: 'Mine' });
    await file(theirs, { title: 'Theirs' });

    const res = await request(app).get('/api/bugs').set(authHeader(mine));

    expect(res.body.data.map((r) => r.title)).toEqual(['Mine']);
  });

  it('shows anyone everyone’s when they ask for it', async () => {
    // The queue is public: checking whether a bug is already filed beats filing it a second time.
    const mine = reporter('mine');
    await file(mine, { title: 'Mine' });
    await file(reporter('theirs'), { title: 'Theirs' });

    const res = await request(app).get('/api/bugs?scope=all').set(authHeader(mine));

    expect(res.body.data.map((r) => r.title).sort()).toEqual(['Mine', 'Theirs']);
  });

  it('still defaults to the caller’s own', async () => {
    // The profile tab opens on this, so an unasked-for list must not be everyone's.
    const mine = reporter('mine');
    await file(mine, { title: 'Mine' });
    await file(reporter('theirs'), { title: 'Theirs' });

    const res = await request(app).get('/api/bugs').set(authHeader(mine));

    expect(res.body.data.map((r) => r.title)).toEqual(['Mine']);
  });

  it('shows an admin everyone’s when they ask for it', async () => {
    const root = admin();
    await file(reporter('a'), { title: 'First' });
    await file(reporter('b'), { title: 'Second' });

    const res = await request(app).get('/api/bugs?scope=all').set(authHeader(root));

    expect(res.body.total).toBe(2);
  });

  it('shows an admin only their own by default', async () => {
    // The queue is an explicit ask, so an admin's own list is not silently everyone's.
    const root = admin();
    await file(reporter('a'), { title: 'Someone else' });

    const res = await request(app).get('/api/bugs').set(authHeader(root));

    expect(res.body.data).toEqual([]);
  });

  it('filters by status', async () => {
    const root = admin();
    const first = (await file(reporter('a'), { title: 'Fixed' })).body.data.id;
    await file(reporter('b'), { title: 'Still broken' });
    await request(app).put(`/api/bugs/${first}/status`).set(authHeader(root)).send({ status: 'resolved' });

    const res = await request(app).get('/api/bugs?scope=all&status=resolved').set(authHeader(root));

    expect(res.body.data.map((r) => r.title)).toEqual(['Fixed']);
  });

  it('ignores a status filter it does not know', async () => {
    const root = admin();
    await file(reporter('a'));

    const res = await request(app).get('/api/bugs?scope=all&status=nonsense').set(authHeader(root));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('reading a report', () => {
  it('lets the reporter read their own, with its thread', async () => {
    const { root, user, id } = await seedReport();
    await comment(root, id, 'Looking into it.');

    const res = await read(user, id);

    expect(res.status).toBe(200);
    expect(res.body.comments.map((c) => c.body)).toEqual(['Looking into it.']);
  });

  it('lets an admin read anyone’s', async () => {
    const { root, id } = await seedReport();

    expect((await read(root, id)).status).toBe(200);
  });

  it('lets any signed-in reader open somebody else’s', async () => {
    const { id } = await seedReport();

    const res = await read(reporter('curious'), id);

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Save button does nothing');
  });

  it('refuses a signed-out reader', async () => {
    // Public among accounts, not on the open web.
    const { id } = await seedReport();

    expect((await request(app).get(`/api/bugs/${id}`)).status).toBe(401);
  });

  it('records no read-marker for a passing reader', async () => {
    // They have no unread state to clear; writing one would leave a row per report per curious account.
    const { id } = await seedReport();
    const onlooker = reporter('curious');

    await read(onlooker, id);

    const seen = db.prepare('SELECT COUNT(*) AS n FROM bug_report_reads WHERE user_id = ?').get(onlooker.id);
    expect(seen.n).toBe(0);
  });

  it('404s an unknown report', async () => {
    const res = await read(admin(), 'no-such-report');
    expect(res.status).toBe(404);
  });

  it('marks who wrote each comment as team or reporter', async () => {
    const { root, user, id } = await seedReport();
    await comment(root, id, 'From the team.');
    await comment(user, id, 'From me.');

    const res = await read(user, id);

    expect(res.body.comments.map((c) => c.author.isAdmin)).toEqual([true, false]);
  });
});

describe('commenting', () => {
  it('lets the reporter and an admin both write', async () => {
    const { root, user, id } = await seedReport();

    expect((await comment(root, id, 'Which version?')).status).toBe(201);
    expect((await comment(user, id, '2.8.0.')).status).toBe(201);
  });

  it('refuses everyone but the two sides of it', async () => {
    // Readable by anyone, writable by the reporter and the team — so this is a plain refusal, not a 404:
    // the report is not a secret, the conversation is just not open to the room.
    const { id } = await seedReport();

    const res = await comment(reporter('nosy'), id, 'Me too!');

    expect(res.status).toBe(403);
  });

  it('adds nothing to the thread when it refuses', async () => {
    const { root, id } = await seedReport();
    await comment(reporter('nosy'), id, 'Me too!');

    expect((await read(root, id)).body.comments).toHaveLength(0);
  });

  it('rejects an empty comment', async () => {
    const { root, id } = await seedReport();

    expect((await comment(root, id, '   ')).status).toBe(400);
  });

  it('rejects a comment past the cap', async () => {
    const { root, id } = await seedReport();

    expect((await comment(root, id, 'x'.repeat(4001))).status).toBe(400);
  });

  it('moves the report to the top of the queue', async () => {
    // An admin's queue sorts by real activity, so a thread with a new reply must not stay buried.
    const { root, id } = await seedReport();
    const before = (await read(root, id)).body.data.updatedAt;

    await comment(root, id, 'Bumping.');

    expect((await read(root, id)).body.data.updatedAt >= before).toBe(true);
  });
});

describe('editing a comment', () => {
  it('rewrites it and marks it edited', async () => {
    const { root, id } = await seedReport();
    const posted = (await comment(root, id, 'Wich version?')).body.data;
    expect(posted.editedAt).toBeNull();

    const res = await edit(root, id, posted.id, 'Which version?');

    expect(res.status).toBe(200);
    expect(res.body.data.body).toBe('Which version?');
    expect(res.body.data.editedAt).toBeTruthy();
    expect((await read(root, id)).body.comments[0]).toMatchObject({ body: 'Which version?' });
  });

  it('refuses somebody else in the thread — including an admin', async () => {
    // Triage powers run to the report's status, not to rewriting what the reporter said.
    const { root, user, id } = await seedReport();
    const theirs = (await comment(user, id, 'Still broken.')).body.data;

    const res = await edit(root, id, theirs.id, 'Works fine, actually.');

    expect(res.status).toBe(403);
    expect((await read(user, id)).body.comments[0].body).toBe('Still broken.');
  });

  it('refuses a reader who only came to look', async () => {
    const { root, id } = await seedReport();
    const theirs = (await comment(root, id, 'Which version?')).body.data;

    expect((await edit(reporter('nosy'), id, theirs.id, 'Hi')).status).toBe(403);
    expect((await read(root, id)).body.comments[0].body).toBe('Which version?');
  });

  it('refuses a comment from another report', async () => {
    const { root, user, id } = await seedReport();
    const otherId = (await file(user, { title: 'A second bug' })).body.data.id;
    const elsewhere = (await comment(root, otherId, 'Different thread.')).body.data;

    expect((await edit(root, id, elsewhere.id, 'Moved')).status).toBe(404);
  });

  it('holds the new text to the same rules as a new comment', async () => {
    const { root, id } = await seedReport();
    const posted = (await comment(root, id, 'Which version?')).body.data;

    expect((await edit(root, id, posted.id, '   ')).status).toBe(400);
    expect((await edit(root, id, posted.id, 'x'.repeat(4001))).status).toBe(400);
  });
});

describe('deleting a comment', () => {
  it('removes it from the thread', async () => {
    const { root, id } = await seedReport();
    const posted = (await comment(root, id, 'Never mind.')).body.data;

    const res = await removeComment(root, id, posted.id);

    expect(res.status).toBe(200);
    expect((await read(root, id)).body.comments).toHaveLength(0);
  });

  it('leaves the rest of the thread alone', async () => {
    const { root, user, id } = await seedReport();
    const first = (await comment(root, id, 'Which version?')).body.data;
    await comment(user, id, '2.8.0.');

    await removeComment(root, id, first.id);

    expect((await read(root, id)).body.comments.map((c) => c.body)).toEqual(['2.8.0.']);
  });

  it('refuses somebody else in the thread', async () => {
    const { root, user, id } = await seedReport();
    const theirs = (await comment(user, id, 'Still broken.')).body.data;

    expect((await removeComment(root, id, theirs.id)).status).toBe(403);
    expect((await read(user, id)).body.comments).toHaveLength(1);
  });

  it('refuses a reader who only came to look', async () => {
    const { root, id } = await seedReport();
    const theirs = (await comment(root, id, 'Which version?')).body.data;

    expect((await removeComment(reporter('nosy'), id, theirs.id)).status).toBe(403);
    expect((await read(root, id)).body.comments).toHaveLength(1);
  });

  it('is gone for good, not resurrected by a second delete', async () => {
    const { root, id } = await seedReport();
    const posted = (await comment(root, id, 'Never mind.')).body.data;

    await removeComment(root, id, posted.id);

    expect((await removeComment(root, id, posted.id)).status).toBe(404);
  });
});

describe('the unread badge', () => {
  it('counts a thread an admin has written in', async () => {
    const { root, user, id } = await seedReport();

    expect((await unread(user)).body.unread).toBe(0);
    await comment(root, id, 'Any repro steps?');

    expect((await unread(user)).body.unread).toBe(1);
  });

  it('does not count your own comment against you', async () => {
    const { user, id } = await seedReport();

    await comment(user, id, 'One more thing.');

    expect((await unread(user)).body.unread).toBe(0);
  });

  it('ignores your own comment even if the thread was never marked seen', async () => {
    // Commenting also marks the thread seen, which would hide a broken author check. Inserted straight
    // into the table so only the author filter itself can keep this at zero.
    const { user, id } = await seedReport();

    db.prepare('INSERT INTO bug_comments (id, report_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c-own', id, user.id, 'Mine alone.', new Date().toISOString());

    expect((await unread(user)).body.unread).toBe(0);
  });

  it('treats replying as having read what was already there', async () => {
    // The reporter's comment badges the admin; answering it without opening the thread first must clear
    // that, or the queue keeps flagging a thread they have demonstrably dealt with.
    const { root, user, id } = await seedReport();
    await comment(user, id, 'Still happening.');
    expect((await unread(root)).body.unread).toBe(1);

    await comment(root, id, 'Thanks, looking now.');

    expect((await unread(root)).body.unread).toBe(0);
  });

  it('clears once the thread is read', async () => {
    const { root, user, id } = await seedReport();
    await comment(root, id, 'Any repro steps?');

    await read(user, id);

    expect((await unread(user)).body.unread).toBe(0);
  });

  it('counts again when something new arrives after that', async () => {
    const { root, user, id } = await seedReport();
    await comment(root, id, 'First.');
    await read(user, id);

    await comment(root, id, 'Second.');

    expect((await unread(user)).body.unread).toBe(1);
  });

  it('counts a thread once however many replies it holds', async () => {
    // The badge means "threads with something new", not "unread comments".
    const { root, user, id } = await seedReport();

    await comment(root, id, 'One.');
    await comment(root, id, 'Two.');

    expect((await unread(user)).body.unread).toBe(1);
  });

  it('tells an admin about a reply on somebody else’s report', async () => {
    const { root, user, id } = await seedReport();

    await comment(user, id, 'Still happening.');

    expect((await unread(root)).body.unread).toBe(1);
  });

  it('does not count another user’s thread against a reporter', async () => {
    const { root, id } = await seedReport();
    const bystander = reporter('bystander');
    await comment(root, id, 'Looking into it.');

    expect((await unread(bystander)).body.unread).toBe(0);
  });
});

describe('thread order', () => {
  it('keeps comments in the order they were written when they share a timestamp', async () => {
    // `created_at` is millisecond-resolution, so a fast exchange ties. The primary key is a random UUID,
    // so breaking the tie on it would shuffle the conversation.
    const { root, user, id } = await seedReport();
    const sameMoment = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO bug_comments (id, report_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    // IDs deliberately sort opposite to insertion order.
    insert.run('zzz', id, user.id, 'First.', sameMoment);
    insert.run('aaa', id, root.id, 'Second.', sameMoment);

    const res = await read(root, id);

    expect(res.body.comments.map((c) => c.body)).toEqual(['First.', 'Second.']);
  });
});

describe('paging a tied list', () => {
  it('covers every report exactly once when timestamps tie', async () => {
    // Same trap as the thread: a random-UUID tiebreak would let a report repeat on one page and vanish
    // from another, so an admin's queue would silently lose reports.
    const root = admin();
    const user = reporter('bulk');
    const sameMoment = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO bug_reports (id, reporter_id, title, category, body, status, diagnostics, created_at, updated_at)
      VALUES (?, ?, ?, 'other', 'x', 'open', '{}', ?, ?)
    `);
    for (let i = 0; i < 12; i += 1) {
      insert.run(`r-${String(i).padStart(2, '0')}`, user.id, `Report ${i}`, sameMoment, sameMoment);
    }

    const seen = [];
    for (const page of [1, 2]) {
      const res = await request(app).get(`/api/bugs?scope=all&page=${page}&limit=6`).set(authHeader(root));
      seen.push(...res.body.data.map((r) => r.title));
    }

    expect(new Set(seen).size).toBe(12);
  });
});

describe('triage', () => {
  it('moves a report between statuses', async () => {
    const { root, id } = await seedReport();

    const res = await request(app).put(`/api/bugs/${id}/status`).set(authHeader(root)).send({ status: 'confirmed' });

    expect(res.body.data.status).toBe('confirmed');
  });

  it('reopens a closed one', async () => {
    const { root, id } = await seedReport();
    await request(app).put(`/api/bugs/${id}/status`).set(authHeader(root)).send({ status: 'resolved' });

    const res = await request(app).put(`/api/bugs/${id}/status`).set(authHeader(root)).send({ status: 'open' });

    expect(res.body.data.status).toBe('open');
  });

  it('rejects a status it does not know', async () => {
    const { root, id } = await seedReport();

    const res = await request(app).put(`/api/bugs/${id}/status`).set(authHeader(root)).send({ status: 'maybe' });

    expect(res.status).toBe(400);
  });

  it('refuses a non-admin, including the reporter', async () => {
    // Otherwise a reporter could mark their own report resolved, or reopen one that was closed.
    const { user, id } = await seedReport();

    const res = await request(app).put(`/api/bugs/${id}/status`).set(authHeader(user)).send({ status: 'resolved' });

    expect(res.status).toBe(403);
  });
});

describe('deleting a report', () => {
  it('takes its thread with it', async () => {
    const { root, id } = await seedReport();
    await comment(root, id, 'Spam.');

    await request(app).delete(`/api/bugs/${id}`).set(authHeader(root));

    expect(db.prepare('SELECT COUNT(*) AS c FROM bug_comments WHERE report_id = ?').get(id).c).toBe(0);
    expect((await read(root, id)).status).toBe(404);
  });

  it('refuses a non-admin, including the reporter', async () => {
    const { user, id } = await seedReport();

    const res = await request(app).delete(`/api/bugs/${id}`).set(authHeader(user));

    expect(res.status).toBe(403);
  });

  it('404s an unknown report', async () => {
    const res = await request(app).delete('/api/bugs/no-such-report').set(authHeader(admin()));
    expect(res.status).toBe(404);
  });
});

describe('deleting the reporter', () => {
  it('takes their reports with them', async () => {
    // The account row is gone, so a report pointing at it would have nobody to attribute or reply to.
    const { user, id } = await seedReport();

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    expect(db.prepare('SELECT COUNT(*) AS c FROM bug_reports WHERE id = ?').get(id).c).toBe(0);
  });
});

describe('meta', () => {
  it('reports the categories, statuses and caps the client must agree with', async () => {
    const res = await request(app).get('/api/bugs/meta').set(authHeader(reporter()));

    expect(res.body.categories).toEqual(['crash', 'ai', 'editor', 'community', 'visuals', 'other']);
    expect(res.body.statuses).toEqual(['open', 'need_info', 'confirmed', 'resolved', 'wontfix']);
    expect(res.body).toMatchObject({ titleMax: 120, bodyMax: 4000 });
  });

  it('is not a literal path a report ID can shadow', async () => {
    // `/meta` and `/unread-count` are declared before `/:id`; if that ordering broke they would 404.
    const res = await request(app).get('/api/bugs/unread-count').set(authHeader(reporter()));

    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(0);
  });
});
