import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Content Reports — the room telling staff about something, and staff closing the loop.
 *
 * A Report is one-shot. Filed once per target while one is open, resolved once per *target* rather than
 * once per report, and never replied to. Everything below is that lifecycle: the duplicate guard, the
 * fan-out, who may close what, and the flag on a target its own author took away — plus the one property
 * the whole design rests on, that nothing here is ever visible to the person who was reported.
 */

const named = (prefix, over = {}) =>
  createUser({ username: `${prefix}-${Math.random().toString(16).slice(2, 8)}`, ...over });

const publish = (user, over = {}) => request(app)
  .post('/api/worlds')
  .set(authHeader(user))
  .send(worldPayload(over));

const file = (user, body) => {
  const req = request(app).post('/api/reports');
  if (user) req.set(authHeader(user));
  return req.send(body);
};

const queue = (user) => {
  const req = request(app).get('/api/reports');
  if (user) req.set(authHeader(user));
  return req.send();
};

const resolve = (user, body) => {
  const req = request(app).post('/api/reports/resolve');
  if (user) req.set(authHeader(user));
  return req.send(body);
};

const openCount = (user) => request(app).get('/api/reports/open-count').set(authHeader(user)).send();

const inbox = (user) => request(app).get('/api/messages').set(authHeader(user)).send();

/** A listing by somebody else, ready to be reported. */
const seedListing = async (over = {}) => {
  const author = named('author');
  const id = (await publish(author, { name: 'Sedge Landing', ...over })).body.data.id;

  return { author, id };
};

/** A comment on somebody else's listing. */
const seedComment = async (content = 'Buy cheap boots at example.invalid') => {
  const { author, id: worldId } = await seedListing();
  const commenter = named('commenter');
  const posted = await request(app)
    .post(`/api/worlds/${worldId}/comments`)
    .set(authHeader(commenter))
    .send({ content });

  return { author, worldId, commenter, commentId: posted.body.data.id };
};

const listingReport = (over = {}) => ({ targetKind: 'listing', category: 'stolen', ...over });

const rowsFor = (targetId) => db
  .prepare('SELECT * FROM reports WHERE target_id = ? ORDER BY created_at ASC')
  .all(targetId);

/**
 * Seed `count` open reports on `count` distinct targets, straight into the table.
 *
 * Only the paging cases need this, and only they should have it: filing through the API is what every
 * other test does, but publishing 120 listings to see a page ceiling would time the suite out for a
 * property that is about reading, not about filing.
 *
 * @param {number} count - How many one-report groups to seed
 */
const seedOpenReports = (count) => {
  const insert = db.prepare(`
    INSERT INTO reports (id, reporter_id, target_kind, target_id, target_name, category, status, created_at)
    VALUES (?, NULL, 'listing', ?, ?, 'spam', 'open', ?)
  `);

  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const padded = String(index).padStart(4, '0');
      // Distinct, increasing timestamps so the queue's ordering is deterministic across the page edge.
      insert.run(`seed-${padded}`, `target-${padded}`, `Seeded ${padded}`, `2026-08-01T00:00:${padded.slice(-2)}.000Z`);
    }
  })();
};

