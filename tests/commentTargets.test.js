import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/** Links in listing comments: every read, create and edit carries `targets`, resolved for its reader. */

const SITE = 'https://formamorph.ai';

let seq = 0;
const publish = (user, over = {}) =>
  request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload(over));

const post = (user, worldId, content) =>
  request(app).post(`/api/worlds/${worldId}/comments`).set(authHeader(user)).send({ content });

const edit = (user, id, content) =>
  request(app).put(`/api/comments/${id}`).set(authHeader(user)).send({ content });

const list = (worldId, user) => {
  const req = request(app).get(`/api/worlds/${worldId}/comments`);
  return user ? req.set(authHeader(user)) : req;
};

const fileThread = (user, over = {}) =>
  request(app).post('/api/feedback').set(authHeader(user))
    .send({ type: 'suggestion', title: 'Bigger maps', category: 'gameplay', body: 'Body.', ...over });

const seed = async () => {
  const owner = createUser({ username: `owner-${++seq}` });
  const world = (await publish(owner, { name: 'Sedge Landing' })).body.data;
  return { owner, worldId: world.id, world };
};

describe('targets on a comment list', () => {
  it('come with every comment, one entry per distinct target', async () => {
    const { worldId } = await seed();
    const filer = createUser({ username: 'filer' });
    const writer = createUser({ username: 'writer' });
    await fileThread(filer);
    await post(writer, worldId, 'Like #1 and #1 again, thanks @filer.');
    await post(writer, worldId, 'Nothing to link.');

    const res = await list(worldId, writer);

    const byText = Object.fromEntries(res.body.data.map((c) => [c.content, c]));
    expect(byText['Nothing to link.'].targets).toEqual([]);
    expect(byText['Like #1 and #1 again, thanks @filer.'].targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'Bigger maps', type: 'suggestion', status: 'open' },
      expect.objectContaining({ kind: 'user', ref: 'filer', available: true, username: 'filer' })
    ]);
  });

  it('hide a bug thread from a guest and show it to a signed-in reader', async () => {
    const { worldId } = await seed();
    const filer = createUser({ username: 'filer' });
    await fileThread(filer, { type: 'bug', category: 'crash', title: 'It crashed' });
    await post(filer, worldId, 'See #1.');

    const guest = await list(worldId);
    const reader = await list(worldId, createUser({ username: 'passerby' }));

    expect(guest.body.data[0].targets).toEqual([{ kind: 'thread', ref: '1', available: false }]);
    expect(reader.body.data[0].targets).toEqual([
      { kind: 'thread', ref: '1', available: true, number: 1, title: 'It crashed', type: 'bug', status: 'open' }
    ]);
  });

  it('give an unmatched name as an unavailable user, with no profile data', async () => {
    const { worldId } = await seed();
    await post(createUser({ username: 'writer' }), worldId, 'Ask @nobody-here.');

    const res = await list(worldId);

    expect(res.body.data[0].targets).toEqual([{ kind: 'user', ref: 'nobody-here', available: false }]);
  });

  it('give a hidden listing as unavailable, with no title or kind', async () => {
    const { worldId } = await seed();
    const hidden = (await publish(createUser({ username: 'other' }), { name: 'Secret Place' })).body.data;
    db.prepare("UPDATE worlds SET visibility = 'unlisted' WHERE id = ?").run(hidden.id);
    await post(createUser({ username: 'writer' }), worldId, `Look: ${SITE}/community/world/${hidden.id}`);

    const res = await list(worldId);

    expect(res.body.data[0].targets).toEqual([{ kind: 'listing', ref: `world/${hidden.id}`, available: false }]);
  });

  it('give a visible listing with its title and kind', async () => {
    const { worldId } = await seed();
    const other = (await publish(createUser({ username: 'other' }), { name: 'Open Place' })).body.data;
    await post(createUser({ username: 'writer' }), worldId, `Look: ${SITE}/community/world/${other.id}`);

    const res = await list(worldId);

    expect(res.body.data[0].targets).toEqual([
      expect.objectContaining({ kind: 'listing', available: true, listingKind: 'world', id: other.id, title: 'Open Place' })
    ]);
  });
});

describe('targets on a create and an edit', () => {
  it('come back for the new text', async () => {
    const { worldId } = await seed();
    const writer = createUser({ username: 'writer' });
    await fileThread(createUser({ username: 'filer' }));

    const created = await post(writer, worldId, 'See #1.');

    expect(created.status).toBe(201);
    expect(created.body.data.targets.map((t) => t.ref)).toEqual(['1']);
  });

  it('come back for the edited text, not the old', async () => {
    const { worldId } = await seed();
    const writer = createUser({ username: 'writer' });
    await fileThread(createUser({ username: 'filer' }));
    const id = (await post(writer, worldId, 'See #1.')).body.data.id;

    const res = await edit(writer, id, 'Ask @nobody-here.');

    expect(res.status).toBe(200);
    expect(res.body.data.targets).toEqual([{ kind: 'user', ref: 'nobody-here', available: false }]);
  });
});

describe('mentions in a listing comment', () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `@person${i}`).join(' ');

  it('are accepted past the feedback cap, with no mention row written', async () => {
    const { worldId } = await seed();
    for (let i = 0; i < 12; i += 1) createUser({ username: `person${i}` });
    const before = db.prepare('SELECT COUNT(*) AS n FROM feedback_mentions').get().n;

    const res = await post(createUser({ username: 'writer' }), worldId, names(12));

    expect(res.status).toBe(201);
    expect(res.body.data.targets).toHaveLength(12);
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_mentions').get().n).toBe(before);
  });

  it('leave the stored text as typed', async () => {
    const { worldId } = await seed();
    const text = 'Hi @Writer-Two, see #7 and `@code`.';

    const id = (await post(createUser({ username: 'writer' }), worldId, text)).body.data.id;

    expect(db.prepare('SELECT content FROM comments WHERE id = ?').get(id).content).toBe(text);
  });
});
