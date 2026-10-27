import { describe, it, expect } from 'vitest';
import { app, request, db } from './context.js';
import { createUser, authHeader, fromItsOwnAddress } from './helpers.js';

/**
 * The editor's two autocomplete reads: usernames by prefix (a thread's participants first) and threads by
 * number prefix or title words.
 */

const REPORT = { type: 'bug', title: 'Save button does nothing', category: 'crash', body: 'Pressing save just spins.' };
const SUGGESTION = { type: 'suggestion', title: 'Let me rename a save', category: 'interface', body: 'Renaming means re-saving.' };
const QUESTION = { type: 'question', title: 'How do I load a local model?', category: 'setup', body: 'The list stays empty.' };

const file = async (user, payload) =>
  (await request(app).post('/api/feedback').set(authHeader(user)).send(payload)).body.data;
// Filing is capped per account, so a big board is filed by several accounts.
const fileMany = async (count, payload) => {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(await file(createUser({ username: `filer-${index}` }), payload));
  }
  return made;
};
const reply = (user, id) =>
  request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body: 'Same here.' });
const users = (user, query) => request(app).get('/api/feedback/search/users').query(query).set(authHeader(user));
const threads = (user, query) => request(app).get('/api/feedback/search/threads').query(query).set(authHeader(user));
const names = (res) => res.body.data.map((entry) => entry.username);

describe('searching usernames', () => {
  it('matches a prefix regardless of letter case and skips other names', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'Alice' });
    createUser({ username: 'alfred' });
    createUser({ username: 'bob-al' });

    const res = await users(caller, { q: 'AL' });

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['alfred', 'Alice']);
  });

  it('matches % and _ literally', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'a_b' });
    createUser({ username: 'axb' });

    expect(names(await users(caller, { q: 'a_' }))).toEqual(['a_b']);
    expect(names(await users(caller, { q: '%' }))).toEqual([]);
  });

  it("ranks the thread's reporter and commenters first", async () => {
    const reporter = createUser({ username: 'zed-reporter' });
    const commenter = createUser({ username: 'zed-commenter' });
    createUser({ username: 'zed-aaa-bystander' });
    const thread = await file(reporter, SUGGESTION);
    await reply(commenter, thread.id);

    const res = await users(reporter, { q: 'zed', thread: thread.id });

    expect(names(res)).toEqual(['zed-commenter', 'zed-reporter', 'zed-aaa-bystander']);
    expect(res.body.data.map((entry) => entry.participant)).toEqual([true, true, false]);
  });

  it('reads the thread by number as well as by id', async () => {
    const reporter = createUser({ username: 'zed-reporter' });
    createUser({ username: 'zed-aaa-bystander' });
    const thread = await file(reporter, SUGGESTION);

    const res = await users(reporter, { q: 'zed', thread: String(thread.number) });

    expect(names(res)).toEqual(['zed-reporter', 'zed-aaa-bystander']);
  });

  it('lists only the participants for an empty prefix with a thread', async () => {
    const reporter = createUser({ username: 'reporter' });
    const commenter = createUser({ username: 'commenter' });
    createUser({ username: 'bystander' });
    const thread = await file(reporter, SUGGESTION);
    await reply(commenter, thread.id);

    expect(names(await users(reporter, { thread: thread.id }))).toEqual(['commenter', 'reporter']);
  });

  it('returns nothing for an empty prefix without a thread', async () => {
    const caller = createUser({ username: 'caller' });

    expect(names(await users(caller, {}))).toEqual([]);
  });

  it('skips names a mention cannot parse', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'ok-name_1' });
    createUser({ username: 'ok' });
    createUser({ username: 'ok name' });
    createUser({ username: 'ok.name' });
    createUser({ username: 'ok-this-name-is-too-long' });

    expect(names(await users(caller, { q: 'ok' }))).toEqual(['ok-name_1']);
  });

  it('skips a suspended account, even a thread participant', async () => {
    const reporter = createUser({ username: 'zed-reporter', status: 'suspended' });
    createUser({ username: 'zed-active' });
    const caller = createUser({ username: 'caller' });
    const thread = await file(createUser({ username: 'filer' }), SUGGESTION);
    await reply(reporter, thread.id);

    expect(names(await users(caller, { q: 'zed', thread: thread.id }))).toEqual(['zed-active']);
  });

  it('skips a flagged twin until it renames, then lists its new name', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'Quill', createdAt: '2024-01-01 00:00:00' });
    const twin = createUser({ username: 'quill', createdAt: '2024-02-01 00:00:00' });
    db.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?').run(twin.id);

    expect(names(await users(caller, { q: 'quill' }))).toEqual(['Quill']);

    const renamed = await fromItsOwnAddress(
      request(app).post('/api/auth/username').set(authHeader(twin)).send({ username: 'quill_two' })
    );
    expect(renamed.status).toBe(200);
    expect(names(await users(caller, { q: 'quill' }))).toEqual(['Quill', 'quill_two']);
  });

  it('caps the result count', async () => {
    const caller = createUser({ username: 'caller' });
    for (let index = 0; index < 12; index += 1) createUser({ username: `many-${index}` });

    expect((await users(caller, { q: 'many' })).body.data).toHaveLength(8);
  });

  it('carries the account fields a mention chip needs, and no more', async () => {
    const caller = createUser({ username: 'caller' });
    createUser({ username: 'shown' });

    const [entry] = (await users(caller, { q: 'shown' })).body.data;

    expect(Object.keys(entry).sort()).toEqual(['avatarUrl', 'id', 'participant', 'role', 'supporter', 'username']);
  });

  it('refuses a guest', async () => {
    expect((await request(app).get('/api/feedback/search/users').query({ q: 'a' })).status).toBe(401);
  });

  it('is rate limited per account', async () => {
    const spender = createUser({ username: 'spender' });
    const other = createUser({ username: 'other' });

    const codes = [];
    for (let index = 0; index < 121; index += 1) codes.push((await users(spender, { q: 'a' })).status);

    expect(codes.slice(0, 120).every((code) => code === 200)).toBe(true);
    expect(codes[120]).toBe(429);
    expect((await users(other, { q: 'a' })).status).toBe(200);
  });
});