describe('filing a report', () => {
  it('refuses a signed-out visitor', async () => {
    const { id } = await seedListing();

    const res = await file(null, listingReport({ targetId: id }));

    expect(res.status).toBe(401);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('stores the category, the details and a snapshot of the target', async () => {
    const { author, id } = await seedListing({ description: 'Lifted wholesale from someone else' });
    const reporter = named('reporter');

    const res = await file(reporter, listingReport({ targetId: id, details: 'This is my world.' }));

    expect(res.status).toBe(201);

    const [row] = rowsFor(id);
    expect(row.category).toBe('stolen');
    expect(row.details).toBe('This is my world.');
    expect(row.status).toBe('open');
    // The snapshot is the whole reason a ticket outlives its target.
    expect(row.target_name).toBe('Sedge Landing');
    expect(row.target_author_id).toBe(author.id);
    expect(row.target_author_username).toBe(author.username);
    expect(row.target_snippet).toContain('Lifted wholesale');
  });

  it('takes a report on a comment, keeping the offending text and where it sat', async () => {
    const { worldId, commentId } = await seedComment('Buy cheap boots at example.invalid');
    const reporter = named('reporter');

    const res = await file(reporter, { targetKind: 'comment', targetId: commentId, category: 'spam' });

    expect(res.status).toBe(201);

    const [row] = rowsFor(commentId);
    expect(row.target_snippet).toContain('cheap boots');
    // Without the listing it sat on, the queue holds a comment id and no way to reach it.
    expect(row.target_parent_id).toBe(worldId);
  });

  it('takes a report on a profile', async () => {
    const offender = named('offender');
    const reporter = named('reporter');

    const res = await file(reporter, { targetKind: 'profile', targetId: offender.id, category: 'hate' });

    expect(res.status).toBe(201);
    expect(rowsFor(offender.id)[0].target_name).toBe(offender.username);
  });

  it('refuses a category it does not know', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');

    const res = await file(reporter, listingReport({ targetId: id, category: 'vibes' }));

    expect(res.status).toBe(400);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('refuses a target kind it does not know', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');

    const res = await file(reporter, listingReport({ targetId: id, targetKind: 'changelog' }));

    expect(res.status).toBe(400);
  });

  it('refuses a target that does not exist', async () => {
    const reporter = named('reporter');

    const res = await file(reporter, listingReport({ targetId: 'no-such-listing' }));

    expect(res.status).toBe(404);
  });

  it('refuses details past the cap', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');

    const res = await file(reporter, listingReport({ targetId: id, details: 'x'.repeat(2001) }));

    expect(res.status).toBe(400);
    expect(rowsFor(id)).toHaveLength(0);
  });

  it('refuses a report on your own content', async () => {
    const { author, id } = await seedListing();

    const res = await file(author, listingReport({ targetId: id }));

    expect(res.status).toBe(400);
    expect(rowsFor(id)).toHaveLength(0);
  });
});

describe('the duplicate guard', () => {
  it('tells a reporter their open report is already with staff', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');

    expect((await file(reporter, listingReport({ targetId: id }))).status).toBe(201);

    const again = await file(reporter, listingReport({ targetId: id, category: 'spam' }));

    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already reported/i);
    // The second filing left nothing behind — not a row, and not a changed category on the first.
    expect(rowsFor(id)).toHaveLength(1);
    expect(rowsFor(id)[0].category).toBe('stolen');
  });

  it('lets a second person report the same target', async () => {
    const { id } = await seedListing();

    await file(named('one'), listingReport({ targetId: id }));
    const second = await file(named('two'), listingReport({ targetId: id, category: 'spam' }));

    expect(second.status).toBe(201);
    expect(rowsFor(id)).toHaveLength(2);
  });

  it('lets the same person report again once their first was resolved', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');
    const mod = named('mod', { accountType: 'mod' });

    await file(reporter, listingReport({ targetId: id }));
    await resolve(mod, { targetKind: 'listing', targetId: id, outcome: 'dismissed' });

    // A fresh violation after an update is a new report, not a duplicate of a closed one.
    const again = await file(reporter, listingReport({ targetId: id, category: 'malicious' }));

    expect(again.status).toBe(201);
    expect(rowsFor(id)).toHaveLength(2);
  });

  it('holds at the database, not only in the check above it', async () => {
    // The check and the index are the same rule; the index is what survives two requests racing it.
    const { id } = await seedListing();
    const reporter = named('reporter');

    await file(reporter, listingReport({ targetId: id }));

    expect(() => db.prepare(`
      INSERT INTO reports (id, reporter_id, target_kind, target_id, category, status, created_at)
      VALUES ('forced', ?, 'listing', ?, 'spam', 'open', ?)
    `).run(reporter.id, id, new Date().toISOString())).toThrow(/UNIQUE/i);
  });
});

