import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, seedUsers, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Feedback = require('../src/models/Feedback');
const { PLACEHOLDER_ID, PLACEHOLDER_USERNAME } = require('../src/config/accountDeletion');

/**
 * `@username` in feedback: who a post mentions, what that makes them a party to, the cap per writer, and
 * the user targets each post carries.
 */

const SUGGESTION = { type: 'suggestion', category: 'gameplay', title: 'An idea' };
const QUESTION = { type: 'question', category: 'setup', title: 'How?' };
const BUG = { type: 'bug', category: 'crash', title: 'It crashed' };

const file = (user, body, over = SUGGESTION) =>
  request(app).post('/api/feedback').set(authHeader(user)).send({ ...over, body });
const comment = (user, id, body) =>
  request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body });
const editComment = (user, id, commentId, body) =>
  request(app).put(`/api/feedback/${id}/comments/${commentId}`).set(authHeader(user)).send({ body });
const deleteComment = (user, id, commentId) =>
  request(app).delete(`/api/feedback/${id}/comments/${commentId}`).set(authHeader(user));
const editThread = (user, id, fields) => request(app).put(`/api/feedback/${id}`).set(authHeader(user)).send(fields);
/** Read a thread, then let the clock move on: news must be newer than the marker, not in its millisecond. */
const read = async (user, id) => {
  const res = await request(app).get(`/api/feedback/${id}`).set(authHeader(user));
  const at = Date.now();
  while (Date.now() === at) await new Promise((resolve) => { setTimeout(resolve, 1); });
  return res;
};
const vote = (user, id) => request(app).put(`/api/feedback/${id}/vote`).set(authHeader(user)).send({ voted: true });
const mentionRows = () => db.prepare('SELECT COUNT(*) AS n FROM feedback_mentions').get().n;
const unread = async (user) => (await request(app).get('/api/feedback/unread-count').set(authHeader(user))).body.unread;

/** Four accounts: who files, who is mentioned, who else talks, and an admin. */
const cast = () => ({
  filer: createUser({ username: 'filer' }),
  wren: createUser({ username: 'wren' }),
  other: createUser({ username: 'other' }),
  root: createUser({ username: 'root', accountType: 'admin' })
});

