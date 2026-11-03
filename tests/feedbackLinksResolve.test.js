import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/** The resolve route: the targets of text not yet posted, for the reader asking. */

const SITE = 'https://formamorph.ai';

const file = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'suggestion', title: 'An idea', category: 'gameplay', body: 'Body.', ...over });
const resolve = (user, body) => {
  const req = request(app).post('/api/feedback/links/resolve');
  return (user ? req.set(authHeader(user)) : req).send(body);
};
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('resolving unposted text', () => {
  it('returns the targets a posted comment with that text carries', async () => {
    const author = createUser({ username: 'filer' });
    createUser({ username: 'friend' });
    await file(author, { title: 'Bigger maps' });
    const { body: { data: thread } } = await file(author);
    const text = `Ask @friend about #1, and @nobody. ${SITE}/community/world/gone`;

    const preview = await resolve(author, { text });
    await request(app).post(`/api/feedback/${thread.id}/comments`).set(authHeader(author)).send({ body: text });
    const posted = (await request(app).get(`/api/feedback/${thread.id}`).set(authHeader(author))).body.comments[0];

    expect(preview.status).toBe(200);
    expect(preview.body.data.targets.map((target) => target.kind)).toEqual(['user', 'thread', 'user', 'listing']);
    expect(preview.body.data.targets).toEqual(posted.targets);
  });

  it('returns no targets for text without links', async () => {
    const res = await resolve(createUser({ username: 'reader' }), { text: '' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ targets: [] });
  });

  it('refuses a guest', async () => {
    expect((await resolve(null, { text: '#1' })).status).toBe(401);
  });

  it('refuses text that is missing or not a string', async () => {
    const reader = createUser({ username: 'reader' });

    expect((await resolve(reader, {})).status).toBe(400);
    expect((await resolve(reader, { text: 7 })).status).toBe(400);
  });

  it('refuses text over the longest feedback body and takes text at it', async () => {
    const reader = createUser({ username: 'reader' });

    const over = await resolve(reader, { text: 'a'.repeat(4001) });
    const at = await resolve(reader, { text: 'a'.repeat(4000) });

    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Text is limited to 4000 characters');
    expect(at.status).toBe(200);
  });

  it('is rate limited per account, apart from the autocomplete budget', async () => {
    const spender = createUser({ username: 'spender' });
    const other = createUser({ username: 'other' });

    const codes = [];
    for (let index = 0; index < 61; index += 1) codes.push((await resolve(spender, { text: '#1' })).status);
    const search = await request(app).get('/api/feedback/search/users').query({ q: 'a' }).set(authHeader(spender));

    expect(codes.slice(0, 60).every((code) => code === 200)).toBe(true);
    expect(codes[60]).toBe(429);
    expect(search.status).toBe(200);
    expect((await resolve(other, { text: '#1' })).status).toBe(200);
  });

  it('resolves for the reader: a bug is available to a signed-in reader; a missing thread and a hidden listing are not', async () => {
    const filer = createUser({ username: 'filer' });
    const passerby = createUser({ username: 'passerby' });
    await file(filer, { type: 'bug', category: 'crash', title: 'It crashed' });
    db.prepare(`
      INSERT INTO worlds (id, kind, name, description, author_id, thumbnail_file, content_file, visibility, moderation_state)
      VALUES ('w-hidden', 'world', 'Hidden', 'd', @author, 'thumbs/h.png', 'c.json', 'unlisted', 'approved')
    `).run({ author: filer.id });

    const res = await resolve(passerby, { text: `#1 #99 ${SITE}/community/world/w-hidden` });

    expect(res.body.data.targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'It crashed', type: 'bug', status: 'open' },
      { kind: 'thread', ref: '99', available: false },
      { kind: 'listing', ref: 'world/w-hidden', available: false }
    ]);
  });

  it('writes no rows', async () => {
    const author = createUser({ username: 'filer' });
    createUser({ username: 'friend' });
    await file(author, { body: 'See @friend.' });
    const before = [count('feedback'), count('feedback_comments'), count('feedback_mentions')];

    await resolve(author, { text: 'Hi @friend, see #1' });

    expect([count('feedback'), count('feedback_comments'), count('feedback_mentions')]).toEqual(before);
  });
});