describe('the queue', () => {
  it('is closed to an ordinary account', async () => {
    const { id } = await seedListing();
    await file(named('reporter'), listingReport({ targetId: id }));

    expect((await queue(named('nobody'))).status).toBe(403);
    expect((await queue(null)).status).toBe(401);
  });

  it('groups a pile-on into one item of work, with every category on it', async () => {
    const { id } = await seedListing();
    await file(named('one'), listingReport({ targetId: id, category: 'stolen' }));
    await file(named('two'), listingReport({ targetId: id, category: 'spam' }));
    await file(named('three'), listingReport({ targetId: id, category: 'hate' }));

    const res = await queue(named('mod', { accountType: 'mod' }));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const [group] = res.body.data;
    expect(group.report_count).toBe(3);
    expect(group.target_id).toBe(id);
    expect(group.target_name).toBe('Sedge Landing');
    expect(group.reports.map((r) => r.category).sort()).toEqual(['hate', 'spam', 'stolen']);
  });

  it('shows a report on staff-authored content to a mod who cannot close it', async () => {
    // A complaint about the team that only the team it is about can see is not a complaint anyone reads.
    const dev = named('dev', { accountType: 'dev' });
    const id = (await publish(dev, { name: 'Staff Listing' })).body.data.id;
    await file(named('reporter'), listingReport({ targetId: id }));

    const res = await queue(named('mod', { accountType: 'mod' }));

    expect(res.status).toBe(200);
    const group = res.body.data.find((row) => row.target_id === id);
    expect(group).toBeTruthy();
    // The role is read live rather than snapshotted, so the queue's button offer and the resolution
    // route's refusal cannot disagree about who this author is now.
    expect(group.target_author_role).toBe('dev');
  });

  it('counts targets rather than reports, so a pile-on badges as one', async () => {
    const first = await seedListing({ name: 'One' });
    const second = await seedListing({ name: 'Two' });

    await file(named('a'), listingReport({ targetId: first.id }));
    await file(named('b'), listingReport({ targetId: first.id }));
    await file(named('c'), listingReport({ targetId: second.id }));

    const res = await openCount(named('mod', { accountType: 'mod' }));

    expect(res.status).toBe(200);
    expect(res.body.open).toBe(2);
  });

  it('holds its cap against a limit SQLite would read as no limit', async () => {
    // A negative LIMIT means *unlimited* in SQLite, so a bare `Math.min(asked, 200)` hands the whole
    // queue — and a per-group query each — to anyone who asks for `?limit=-1`. Seeded past the default
    // on purpose: below it, an unlimited read and a capped one return the same rows and prove nothing.
    const mod = named('mod', { accountType: 'mod' });
    seedOpenReports(120);

    const negative = await request(app).get('/api/reports?limit=-1').set(authHeader(mod)).send();

    expect(negative.status).toBe(200);
    // Falls back to the default rather than obeying a number that means "everything".
    expect(negative.body.data.length).toBe(100);

    // And a real number is still honored, in both directions.
    expect((await request(app).get('/api/reports?limit=5').set(authHeader(mod)).send()).body.data.length)
      .toBe(5);
    expect((await request(app).get('/api/reports?limit=999').set(authHeader(mod)).send()).body.data.length)
      .toBe(120);
  });

  it('drops a resolved group out of the count', async () => {
    const { id } = await seedListing();
    const mod = named('mod', { accountType: 'mod' });
    await file(named('reporter'), listingReport({ targetId: id }));

    await resolve(mod, { targetKind: 'listing', targetId: id, outcome: 'actioned' });

    expect((await openCount(mod)).body.open).toBe(0);
    expect((await queue(mod)).body.data).toHaveLength(0);
  });
});