describe('a mention on a suggestion or a question', () => {
  it.each([['suggestion', SUGGESTION], ['question', QUESTION]])('badges the %s until read, then badges later comments', async (_type, over) => {
    const { filer, wren, other } = cast();
    const { body: { data: thread } } = await file(filer, 'Thoughts, @wren?', over);

    expect(await unread(wren)).toBe(1);
    await read(wren, thread.id);
    expect(await unread(wren)).toBe(0);

    await comment(other, thread.id, 'Me too.');
    expect(await unread(wren)).toBe(1);
  });

  it('badges from a comment as from the body, matching any capitals', async () => {
    const { filer, wren, other } = cast();
    const { body: { data: thread } } = await file(filer, 'Plain.');

    await comment(other, thread.id, 'Pinging @WREN.');

    expect(await unread(wren)).toBe(1);
  });

  it('reaches the unflagged account of a shared name and badges only that one', async () => {
    const { filer } = cast();
    const keeper = createUser({ username: 'Sage', createdAt: '2024-01-01 00:00:00' });
    const twin = createUser({ username: 'sage', createdAt: '2024-02-01 00:00:00' });
    db.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?').run(twin.id);

    await file(filer, 'Hello @sage.');

    expect(await unread(keeper)).toBe(1);
    expect(await unread(twin)).toBe(0);
  });

  it('badges a mention edited into a body or a comment, and not again when the edit keeps it', async () => {
    const { filer, wren } = cast();
    const { body: { data: thread } } = await file(filer, 'Plain.');
    expect(await unread(wren)).toBe(0);

    await editThread(filer, thread.id, { body: 'Now with @wren.' });
    expect(await unread(wren)).toBe(1);
    await read(wren, thread.id);

    await editThread(filer, thread.id, { body: 'Reworded, still @wren.' });
    expect(await unread(wren)).toBe(0);

    const second = await file(filer, 'Plain again.');
    const { body: { data: secondReply } } = await comment(filer, second.body.data.id, 'Plain.');
    await editComment(filer, second.body.data.id, secondReply.id, 'Late @wren.');
    expect(await unread(wren)).toBe(1);
  });

  it('stops badging once the mention is edited out of the body', async () => {
    const { filer, wren, other } = cast();
    const { body: { data: thread } } = await file(filer, 'Thoughts, @wren?');
    await editThread(filer, thread.id, { body: 'Thoughts?' });

    await comment(other, thread.id, 'Me too.');

    expect(await unread(wren)).toBe(0);
  });

  it('stops badging once the comment is edited or deleted', async () => {
    const { filer, wren, other } = cast();
    const first = (await file(filer, 'One.')).body.data;
    const second = (await file(filer, 'Two.')).body.data;
    const edited = (await comment(other, first.id, 'Cc @wren.')).body.data;
    const deleted = (await comment(other, second.id, 'Cc @wren.')).body.data;
    expect(await unread(wren)).toBe(2);

    await editComment(other, first.id, edited.id, 'Cc nobody.');
    await deleteComment(other, second.id, deleted.id);
    await comment(filer, first.id, 'Later.');
    await comment(filer, second.id, 'Later.');

    expect(await unread(wren)).toBe(0);
  });

  it('keeps the thread for a user who replied, once the mention is gone', async () => {
    const { filer, wren, other } = cast();
    const { body: { data: thread } } = await file(filer, 'Thoughts, @wren?');
    await comment(wren, thread.id, 'Here.');
    await editThread(filer, thread.id, { body: 'Thoughts?' });

    await comment(other, thread.id, 'Me too.');

    expect(await unread(wren)).toBe(1);
  });

  it('keeps a question for a user who voted, once the mention is gone', async () => {
    const { filer, wren, other } = cast();
    const { body: { data: thread } } = await file(filer, 'Any idea, @wren?', QUESTION);
    await vote(wren, thread.id);
    await editThread(filer, thread.id, { body: 'Any idea?' });

    await comment(other, thread.id, 'Me too.');

    expect(await unread(wren)).toBe(1);
  });

  it('goes with its thread when the thread is deleted', async () => {
    const { filer, wren, root } = cast();
    const { body: { data: thread } } = await file(filer, 'Thoughts, @wren?');
    await comment(filer, thread.id, 'Cc @wren.');
    expect(mentionRows()).toBe(2);

    await request(app).delete(`/api/feedback/${thread.id}`).set(authHeader(root));

    expect(mentionRows()).toBe(0);
  });

  it('goes with the mentioned account when it is deleted', async () => {
    const filer = createUser({ username: 'filer' });
    const gone = createUser({ username: 'gone' });
    await file(filer, 'Thoughts, @gone?');
    expect(mentionRows()).toBe(1);

    db.prepare('DELETE FROM users WHERE id = ?').run(gone.id);

    expect(mentionRows()).toBe(0);
  });
});

