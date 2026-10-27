import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { parseLinks } = require('../src/utils/feedbackLinks');
const CASES = require('./fixtures/feedbackLinkCases.json');

/** Links in feedback text: the grammar, and the targets each post carries, resolved for its reader. */

const SITE = 'https://formamorph.ai';

const file = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'suggestion', title: 'An idea', category: 'gameplay', body: 'Body.', ...over });

const BUG = { type: 'bug', category: 'crash', title: 'It crashed' };

const read = (ref, user) => {
  const req = request(app).get(`/api/feedback/${ref}`);
  return user ? req.set(authHeader(user)) : req;
};

let listings = 0;
const listing = (author, over = {}) => {
  listings += 1;
  const row = {
    id: `w-${listings}`, kind: 'world', name: 'Sedge Landing',
    visibility: 'public', moderation_state: 'approved', quarantined_at: null, ...over
  };
  db.prepare(`
    INSERT INTO worlds (id, kind, name, description, author_id, thumbnail_file, content_file, visibility, moderation_state, quarantined_at)
    VALUES (@id, @kind, @name, 'd', @author, 'thumbs/sedge.png', 'c.json', @visibility, @moderation_state, @quarantined_at)
  `).run({ ...row, author: author.id });
  return row;
};

describe('the link grammar', () => {
  it.each(CASES.map((entry) => [entry.name, entry]))('%s', (_name, { text, links }) => {
    expect(parseLinks(text)).toEqual(links);
  });
});

describe('a thread target', () => {
  it('carries number, title, type and status for a thread the reader can read', async () => {
    const user = createUser({ username: 'filer' });
    await file(user, { title: 'Bigger maps' });
    await file(user, { body: 'Like #1 but #1 again.' });

    const res = await read(2, user);

    expect(res.body.data.targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'Bigger maps', type: 'suggestion', status: 'open' }
    ]);
  });

  it('is the same unavailable target for a missing thread, a deleted thread and a bug read by a guest', async () => {
    const root = createUser({ username: 'root-admin', accountType: 'admin' });
    const user = createUser({ username: 'filer' });
    await file(user, BUG);
    const { body: { data: doomed } } = await file(user);
    await request(app).delete(`/api/feedback/${doomed.id}`).set(authHeader(root));
    await file(user, { body: 'See #1, #2 and #99.' });

    const res = await read(3);

    expect(res.body.data.targets).toEqual(['1', '2', '99'].map((ref) => ({ kind: 'thread', ref, available: false })));
  });

  it('resolves the bug for a signed-in reader, who may read it', async () => {
    const user = createUser({ username: 'filer' });
    await file(user, BUG);
    await file(user, { body: 'See #1.' });

    const res = await read(2, createUser({ username: 'passerby' }));

    expect(res.body.data.targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'It crashed', type: 'bug', status: 'open' }
    ]);
  });

  it('resolves a thread linking itself like any other', async () => {
    const user = createUser({ username: 'filer' });
    await file(user, { body: 'This is #1.' });

    expect((await read(1, user)).body.data.targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'An idea', type: 'suggestion', status: 'open' }
    ]);
  });

  it('is never read from a title', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);
    await file(user, { title: 'Follow-up to #1', body: 'No links here.' });

    expect((await read(2, user)).body.data.targets).toEqual([]);
  });

  it('comes from a pasted thread URL as from #N', async () => {
    const user = createUser({ username: 'filer' });
    await file(user);
    await file(user, { body: `Same as ${SITE}/feedback/1.` });

    expect((await read(2, user)).body.data.targets.map((target) => target.number)).toEqual([1]);
  });
});