describe('resolving a target', () => {
  it('closes every open report on it and tells each reporter', async () => {
    const { id } = await seedListing();
    const mod = named('mod', { accountType: 'mod' });
    const one = named('one');
    const two = named('two');

    await file(one, listingReport({ targetId: id }));
    await file(two, listingReport({ targetId: id, category: 'spam' }));

    const res = await resolve(mod, { targetKind: 'listing', targetId: id, outcome: 'actioned' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ resolved: 2, notified: 2, outcome: 'actioned' });

    const rows = rowsFor(id);
    expect(rows.every((row) => row.status === 'resolved')).toBe(true);
    expect(rows.every((row) => row.outcome === 'actioned')).toBe(true);
    expect(rows.every((row) => row.resolved_by === mod.id)).toBe(true);

    // One message each, so a reporter's notice is theirs to read, receipt and dismiss.
    for (const reporter of [one, two]) {
      const mail = await inbox(reporter);
      expect(mail.body.data).toHaveLength(1);
      expect(mail.body.data[0].subject).toMatch(/action taken/i);
      expect(mail.body.data[0].body).toContain('Sedge Landing');
    }
  });

  it('says reviewed rather than actioned when the report is dismissed', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');
    await file(reporter, listingReport({ targetId: id }));

    await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'dismissed'
    });

    const mail = await inbox(reporter);
    expect(mail.body.data[0].subject).not.toMatch(/action taken/i);
    expect(mail.body.data[0].body).toMatch(/nothing that breaks the rules/i);
  });

  it('carries the staff note into the notice', async () => {
    const { id } = await seedListing();
    const reporter = named('reporter');
    await file(reporter, listingReport({ targetId: id }));

    await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'actioned', note: 'The author has been contacted.'
    });

    expect((await inbox(reporter)).body.data[0].body).toContain('The author has been contacted.');
  });

  it('never names the moderation act itself', async () => {
    // The reporter is owed the outcome, never the method: naming it would turn every report into a probe
    // of somebody else's moderation record.
    const { id } = await seedListing();
    const reporter = named('reporter');
    await file(reporter, listingReport({ targetId: id }));

    await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'actioned'
    });

    const text = `${(await inbox(reporter)).body.data[0].subject} ${(await inbox(reporter)).body.data[0].body}`;
    expect(text).not.toMatch(/quarantin|takedown|taken down|suspend|deleted|removed the/i);
  });

  it('refuses a mod closing a report on a fellow staff member', async () => {
    const dev = named('dev', { accountType: 'dev' });
    const id = (await publish(dev, { name: 'Staff Listing' })).body.data.id;
    await file(named('reporter'), listingReport({ targetId: id }));

    const res = await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'dismissed'
    });

    expect(res.status).toBe(403);
    expect(rowsFor(id)[0].status).toBe('open');
  });

  it('lets an admin close a report on staff-authored content', async () => {
    const dev = named('dev', { accountType: 'dev' });
    const id = (await publish(dev, { name: 'Staff Listing' })).body.data.id;
    const reporter = named('reporter');
    await file(reporter, listingReport({ targetId: id }));

    const res = await resolve(named('boss', { accountType: 'admin' }), {
      targetKind: 'listing', targetId: id, outcome: 'actioned'
    });

    expect(res.status).toBe(200);
    expect(rowsFor(id)[0].status).toBe('resolved');
    expect((await inbox(reporter)).body.data).toHaveLength(1);
  });

  it('is closed to an ordinary account', async () => {
    const { id } = await seedListing();
    await file(named('reporter'), listingReport({ targetId: id }));

    const res = await resolve(named('nobody'), {
      targetKind: 'listing', targetId: id, outcome: 'dismissed'
    });

    expect(res.status).toBe(403);
    expect(rowsFor(id)[0].status).toBe('open');
  });

  it('refuses an outcome it does not know', async () => {
    const { id } = await seedListing();
    await file(named('reporter'), listingReport({ targetId: id }));

    const res = await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'escalated'
    });

    expect(res.status).toBe(400);
    expect(rowsFor(id)[0].status).toBe('open');
  });

  it('records the decision in the audit log', async () => {
    const { author, id } = await seedListing();
    const mod = named('mod', { accountType: 'mod' });
    await file(named('reporter'), listingReport({ targetId: id }));

    await resolve(mod, { targetKind: 'listing', targetId: id, outcome: 'actioned', note: 'Rule 3.' });

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'report_actioned'").get();
    expect(entry).toBeTruthy();
    expect(entry.actor_id).toBe(mod.id);
    expect(entry.target_user_id).toBe(author.id);
    expect(entry.target_name).toBe('Sedge Landing');
    expect(entry.snippet).toBe('Rule 3.');
  });

  it('answers 404 when there is nothing open on that target', async () => {
    const { id } = await seedListing();

    const res = await resolve(named('mod', { accountType: 'mod' }), {
      targetKind: 'listing', targetId: id, outcome: 'dismissed'
    });

    expect(res.status).toBe(404);
  });
});