describe('a mention in a bug', () => {
  it('links but adds nothing to the mentioned user’s badge', async () => {
    const { filer, wren, root } = cast();
    const { body: { data: bug } } = await file(filer, 'Seen by @wren too.', BUG);
    await comment(root, bug.id, 'Looking.');
    await comment(root, bug.id, 'Cc @wren.');

    expect(await unread(wren)).toBe(0);
    expect(Feedback.hasParticipated(Feedback.findById(bug.id), wren.id)).toBe(false);
    expect(bug.targets).toEqual([expect.objectContaining({ kind: 'user', ref: 'wren', available: true })]);
  });

  it('is no news to an admin, who is a party to every bug', async () => {
    const { filer, root } = cast();
    await file(filer, 'Cc @root.', BUG);

    expect(await unread(root)).toBe(0);
  });

  it('starts counting after a move to a board, without the move itself badging', async () => {
    const { filer, wren, other, root } = cast();
    const { body: { data: bug } } = await file(filer, 'Seen by @wren too.', BUG);
    await comment(root, bug.id, 'Looking.');

    await editThread(root, bug.id, { type: 'suggestion', category: 'gameplay' });
    expect(await unread(wren)).toBe(0);

    await comment(other, bug.id, 'Me too.');
    expect(await unread(wren)).toBe(1);
  });

  it('badges a mention added in the same edit that moves the bug to a board', async () => {
    const { filer, wren, root } = cast();
    const { body: { data: bug } } = await file(filer, 'Plain.', BUG);

    await editThread(root, bug.id, { type: 'suggestion', category: 'gameplay', body: 'Cc @wren.' });

    expect(await unread(wren)).toBe(1);
  });

  it('leaves an admin’s unread bug unread when the move makes the mention count', async () => {
    const { filer, root } = cast();
    const mod = createUser({ username: 'mod', accountType: 'mod' });
    const { body: { data: bug } } = await file(filer, 'Cc @root.', BUG);
    await comment(filer, bug.id, 'Still broken.');
    expect(await unread(root)).toBe(1);

    await editThread(mod, bug.id, { type: 'suggestion', category: 'gameplay' });

    expect(await unread(root)).toBe(1);
  });

  it('stops counting after a move from a board to bugs, and counts again on the way back', async () => {
    const { filer, wren, other, root } = cast();
    const { body: { data: thread } } = await file(filer, 'Thoughts, @wren?');
    await read(wren, thread.id);

    await editThread(root, thread.id, { type: 'bug', category: 'crash' });
    await comment(root, thread.id, 'Moved.');
    expect(await unread(wren)).toBe(0);

    await editThread(root, thread.id, { type: 'suggestion', category: 'gameplay' });
    await comment(other, thread.id, 'Me too.');
    expect(await unread(wren)).toBe(1);
  });
});

describe('the mention cap', () => {
  const names = (users) => users.map((user) => `@${user.username}`).join(' ');

  it.each([
    ['normal', 5],
    ['mod', 10],
    ['dev', 10]
  ])('lets a %s mention %i users and refuses one more, on create and on both edits', async (accountType, cap) => {
    const writer = createUser({ username: `writer-${accountType}`, accountType });
    const people = seedUsers(cap + 1, `p-${accountType}`);
    const fits = names(people.slice(0, cap));
    const over = names(people);

    expect((await file(writer, fits)).status).toBe(201);
    const refused = await file(writer, over);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(`A post can mention up to ${cap} people`);

    const { body: { data: thread } } = await file(writer, 'Plain.', BUG);
    const { body: { data: reply } } = await comment(writer, thread.id, fits);
    expect(reply.body).toBe(fits);
    expect((await comment(writer, thread.id, over)).status).toBe(400);
    const editedOver = await editComment(writer, thread.id, reply.id, over);
    expect(editedOver.status).toBe(400);
    expect(editedOver.body.error).toBe(`A post can mention up to ${cap} people`);
    const threadOver = await editThread(writer, thread.id, { body: over });
    expect(threadOver.status).toBe(400);
    expect(threadOver.body.error).toBe(`A post can mention up to ${cap} people`);
    expect(Feedback.findById(thread.id).body).toBe('Plain.');
  });

  it('puts no cap on an admin', async () => {
    const root = createUser({ username: 'root', accountType: 'admin' });

    expect((await file(root, names(seedUsers(30, 'many')))).status).toBe(201);
  });

  it('counts distinct users, dropping self, unknown names, repeats and other capitals', async () => {
    const writer = createUser({ username: 'writer' });
    const people = seedUsers(5, 'p');
    const body = `${names(people)} @writer @nobody-here @${people[0].username} @${people[1].username.toUpperCase()}`;

    expect((await file(writer, body)).status).toBe(201);
  });
});