describe('a listing target', () => {
  it('carries kind, id, title and thumbnail for a publicly visible listing', async () => {
    const user = createUser({ username: 'filer' });
    const world = listing(user);
    await file(user, { body: `Try ${SITE}/community/world/${world.id}` });

    const res = await read(1);

    expect(res.body.data.targets).toEqual([{
      kind: 'listing', ref: `world/${world.id}`, available: true,
      listingKind: 'world', id: world.id, title: 'Sedge Landing', thumbnailUrl: '/api/thumbnails/sedge.png'
    }]);
  });

  it('is unavailable when hidden, pending, quarantined, deleted or of another kind, even to its author and staff', async () => {
    const author = createUser({ username: 'maker' });
    const admin = createUser({ username: 'root-admin', accountType: 'admin' });
    const hidden = listing(author, { visibility: 'unlisted' });
    const pending = listing(author, { moderation_state: 'pending' });
    const quarantined = listing(author, { quarantined_at: '2026-10-01T00:00:00.000Z' });
    const entity = listing(author, { kind: 'entity' });
    const refs = [`world/${hidden.id}`, `world/${pending.id}`, `world/${quarantined.id}`, 'world/gone', `world/${entity.id}`];
    await file(author, { body: refs.map((ref) => `${SITE}/community/${ref}`).join(' ') });

    const unavailable = refs.map((ref) => ({ kind: 'listing', ref, available: false }));
    expect((await read(1, author)).body.data.targets).toEqual(unavailable);
    expect((await read(1, admin)).body.data.targets).toEqual(unavailable);
  });
});

describe('targets on every post', () => {
  it('ride on comments, the accepted answer, list rows and write responses', async () => {
    const user = createUser({ username: 'asker' });
    await file(user);
    const { body: { data: question } } = await file(user, {
      type: 'question', category: 'setup', title: 'How?', body: 'Is #1 related?'
    });
    const added = await request(app).post(`/api/feedback/${question.id}/comments`).set(authHeader(user)).send({ body: 'Yes, #1.' });
    const edited = await request(app).put(`/api/feedback/${question.id}/comments/${added.body.data.id}`)
      .set(authHeader(user)).send({ body: 'Yes, #1 and #2.' });
    const answered = await request(app).put(`/api/feedback/${question.id}/answer`).set(authHeader(user))
      .send({ commentId: added.body.data.id });
    const list = await request(app).get('/api/feedback?type=question&scope=all');
    const thread = await read(2);

    const refs = (targets) => targets.map((target) => target.ref);
    expect(refs(question.targets)).toEqual(['1']);
    expect(refs(added.body.data.targets)).toEqual(['1']);
    expect(refs(edited.body.data.targets)).toEqual(['1', '2']);
    expect(refs(answered.body.data.acceptedAnswer.targets)).toEqual(['1', '2']);
    expect(refs(list.body.data[0].targets)).toEqual(['1']);
    expect(refs(thread.body.comments[0].targets)).toEqual(['1', '2']);
  });

  it('resolve in the same number of queries however many links a thread holds', async () => {
    const user = createUser({ username: 'filer' });
    const worlds = Array.from({ length: 12 }, () => listing(user));
    // Filed by many players, as a busy board is: the filing limit is per account.
    for (let i = 0; i < 12; i += 1) await file(createUser());
    const { body: { data: sparse } } = await file(user, { body: '#1' });
    const { body: { data: dense } } = await file(user, {
      body: `${Array.from({ length: 12 }, (_, i) => `#${i + 1}`).join(' ')} ${worlds.map((w) => `${SITE}/community/world/${w.id}`).join(' ')}`
    });
    for (const [thread, body, count] of [[sparse, '#2 #3', 1], [dense, '#4 #5 #6 #7', 5]]) {
      for (let i = 0; i < count; i += 1) {
        await request(app).post(`/api/feedback/${thread.id}/comments`).set(authHeader(user)).send({ body: `${body} ${SITE}/community/world/${worlds[i].id}` });
      }
    }

    const queriesFor = async (thread) => {
      const spy = vi.spyOn(db, 'prepare');
      try {
        await read(thread.number, user);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    expect(await queriesFor(dense)).toBe(await queriesFor(sparse));
  });
});