describe('a target its own author took away', () => {
  it('leaves the report open, flagged, with the snapshot intact', async () => {
    const { author, id } = await seedListing({ description: 'Lifted wholesale' });
    await file(named('reporter'), listingReport({ targetId: id }));

    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author)).send();

    const [row] = rowsFor(id);
    expect(row.status).toBe('open');
    expect(row.target_gone_at).toBeTruthy();
    // Self-removal neither punishes nor absolves — and the snapshot is what staff still judge from.
    expect(row.target_name).toBe('Sedge Landing');
    expect(row.target_snippet).toContain('Lifted wholesale');
  });

  it('flags a report on a comment that went down with its listing', async () => {
    // `comments.world_id` cascades, so deleting the listing takes the whole thread with it — a delete
    // that never names the comment the report is about. Without the flag that report sits in the queue
    // looking live, pointing "view in context" at a listing that is gone.
    const { author, worldId, commentId } = await seedComment('Buy cheap boots at example.invalid');
    const reporter = named('reporter');
    await file(reporter, { targetKind: 'comment', targetId: commentId, category: 'spam' });

    await request(app).delete(`/api/worlds/${worldId}`).set(authHeader(author)).send();

    expect(db.prepare('SELECT 1 AS found FROM comments WHERE id = ?').get(commentId)).toBeUndefined();

    const [row] = rowsFor(commentId);
    expect(row.status).toBe('open');
    expect(row.target_gone_at).toBeTruthy();
    expect(row.target_snippet).toContain('cheap boots');

    // And the queue says so, which is the whole point of the flag.
    const group = (await queue(named('mod', { accountType: 'mod' }))).body.data
      .find((row) => row.target_id === commentId);
    expect(group.target_gone).toBe(true);
  });

  it('does the same for a comment its author deleted', async () => {
    const { commenter, commentId } = await seedComment('Buy cheap boots at example.invalid');
    await file(named('reporter'), { targetKind: 'comment', targetId: commentId, category: 'spam' });

    await request(app).delete(`/api/comments/${commentId}`).set(authHeader(commenter)).send();

    const [row] = rowsFor(commentId);
    expect(row.status).toBe('open');
    expect(row.target_gone_at).toBeTruthy();
    expect(row.target_snippet).toContain('cheap boots');
  });

  it('says so on the queue, and still closes with the reporters told', async () => {
    const { author, id } = await seedListing();
    const mod = named('mod', { accountType: 'mod' });
    const reporter = named('reporter');
    await file(reporter, listingReport({ targetId: id }));
    await request(app).delete(`/api/worlds/${id}`).set(authHeader(author)).send();

    const group = (await queue(mod)).body.data.find((row) => row.target_id === id);
    expect(group.target_gone).toBe(true);

    const res = await resolve(mod, { targetKind: 'listing', targetId: id, outcome: 'actioned' });

    expect(res.status).toBe(200);
    expect((await inbox(reporter)).body.data).toHaveLength(1);
  });
});

describe('what the room can see', () => {
  it('keeps reports out of the listing payload the author reads', async () => {
    const { author, id } = await seedListing();
    await file(named('reporter'), listingReport({ targetId: id, details: 'Stolen from me' }));

    const res = await request(app).get(`/api/worlds/${id}`).set(authHeader(author)).send();
    const payload = JSON.stringify(res.body);

    expect(res.status).toBe(200);
    expect(payload).not.toMatch(/Stolen from me/);
    expect(payload).not.toMatch(/"reports"/);
  });

  it('keeps a reporter\'s name off everything an ordinary account can reach', async () => {
    const { author, id } = await seedListing();
    const reporter = named('grass');
    await file(reporter, listingReport({ targetId: id }));

    const catalog = await request(app).get('/api/worlds').set(authHeader(author)).send();
    const comments = await request(app).get(`/api/worlds/${id}/comments`).set(authHeader(author)).send();
    const profile = await request(app).get(`/api/users/${author.id}/profile`).set(authHeader(author)).send();

    for (const res of [catalog, comments, profile]) {
      expect(JSON.stringify(res.body)).not.toContain(reporter.username);
    }
  });

  it('tells a signed-in client the categories it may pick from', async () => {
    const res = await request(app).get('/api/reports/meta').set(authHeader(named('anyone'))).send();

    expect(res.status).toBe(200);
    expect(res.body.data.categories).toEqual(
      ['illegal', 'hate', 'spam', 'stolen', 'malicious', 'other']
    );
  });
});