describe('a user target', () => {
  it('carries id, username and avatar for a name that reaches an account', async () => {
    const { filer, wren } = cast();
    db.prepare("UPDATE users SET avatar_file = 'face.png' WHERE id = ?").run(wren.id);

    const { body: { data: thread } } = await file(filer, 'Hi @Wren and @wren.');

    expect(thread.targets).toEqual([
      { kind: 'user', ref: 'wren', available: true, id: wren.id, username: 'wren', avatarUrl: '/api/avatars/face.png' }
    ]);
  });

  it('is the same bare unavailable target for an unknown name, a suspended account and the deleted-user row', async () => {
    const filer = createUser({ username: 'filer' });
    createUser({ username: 'banned', status: 'suspended' });
    // The reserved row's own name cannot be typed as a mention, so give it one that can.
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run('deleted-user', PLACEHOLDER_ID);
    try {
      const { body: { data: thread } } = await file(filer, '@nobody @banned @deleted-user');

      expect(thread.targets).toEqual(['nobody', 'banned', 'deleted-user'].map((ref) => ({ kind: 'user', ref, available: false })));
    } finally {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(PLACEHOLDER_USERNAME, PLACEHOLDER_ID);
    }
  });

  it('reaches the account spelled exactly, else the oldest shown one, when two names differ only in capitals', async () => {
    const filer = createUser({ username: 'filer' });
    const older = createUser({ username: 'Sedge', createdAt: '2020-01-01 00:00:00' });
    const newer = createUser({ username: 'sedge', createdAt: '2021-01-01 00:00:00' });

    const exact = (await file(filer, '@sedge')).body.data.targets[0];
    const folded = (await file(filer, '@SEDGE')).body.data.targets[0];

    expect(exact.id).toBe(newer.id);
    expect(folded.id).toBe(older.id);
  });

  it('records no mention for a name that reaches no account', async () => {
    const filer = createUser({ username: 'filer' });
    createUser({ username: 'banned', status: 'suspended' });

    await file(filer, '@nobody @banned');

    expect(mentionRows()).toBe(0);
  });
});

describe('participationClause and hasParticipated', () => {
  // Each case leaves `subject` in some relation to one thread; the badge (the clause) and the read-marker
  // decision (`hasParticipated`) must say the same about it.
  const CASES = [
    ['a bystander', SUGGESTION, async () => {}, false],
    ['the reporter', SUGGESTION, async ({ subject, ctx }) => { ctx.thread = (await file(subject, 'Mine.')).body.data; }, true],
    ['a replier', SUGGESTION, async ({ subject, ctx }) => { await comment(subject, ctx.thread.id, 'Hi.'); }, true],
    ['mentioned in the body', SUGGESTION, async ({ filer, ctx }) => { await editThread(filer, ctx.thread.id, { body: '@subject' }); }, true],
    ['mentioned in a comment', QUESTION, async ({ filer, ctx }) => { await comment(filer, ctx.thread.id, '@subject'); }, true],
    ['mentioned, then edited out', SUGGESTION, async ({ filer, ctx }) => {
      await editThread(filer, ctx.thread.id, { body: '@subject' });
      await editThread(filer, ctx.thread.id, { body: 'Nobody.' });
    }, false],
    ['a suggestion voter', SUGGESTION, async ({ subject, ctx }) => {
      await vote(subject, ctx.thread.id);
    }, false],
    ['a question voter', QUESTION, async ({ subject, ctx }) => {
      await vote(subject, ctx.thread.id);
    }, true],
    ['mentioned in a bug', BUG, async ({ filer, ctx }) => { await editThread(filer, ctx.thread.id, { body: '@subject' }); }, false],
    ['mentioned in a bug comment', BUG, async ({ filer, ctx }) => { await comment(filer, ctx.thread.id, '@subject'); }, false]
  ];

  it.each(CASES)('agree for %s', async (_name, over, setUp, party) => {
    const filer = createUser({ username: 'filer' });
    const subject = createUser({ username: 'subject' });
    const other = createUser({ username: 'other', accountType: 'admin' });
    const ctx = { thread: (await file(filer, 'Plain.', over)).body.data };
    await setUp({ filer, subject, ctx });
    await read(subject, ctx.thread.id);

    await comment(other, ctx.thread.id, 'News.');

    expect(await unread(subject) === 1).toBe(party);
    expect(Feedback.hasParticipated(Feedback.findById(ctx.thread.id), subject.id)).toBe(party);
  });
});
