import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * Rewriting a report.
 *
 * Who owns the words differs by branch: a bug is a work item for the team, so a poorly written one can be
 * made useful; a suggestion is somebody's idea on a public board and stays in their words. The filing —
 * category and type — is triage either way, and a type move is the one change that pulls others with it.
 */

let seq = 0;
const staffAs = (accountType) => (username = `${accountType}-${++seq}`) => createUser({ username, accountType });
const admin = staffAs('admin');
const mod = staffAs('mod');

const file = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user)).send({
    type: 'bug',
    title: 'IT BROKE',
    category: 'crash',
    body: 'it just broke ok',
    diagnostics: { version: '2.8.0', platform: 'desktop' },
    ...over,
  });

const edit = (user, id, body) => request(app).put(`/api/feedback/${id}`).set(authHeader(user)).send(body);

const row = (id) => db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);

const seed = async (over = {}) => {
  const reporter = createUser();
  const id = (await file(reporter, over)).body.data.id;
  return { reporter, id };
};

describe('the reporter’s own words', () => {
  it('lets them fix their title and description', async () => {
    const { reporter, id } = await seed();

    const res = await edit(reporter, id, { title: 'Save button spins forever', body: 'Steps: open a world, press Save.' });

    expect(res.status).toBe(200);
    expect(row(id).title).toBe('Save button spins forever');
    expect(row(id).body).toBe('Steps: open a world, press Save.');
  });

  it('marks it edited, since the other reader may have read the earlier wording', async () => {
    const { reporter, id } = await seed();
    expect(row(id).edited_at).toBeNull();

    await edit(reporter, id, { title: 'Save button spins forever' });

    expect(row(id).edited_at).toBeTruthy();
  });

  it('takes one field without clearing the other', async () => {
    const { reporter, id } = await seed();

    await edit(reporter, id, { title: 'Save button spins forever' });

    expect(row(id).body).toBe('it just broke ok');
  });

  it('works the same on their own suggestion', async () => {
    const { reporter, id } = await seed({ type: 'suggestion', category: 'gameplay' });

    expect((await edit(reporter, id, { body: 'A clearer version of the idea.' })).status).toBe(200);
  });

  it('stops once the thread is locked', async () => {
    const { reporter, id } = await seed();
    await request(app).put(`/api/feedback/${id}/lock`).set(authHeader(admin())).send({ locked: true });

    const res = await edit(reporter, id, { title: 'Too late' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locked/i);
    expect(row(id).title).toBe('IT BROKE');
  });

  it('is nobody else’s to do', async () => {
    const { id } = await seed();
    const stranger = createUser();

    expect((await edit(stranger, id, { title: 'Mine now' })).status).toBe(403);
    expect(row(id).title).toBe('IT BROKE');
  });

  it('refuses an empty title or description rather than blanking one', async () => {
    const { reporter, id } = await seed();

    expect((await edit(reporter, id, { title: '   ' })).status).toBe(400);
    expect((await edit(reporter, id, { body: '' })).status).toBe(400);
    expect(row(id).title).toBe('IT BROKE');
  });

  it('holds them to the same caps as filing', async () => {
    const { reporter, id } = await seed();

    expect((await edit(reporter, id, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await edit(reporter, id, { body: 'x'.repeat(4001) })).status).toBe(400);
  });
});

describe('the team rewriting a bug', () => {
  it('can make a poorly written one useful', async () => {
    // A bug is a work item for the team, not a piece of somebody's writing.
    const { id } = await seed();

    const res = await edit(mod(), id, { title: 'Save button spins forever', body: 'Reproduced on 2.8.0.' });

    expect(res.status).toBe(200);
    expect(row(id).title).toBe('Save button spins forever');
  });

  it('can do it even while it is locked', async () => {
    const { id } = await seed();
    await request(app).put(`/api/feedback/${id}/lock`).set(authHeader(admin())).send({ locked: true });

    expect((await edit(mod(), id, { title: 'Save button spins forever' })).status).toBe(200);
  });

  it('cannot touch a suggestion’s words', async () => {
    // The board is the community's; moderation re-files it, it does not reword it.
    const { id } = await seed({ type: 'suggestion', category: 'gameplay' });

    const res = await edit(mod(), id, { body: 'Rewritten by the team.' });

    expect(res.status).toBe(403);
    expect(row(id).body).toBe('it just broke ok');
  });

  it('leaves the reporter still able to edit afterwards', async () => {
    const { reporter, id } = await seed();
    await edit(mod(), id, { title: 'Save button spins forever' });

    expect((await edit(reporter, id, { body: 'Adding the steps.' })).status).toBe(200);
  });
});

describe('re-filing', () => {
  it('lets the team change the category', async () => {
    const { id } = await seed();

    expect((await edit(mod(), id, { category: 'editor' })).status).toBe(200);
    expect(row(id).category).toBe('editor');
  });

  it('is not the reporter’s to do', async () => {
    const { reporter, id } = await seed();

    const res = await edit(reporter, id, { category: 'editor' });

    expect(res.status).toBe(403);
    expect(row(id).category).toBe('crash');
  });

  it('refuses a category from the other branch', async () => {
    const { id } = await seed();

    expect((await edit(mod(), id, { category: 'gameplay' })).status).toBe(400);
    expect(row(id).category).toBe('crash');
  });
});

describe('moving between the branches', () => {
  it('takes the category with it, because the lists barely overlap', async () => {
    // `crash` has no honest answer on the suggestion side, so the mover names the new one.
    const { id } = await seed();

    const res = await edit(mod(), id, { type: 'suggestion', category: 'gameplay' });

    expect(res.status).toBe(200);
    expect(row(id).type).toBe('suggestion');
    expect(row(id).category).toBe('gameplay');
  });

  it('refuses a move with no category to move to', async () => {
    const { id } = await seed();

    const res = await edit(mod(), id, { type: 'suggestion' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs a suggestion category/i);
    expect(row(id).type).toBe('bug');
  });

  it('refuses a move to a category the new branch does not have', async () => {
    const { id } = await seed();

    expect((await edit(mod(), id, { type: 'suggestion', category: 'crash' })).status).toBe(400);
    expect(row(id).type).toBe('bug');
  });

  it('returns the status to open, the only value both branches share', async () => {
    const { id } = await seed();
    await request(app).put(`/api/feedback/${id}/status`).set(authHeader(mod())).send({ status: 'confirmed' });

    await edit(mod(), id, { type: 'suggestion', category: 'gameplay' });

    expect(row(id).status).toBe('open');
  });

  it('deletes the diagnostics rather than hiding them', async () => {
    // A suggestion is a public board post, and the version and platform were collected under bug rules.
    const { id } = await seed();
    expect(JSON.parse(row(id).diagnostics).version).toBe('2.8.0');

    await edit(mod(), id, { type: 'suggestion', category: 'gameplay' });

    expect(row(id).diagnostics).toBe('{}');
  });

  it('keeps the votes and the conversation, which are about the same thing either way', async () => {
    const { reporter, id } = await seed({ type: 'suggestion', category: 'gameplay' });
    await request(app).post(`/api/feedback/${id}/comments`).set(authHeader(reporter)).send({ body: 'Still want this.' });

    await edit(mod(), id, { type: 'bug', category: 'other' });

    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_comments WHERE feedback_id = ?').get(id).n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_votes WHERE feedback_id = ?').get(id).n).toBe(1);
  });

  it('is not the reporter’s to do', async () => {
    const { reporter, id } = await seed();

    expect((await edit(reporter, id, { type: 'suggestion', category: 'gameplay' })).status).toBe(403);
    expect(row(id).type).toBe('bug');
  });

  it('refuses a type nobody has heard of', async () => {
    const { id } = await seed();

    expect((await edit(mod(), id, { type: 'complaint', category: 'other' })).status).toBe(400);
    expect(row(id).type).toBe('bug');
  });

  it('changes who may rewrite it, which falls out of the rule rather than being a special case', async () => {
    const { id } = await seed();
    await edit(mod(), id, { type: 'suggestion', category: 'gameplay' });

    expect((await edit(mod(), id, { title: 'Now the community’s' })).status).toBe(403);
  });
});

describe('what the log keeps', () => {
  it('records an edit by somebody other than the reporter', async () => {
    const { id } = await seed();

    await edit(mod('root-mod'), id, { title: 'Save button spins forever' });

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'feedback_edited'").get();
    expect(entry.actor_username).toBe('root-mod');
    expect(entry.snippet).toContain('rewrote the report');
  });

  it('says what moved on a re-filing', async () => {
    const { id } = await seed();

    await edit(mod(), id, { type: 'suggestion', category: 'gameplay' });

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'feedback_edited'").get();
    expect(entry.snippet).toContain('bug to suggestion');
    expect(entry.snippet).toContain('category: crash to gameplay');
  });

  it('leaves the reporter’s own typo fix out of it', async () => {
    // A log full of people correcting themselves buries the entries that matter.
    const { reporter, id } = await seed();

    await edit(reporter, id, { title: 'Save button spins forever' });

    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'feedback_edited'").get().n).toBe(0);
  });

  it('names the reporter as the person it was done to', async () => {
    const reporter = createUser({ username: 'wren_hallow' });
    const id = (await file(reporter)).body.data.id;

    await edit(mod(), id, { category: 'editor' });

    expect(db.prepare("SELECT * FROM audit_log WHERE action = 'feedback_edited'").get().target_username).toBe('wren_hallow');
  });
});

describe('the request itself', () => {
  it('404s a thread that is not there', async () => {
    expect((await edit(admin(), 'no-such-thread', { title: 'x' })).status).toBe(404);
  });

  it('turns away a stranger with no token', async () => {
    const { id } = await seed();

    expect((await request(app).put(`/api/feedback/${id}`).send({ title: 'x' })).status).toBe(401);
  });

  it('says so when there is nothing to change', async () => {
    const { reporter, id } = await seed();

    expect((await edit(reporter, id, {})).status).toBe(400);
  });

  it('answers with the thread as it now reads', async () => {
    const { reporter, id } = await seed();

    const res = await edit(reporter, id, { title: 'Save button spins forever' });

    expect(res.body.data.title).toBe('Save button spins forever');
    expect(res.body.data.editedAt).toBeTruthy();
  });
});
