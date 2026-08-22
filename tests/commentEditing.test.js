import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * Rewriting and removing a comment left on a listing.
 *
 * Two rules pull in different directions and both have to hold: the words stay their author's, so nobody
 * — staff included — rewrites them; but the page they sit on belongs to somebody, so its author and the
 * team can take them down. The audit entry a delete writes is covered in audit.test.js.
 */

let seq = 0;
const staffAs = (accountType) => (username = `${accountType}-${++seq}`) => createUser({ username, accountType });
const admin = staffAs('admin');
const mod = staffAs('mod');

const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const post = (user, worldId, content) =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content });

const edit = (user, id, content) =>
  request(app).put(`/api/comments/${id}`).set(authHeader(user)).send({ content });

const remove = (user, id) => request(app).delete(`/api/comments/${id}`).set(authHeader(user));

const row = (id) => db.prepare('SELECT * FROM comments WHERE id = ?').get(id);

const worldRow = (id, user) => request(app).get(`/api/worlds/${id}`).set(authHeader(user));

/** A published listing, its author, and one comment on it by somebody else. */
const seed = async (commenter = createUser({ username: `commenter-${++seq}` })) => {
  const owner = createUser({ username: `owner-${++seq}` });
  const worldId = (await publish(owner, { name: 'Sedge Landing' })).body.data.id;
  const id = (await post(commenter, worldId, 'First!')).body.data.id;
  return { owner, commenter, worldId, id };
};

describe('rewriting a comment', () => {
  it('is the commenter’s to do, with no deadline on it', async () => {
    const { commenter, id } = await seed();

    const res = await edit(commenter, id, 'First — and here is what I actually meant.');

    expect(res.status).toBe(200);
    expect(row(id).content).toBe('First — and here is what I actually meant.');
  });

  it('marks it edited, since a reply may have been written against the earlier wording', async () => {
    const { commenter, id } = await seed();
    expect(row(id).edited_at).toBeNull();

    await edit(commenter, id, 'Fixed a typo.');

    expect(row(id).edited_at).toBeTruthy();
  });

  it('says so in the response, so the thread can show it without refetching', async () => {
    const { commenter, id } = await seed();

    const res = await edit(commenter, id, 'Fixed a typo.');

    expect(res.body.data.edited_at).toBeTruthy();
  });

  it('leaves an untouched comment saying nothing of the kind', async () => {
    const { worldId } = await seed();

    const listed = await request(app).get(`/api/worlds/${worldId}/comments`);

    expect(listed.body.data[0].edited_at).toBeNull();
  });

  it('is refused to a stranger', async () => {
    const { id } = await seed();

    expect((await edit(createUser({ username: 'passerby' }), id, 'Mine now')).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('is refused to the author of the listing it sits on', async () => {
    // Their page, not their words — taking it down is theirs, rewriting it is not.
    const { owner, id } = await seed();

    expect((await edit(owner, id, 'What they meant was')).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('is refused to a moderator, whose reach stops short of putting words in a mouth', async () => {
    const { id } = await seed();

    expect((await edit(mod(), id, 'Sanitized.')).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('is refused to an admin for the same reason', async () => {
    const { id } = await seed();

    expect((await edit(admin(), id, 'Sanitized.')).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('refuses an empty rewrite rather than blanking the comment', async () => {
    const { commenter, id } = await seed();

    expect((await edit(commenter, id, '')).status).toBe(400);
    expect(row(id).content).toBe('First!');
  });

  it('counts a body of spaces as empty rather than storing it', async () => {
    const { commenter, id } = await seed();

    expect((await edit(commenter, id, '   ')).status).toBe(400);
    expect(row(id).content).toBe('First!');
  });

  it('trims what it does store, so a comment never opens on blank lines', async () => {
    const { commenter, id } = await seed();

    await edit(commenter, id, '\n  Second thoughts.  \n');

    expect(row(id).content).toBe('Second thoughts.');
  });
});

describe('taking a comment down', () => {
  it('is the commenter’s to do', async () => {
    const { commenter, id } = await seed();

    expect((await remove(commenter, id)).status).toBe(200);
    expect(row(id)).toBeUndefined();
  });

  it('is the listing author’s to do on their own page', async () => {
    const { owner, id } = await seed();

    expect((await remove(owner, id)).status).toBe(200);
    expect(row(id)).toBeUndefined();
  });

  it('is a moderator’s to do over an ordinary account', async () => {
    const { id } = await seed();

    expect((await remove(mod(), id)).status).toBe(200);
    expect(row(id)).toBeUndefined();
  });

  it('stops at another staff account, the same as every other moderation surface', async () => {
    const { id } = await seed(admin('commenting-admin'));

    expect((await remove(mod(), id)).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('is refused to a passer-by', async () => {
    const { id } = await seed();

    expect((await remove(createUser({ username: 'passerby' }), id)).status).toBe(403);
    expect(row(id).content).toBe('First!');
  });

  it('takes the listing’s count down with it, so the browser keeps telling the truth', async () => {
    const { owner, worldId, id } = await seed();
    expect((await worldRow(worldId, owner)).body.data.comment_count).toBe(1);

    await remove(owner, id);

    expect((await worldRow(worldId, owner)).body.data.comment_count).toBe(0);
    expect((await request(app).get(`/api/worlds/${worldId}/comments`)).body.total).toBe(0);
  });
});

describe('how much a comment may say', () => {
  it('takes the same 4000 characters a feedback comment does', async () => {
    const { commenter, worldId } = await seed();

    expect((await post(commenter, worldId, 'x'.repeat(4000))).status).toBe(201);
  });

  it('refuses one character more', async () => {
    const { commenter, worldId } = await seed();

    expect((await post(commenter, worldId, 'x'.repeat(4001))).status).toBe(400);
  });

  it('refuses a new comment made only of spaces', async () => {
    const { commenter, worldId } = await seed();

    expect((await post(commenter, worldId, '   ')).status).toBe(400);
  });

  it('holds a rewrite to the same cap', async () => {
    const { commenter, id } = await seed();

    expect((await edit(commenter, id, 'x'.repeat(4000))).status).toBe(200);
    expect((await edit(commenter, id, 'x'.repeat(4001))).status).toBe(400);
  });
});

describe('a listing under quarantine', () => {
  const quarantine = (worldId) =>
    request(app).put(`/api/worlds/${worldId}/quarantine`).set(authHeader(admin('quarantiner'))).send({});

  it('takes no new comments', async () => {
    const { commenter, worldId } = await seed();
    await quarantine(worldId);

    expect((await post(commenter, worldId, 'Anybody home?')).status).toBe(403);
  });

  it('does not trap the words already there — the commenter can still fix them', async () => {
    const { commenter, worldId, id } = await seed();
    await quarantine(worldId);

    expect((await edit(commenter, id, 'On reflection.')).status).toBe(200);
  });

  it('or take them back entirely', async () => {
    const { commenter, worldId, id } = await seed();
    await quarantine(worldId);

    expect((await remove(commenter, id)).status).toBe(200);
    expect(row(id)).toBeUndefined();
  });
});