describe('searching threads', () => {
  it('matches a number prefix, an exact number first', async () => {
    const poster = createUser({ username: 'poster' });
    const made = await fileMany(12, SUGGESTION);
    const one = made[0].number;
    const prefixed = made.filter((thread) => String(thread.number).startsWith(String(one)));

    const res = await threads(poster, { q: String(one) });

    expect(res.body.data[0].number).toBe(one);
    expect(res.body.data.map((entry) => entry.number).sort()).toEqual(prefixed.map((thread) => thread.number).sort());
  });

  it('matches title words by prefix, case-insensitively, mid-title too', async () => {
    const poster = createUser({ username: 'poster' });
    const rename = await file(poster, SUGGESTION);
    await file(poster, QUESTION);

    expect((await threads(poster, { q: 'RENAM' })).body.data.map((entry) => entry.number)).toEqual([rename.number]);
    expect((await threads(poster, { q: 'sav' })).body.data.map((entry) => entry.number)).toEqual([rename.number]);
    expect((await threads(poster, { q: 'enam' })).body.data).toEqual([]);
  });

  it('needs every typed word to start a title word', async () => {
    const poster = createUser({ username: 'poster' });
    const both = await file(poster, { ...SUGGESTION, title: 'Map editor crash' });
    await file(createUser({ username: 'other' }), { ...SUGGESTION, title: 'Map legend' });

    const res = await threads(poster, { q: 'map crash' });

    expect(res.body.data.map((entry) => entry.number)).toEqual([both.number]);
  });

  it('treats an empty types filter as no filter', async () => {
    const poster = createUser({ username: 'poster' });
    await file(poster, SUGGESTION);

    expect((await threads(poster, { q: 'rename', types: '' })).body.data).toHaveLength(1);
  });

  it('returns number, title, type and status', async () => {
    const poster = createUser({ username: 'poster' });
    const thread = await file(poster, QUESTION);

    const res = await threads(poster, { q: 'local' });

    expect(res.body.data).toEqual([{ number: thread.number, title: QUESTION.title, type: 'question', status: 'open' }]);
  });

  it('returns nothing for an empty or one-letter query', async () => {
    const poster = createUser({ username: 'poster' });
    await file(poster, SUGGESTION);

    expect((await threads(poster, { q: '' })).body.data).toEqual([]);
    expect((await threads(poster, { q: 'r' })).body.data).toEqual([]);
  });

  it('narrows to the types asked for', async () => {
    const poster = createUser({ username: 'poster' });
    await file(poster, { ...REPORT, title: 'Shared words here' });
    await file(poster, { ...SUGGESTION, title: 'Shared words here' });
    await file(poster, { ...QUESTION, title: 'Shared words here' });

    const all = await threads(poster, { q: 'shared' });
    const boards = await threads(poster, { q: 'shared', types: 'suggestion,question' });

    expect(all.body.data.map((entry) => entry.type).sort()).toEqual(['bug', 'question', 'suggestion']);
    expect(boards.body.data.map((entry) => entry.type).sort()).toEqual(['question', 'suggestion']);
    expect((await threads(poster, { q: 'shared', types: 'nope' })).status).toBe(400);
  });

  it('caps the result count', async () => {
    const poster = createUser({ username: 'poster' });
    await fileMany(12, SUGGESTION);

    expect((await threads(poster, { q: 'rename' })).body.data).toHaveLength(8);
  });

  it('lists a thread the caller can read, whoever filed it', async () => {
    const other = createUser({ username: 'other' });
    const caller = createUser({ username: 'caller' });
    const bug = await file(other, REPORT);

    expect((await threads(caller, { q: 'save' })).body.data.map((entry) => entry.number)).toEqual([bug.number]);
  });

  it('never returns a thread the caller cannot read', async () => {
    const poster = createUser({ username: 'poster' });
    const caller = createUser({ username: 'caller' });
    await file(poster, SUGGESTION);
    const Feedback = (await import('module')).createRequire(import.meta.url)('../src/models/Feedback');
    const original = Feedback.canRead;
    Feedback.canRead = () => false;
    try {
      expect((await threads(caller, { q: 'rename' })).body.data).toEqual([]);
    } finally {
      Feedback.canRead = original;
    }
  });

  it('refuses a guest', async () => {
    expect((await request(app).get('/api/feedback/search/threads').query({ q: 'a' })).status).toBe(401);
  });
});
