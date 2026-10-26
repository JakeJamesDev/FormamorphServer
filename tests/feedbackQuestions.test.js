import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { eraseUser } = require('../src/utils/eraseUser');

/**
 * Questions: the third feedback branch. A public board like suggestions, where voters are parties too,
 * staff close a question by locking it, and the asker or staff accept one reply as its answer.
 */

const staff = () => createUser({ username: 'root-admin', accountType: 'admin' });
const player = (username) => createUser({ username });

const QUESTION = { type: 'question', title: 'How do I load a local model?', category: 'setup', body: 'The list stays empty.' };
const REPORT = { type: 'bug', title: 'Save button does nothing', category: 'crash', body: 'Pressing save just spins.' };
const SUGGESTION = { type: 'suggestion', title: 'Let me rename a save', category: 'interface', body: 'Renaming means re-saving.' };

const file = (user, payload = QUESTION) =>
  request(app).post('/api/feedback').set(authHeader(user)).send(payload);
const read = (user, id) => request(app).get(`/api/feedback/${id}`).set(authHeader(user));
const reply = (user, id, body = 'Point it at the folder.') =>
  request(app).post(`/api/feedback/${id}/comments`).set(authHeader(user)).send({ body });
const vote = (user, id, voted = true) =>
  request(app).put(`/api/feedback/${id}/vote`).set(authHeader(user)).send({ voted });
const setStatus = (user, id, status) =>
  request(app).put(`/api/feedback/${id}/status`).set(authHeader(user)).send({ status });
const lock = (user, id, locked = true) =>
  request(app).put(`/api/feedback/${id}/lock`).set(authHeader(user)).send({ locked });
const convert = (user, id, type, category) =>
  request(app).put(`/api/feedback/${id}`).set(authHeader(user)).send({ type, category });
const list = (user, query) => request(app).get(`/api/feedback${query}`).set(authHeader(user));
const unread = async (user) => (await request(app).get('/api/feedback/unread-count').set(authHeader(user))).body.unread;

/** Keeps a later write off the same millisecond as an earlier read marker. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 3); });

const seedQuestion = async () => {
  const asker = player('asker');
  const res = await file(asker);
  return { asker, id: res.body.data.id };
};

describe('filing a question', () => {
  it('stores it open, with the asker’s own vote', async () => {
    const asker = player('asker');

    const res = await file(asker);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'question', category: 'setup', status: 'open', votes: 1, voted: true, diagnostics: {}
    });
    expect((await read(asker, res.body.data.id)).body.data).toMatchObject({ votes: 1, voted: true });
  });

  it('takes every question category', async () => {
    const asker = player('asker');

    for (const category of ['gameplay', 'editor', 'setup', 'community', 'account', 'other']) {
      expect((await file(asker, { ...QUESTION, category })).status).toBe(201);
    }
  });

  it('refuses a category from another type’s list', async () => {
    const asker = player('asker');

    expect((await file(asker, { ...QUESTION, category: 'crash' })).status).toBe(400);
    expect((await file(asker, { ...QUESTION, category: 'interface' })).status).toBe(400);
  });
});

describe('replies', () => {
  it('lets a stranger reply to a question', async () => {
    const { id } = await seedQuestion();

    expect((await reply(player('stranger'), id)).status).toBe(201);
  });

  it('still refuses a stranger’s reply to a bug', async () => {
    const bug = await file(player('finder'), REPORT);

    const res = await reply(player('stranger'), bug.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the reporter and the team can reply here');
  });
});

describe('votes', () => {
  it('lets a stranger vote on a question and take it back', async () => {
    const { id } = await seedQuestion();
    const stranger = player('stranger');

    expect((await vote(stranger, id)).body.data).toMatchObject({ votes: 2, voted: true });
    expect((await vote(stranger, id, false)).body.data).toMatchObject({ votes: 1, voted: false });
  });

  it('sorts questions by votes', async () => {
    const asker = player('asker');
    const quiet = (await file(asker, { ...QUESTION, title: 'Quiet one' })).body.data.id;
    const wanted = (await file(asker, { ...QUESTION, title: 'Wanted one' })).body.data.id;
    await tick();
    const newest = (await file(asker, { ...QUESTION, title: 'Newest one' })).body.data.id;
    await vote(player('fan-a'), wanted);
    await vote(player('fan-b'), wanted);
    await vote(player('fan-c'), quiet);

    const res = await list(asker, '?type=question&scope=all&sort=votes');

    expect(res.body.data.map((row) => row.id)).toEqual([wanted, quiet, newest]);
  });
});

describe('unread for voters', () => {
  it('does not raise a voter’s badge for replies written before the vote', async () => {
    const { id } = await seedQuestion();
    await reply(player('helper'), id);
    await tick();
    const voter = player('voter');

    await vote(voter, id);

    expect(await unread(voter)).toBe(0);
  });

  it('raises a voter’s badge on a new reply, and clears it when they open the question', async () => {
    const { id } = await seedQuestion();
    const voter = player('voter');
    await vote(voter, id);
    await tick();

    await reply(player('helper'), id);
    expect(await unread(voter)).toBe(1);
    expect((await list(voter, '?type=question&scope=all')).body.data[0].unread).toBe(true);

    await read(voter, id);
    expect(await unread(voter)).toBe(0);
  });

  it('does not clear a voter’s badge when they send their vote again', async () => {
    const { id } = await seedQuestion();
    const voter = player('voter');
    await vote(voter, id);
    await tick();
    await reply(player('helper'), id);

    await vote(voter, id);

    expect(await unread(voter)).toBe(1);
  });

  it('badges the asker and a commenter on a new reply', async () => {
    const { asker, id } = await seedQuestion();
    const commenter = player('commenter');
    await reply(commenter, id);
    await read(asker, id);
    await tick();

    await reply(player('helper'), id);

    expect(await unread(asker)).toBe(1);
    expect(await unread(commenter)).toBe(1);
  });

  it('leaves a voter on a suggestion unbadged', async () => {
    const suggestion = await file(player('idea'), SUGGESTION);
    const voter = player('voter');
    await vote(voter, suggestion.body.data.id);
    await tick();

    await reply(player('helper'), suggestion.body.data.id);

    expect(await unread(voter)).toBe(0);
  });

  it('does not make staff a party to a question they never touched', async () => {
    const { id } = await seedQuestion();
    const root = staff();

    await reply(player('helper'), id);

    expect(await unread(root)).toBe(0);
  });

  it('makes staff a party once they vote', async () => {
    const { id } = await seedQuestion();
    const root = staff();
    await vote(root, id);
    await tick();

    await reply(player('helper'), id);

    expect(await unread(root)).toBe(1);
    await read(root, id);
    expect(await unread(root)).toBe(0);
  });
});

describe('status', () => {
  it('refuses `answered` through the status route', async () => {
    const { id } = await seedQuestion();

    const res = await setStatus(staff(), id, 'answered');

    expect(res.status).toBe(400);
    expect((await read(player('reader'), id)).body.data.status).toBe('open');
  });

  it('refuses another type’s status', async () => {
    const { id } = await seedQuestion();

    expect((await setStatus(staff(), id, 'planned')).status).toBe(400);
  });

  it('locks a question it closes, and unlocks it on reopening', async () => {
    const { asker, id } = await seedQuestion();
    const root = staff();

    expect((await setStatus(root, id, 'closed')).body.data).toMatchObject({ status: 'closed', locked: true });
    expect((await reply(asker, id)).status).toBe(403);

    expect((await setStatus(root, id, 'open')).body.data).toMatchObject({ status: 'open', locked: false });
    expect((await reply(asker, id)).status).toBe(201);
  });

  it('keeps a lock set through the lock route when an open question is set open', async () => {
    const { id } = await seedQuestion();
    const root = staff();
    await lock(root, id);

    expect((await setStatus(root, id, 'open')).body.data).toMatchObject({ status: 'open', locked: true });
  });

  it('keeps the original lock time when closing an already locked question', async () => {
    const { id } = await seedQuestion();
    const root = staff();
    await lock(root, id);
    const lockedAt = db.prepare('SELECT locked_at FROM feedback WHERE id = ?').get(id).locked_at;
    await tick();

    await setStatus(root, id, 'closed');

    expect(db.prepare('SELECT locked_at FROM feedback WHERE id = ?').get(id).locked_at).toBe(lockedAt);
  });

  it('is staff-only', async () => {
    const { asker, id } = await seedQuestion();

    expect((await setStatus(asker, id, 'closed')).status).toBe(403);
  });
});

describe('converting', () => {
  const CATEGORY = { bug: 'other', suggestion: 'other', question: 'other' };
  const PAYLOAD = { bug: REPORT, suggestion: SUGGESTION, question: QUESTION };
  const DIRECTIONS = [
    ['bug', 'suggestion'], ['bug', 'question'],
    ['suggestion', 'bug'], ['suggestion', 'question'],
    ['question', 'bug'], ['question', 'suggestion']
  ];

  it.each(DIRECTIONS)('converts a %s to a %s, open, with its votes', async (from, to) => {
    const root = staff();
    const filed = await file(player('filer'), PAYLOAD[from]);
    const id = filed.body.data.id;
    const votesBefore = filed.body.data.votes;

    const res = await convert(root, id, to, CATEGORY[to]);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: to, status: 'open', category: 'other', votes: votesBefore });
  });

  it('does not raise a voter’s badge when a suggestion becomes a question', async () => {
    const root = staff();
    const suggestion = await file(player('filer'), SUGGESTION);
    const id = suggestion.body.data.id;
    const voter = player('voter');
    await vote(voter, id);
    await reply(player('helper'), id);
    await tick();

    await convert(root, id, 'question', 'gameplay');
    expect(await unread(voter)).toBe(0);

    await tick();
    await reply(player('helper-two'), id);
    expect(await unread(voter)).toBe(1);
  });

  it('does not add the reporter’s vote when a bug becomes a question', async () => {
    const bug = await file(player('finder'), REPORT);

    const res = await convert(staff(), bug.body.data.id, 'question', 'setup');

    expect(res.body.data).toMatchObject({ votes: 0, voted: false });
  });

  it('closes replies to strangers when a question becomes a bug', async () => {
    const { id } = await seedQuestion();

    await convert(staff(), id, 'bug', 'other');

    expect((await reply(player('stranger'), id)).status).toBe(403);
  });

  it('refuses a category from the old type’s list', async () => {
    const { id } = await seedQuestion();

    expect((await convert(staff(), id, 'bug', 'setup')).status).toBe(400);
  });
});

const accept = (user, id, commentId) =>
  request(app).put(`/api/feedback/${id}/answer`).set(authHeader(user)).send({ commentId });
const removeComment = (user, id, commentId) =>
  request(app).delete(`/api/feedback/${id}/comments/${commentId}`).set(authHeader(user));
const answerEntries = () => db.prepare("SELECT * FROM audit_log WHERE action = 'feedback_answer_set'").all();

/** A question with one reply from a helper. */
const seedAnswered = async () => {
  const { asker, id } = await seedQuestion();
  const helper = player('helper');
  const commentId = (await reply(helper, id, 'Point it at the models folder.')).body.data.id;
  return { asker, helper, id, commentId };
};

describe('accepting an answer', () => {
  it('lets the asker accept a reply, which sets `answered` and shows to every reader', async () => {
    const { asker, id, commentId } = await seedAnswered();

    const res = await accept(asker, id, commentId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'answered',
      acceptedAnswer: { id: commentId, body: 'Point it at the models folder.', author: { username: 'helper' } }
    });
    expect(res.body.comments).toBeUndefined();
    // The pinned copy is the comment in the same shape the thread lists it.
    const detail = await read(asker, id);
    expect(res.body.data.acceptedAnswer).toEqual(detail.body.comments.find((comment) => comment.id === commentId));
    expect((await read(player('reader'), id)).body.data.acceptedAnswer).toMatchObject({ id: commentId });
  });

  it('lets the asker accept their own reply', async () => {
    const { asker, id } = await seedQuestion();
    const own = (await reply(asker, id, 'Found it: the folder was wrong.')).body.data.id;

    const res = await accept(asker, id, own);

    expect(res.status).toBe(200);
    expect(res.body.data.acceptedAnswer).toMatchObject({ id: own, author: { username: 'asker' } });
  });

  it('changes the answer, then clears it back to `open`', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const second = (await reply(player('second'), id, 'Or restart the app.')).body.data.id;
    await accept(asker, id, commentId);

    expect((await accept(asker, id, second)).body.data).toMatchObject({ status: 'answered', acceptedAnswer: { id: second } });

    const cleared = await accept(asker, id, null);
    expect(cleared.body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });

  it('lets staff accept on any question, and logs it against the asker', async () => {
    const { id, commentId } = await seedAnswered();

    const res = await accept(staff(), id, commentId);

    expect(res.body.data.status).toBe('answered');
    const [entry] = answerEntries();
    expect(entry).toMatchObject({
      actor_username: 'root-admin', target_username: 'asker', target_kind: 'question',
      target_name: QUESTION.title, snippet: 'Point it at the models folder.'
    });
  });

  it('logs staff clearing an answer', async () => {
    const { asker, id, commentId } = await seedAnswered();
    await accept(asker, id, commentId);

    await accept(staff(), id, null);

    expect(answerEntries().map((entry) => entry.snippet)).toEqual([null]);
  });

  it('leaves the asker’s own pick out of the log', async () => {
    const { asker, id, commentId } = await seedAnswered();

    await accept(asker, id, commentId);
    await accept(asker, id, null);

    expect(answerEntries()).toHaveLength(0);
  });

  it('leaves staff picking on their own question out of the log', async () => {
    const root = staff();
    const id = (await file(root)).body.data.id;
    const commentId = (await reply(player('helper'), id)).body.data.id;

    expect((await accept(root, id, commentId)).body.data.status).toBe('answered');

    expect(answerEntries()).toHaveLength(0);
  });

  it('writes nothing when the same answer is sent again', async () => {
    const { id, commentId } = await seedAnswered();
    const root = staff();
    await accept(root, id, commentId);
    const updatedAt = db.prepare('SELECT updated_at FROM feedback WHERE id = ?').get(id).updated_at;
    await tick();

    expect((await accept(root, id, commentId)).status).toBe(200);

    expect(db.prepare('SELECT updated_at FROM feedback WHERE id = ?').get(id).updated_at).toBe(updatedAt);
    expect(answerEntries()).toHaveLength(1);
  });

  it('refuses a caller who is neither the asker nor staff', async () => {
    const { helper, id, commentId } = await seedAnswered();

    const res = await accept(helper, id, commentId);

    expect(res.status).toBe(403);
    expect((await read(helper, id)).body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });

  it('refuses a thread that is not a question', async () => {
    const filer = player('filer');
    const id = (await file(filer, SUGGESTION)).body.data.id;
    const commentId = (await reply(player('helper'), id)).body.data.id;

    const res = await accept(filer, id, commentId);

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT accepted_comment_id FROM feedback WHERE id = ?').get(id).accepted_comment_id).toBeNull();
  });

  it('refuses a comment from another thread', async () => {
    const { asker, id } = await seedQuestion();
    const other = (await file(player('other-asker'))).body.data.id;
    const foreign = (await reply(player('helper'), other)).body.data.id;

    const res = await accept(asker, id, foreign);

    expect(res.status).toBe(400);
    expect((await read(asker, id)).body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });

  it('refuses a missing or malformed comment id', async () => {
    const { asker, id } = await seedQuestion();

    expect((await accept(asker, id, undefined)).status).toBe(400);
    expect((await accept(asker, id, 42)).status).toBe(400);
    expect((await accept(asker, id, 'no-such-comment')).status).toBe(400);
  });

  it('lets the asker accept and clear on a locked question', async () => {
    const { asker, id, commentId } = await seedAnswered();
    await lock(staff(), id);

    expect((await accept(asker, id, commentId)).body.data).toMatchObject({ status: 'answered', locked: true });
    expect((await accept(asker, id, null)).body.data).toMatchObject({ status: 'open', locked: true });
  });

  it('stores and clears the answer on a closed question, which stays closed', async () => {
    const { asker, id, commentId } = await seedAnswered();
    await setStatus(staff(), id, 'closed');

    expect((await accept(asker, id, commentId)).body.data)
      .toMatchObject({ status: 'closed', acceptedAnswer: { id: commentId } });
    expect((await accept(asker, id, null)).body.data).toMatchObject({ status: 'closed', acceptedAnswer: null });
  });

  it('reopens a closed question with an answer as `answered`, unlocked', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const root = staff();
    await accept(asker, id, commentId);
    await setStatus(root, id, 'closed');

    expect((await setStatus(root, id, 'open')).body.data).toMatchObject({ status: 'answered', locked: false });
  });

  it('keeps an answered question `answered` when staff set it open', async () => {
    const { asker, id, commentId } = await seedAnswered();
    await accept(asker, id, commentId);

    expect((await setStatus(staff(), id, 'open')).body.data.status).toBe('answered');
  });

  it('carries the answer on every route that returns the thread', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const root = staff();
    await accept(asker, id, commentId);
    const carries = (res) => expect(res.body.data.acceptedAnswer).toMatchObject({ id: commentId });

    carries(await read(asker, id));
    carries(await vote(player('voter'), id));
    carries(await request(app).put(`/api/feedback/${id}`).set(authHeader(asker)).send({ title: 'How do I load a model?' }));
    carries(await lock(root, id));
    carries(await setStatus(root, id, 'closed'));
    const row = (await list(asker, '?type=question')).body.data.find((thread) => thread.id === id);
    expect(row.acceptedAnswer).toMatchObject({ id: commentId });
  });

  it('carries a null answer on threads without one', async () => {
    const created = await file(player('filer'), REPORT);

    expect(created.body.data.acceptedAnswer).toBeNull();
    expect((await read(player('reader'), created.body.data.id)).body.data.acceptedAnswer).toBeNull();
  });

  it('clears the answer on any type change', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const root = staff();
    await accept(asker, id, commentId);

    await convert(root, id, 'suggestion', 'other');
    const back = await convert(root, id, 'question', 'setup');

    expect(back.body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });
});

describe('deleting the accepted reply', () => {
  it('returns the question to `open` when its author deletes it, with foreign keys on', async () => {
    const { asker, helper, id, commentId } = await seedAnswered();
    await accept(asker, id, commentId);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    expect((await removeComment(helper, id, commentId)).status).toBe(200);

    expect((await read(asker, id)).body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });

  it('returns the question to `open` when staff delete it', async () => {
    const { asker, id, commentId } = await seedAnswered();
    await accept(asker, id, commentId);

    expect((await removeComment(staff(), id, commentId)).status).toBe(200);

    expect((await read(asker, id)).body.data).toMatchObject({ status: 'open', acceptedAnswer: null });
  });

  it('keeps a closed question closed', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const root = staff();
    await accept(asker, id, commentId);
    await setStatus(root, id, 'closed');

    await removeComment(root, id, commentId);

    expect((await read(asker, id)).body.data).toMatchObject({ status: 'closed', acceptedAnswer: null });
  });

  it('leaves the answer alone when another reply is deleted', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const other = player('other');
    const otherId = (await reply(other, id, 'Me too.')).body.data.id;
    await accept(asker, id, commentId);

    await removeComment(other, id, otherId);

    expect((await read(asker, id)).body.data).toMatchObject({ status: 'answered', acceptedAnswer: { id: commentId } });
  });

  it('keeps the answer with no author when the author’s account is erased', async () => {
    const { asker, helper, id, commentId } = await seedAnswered();
    await accept(asker, id, commentId);

    await eraseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(helper.id));

    expect((await read(asker, id)).body.data).toMatchObject({
      status: 'answered',
      acceptedAnswer: { id: commentId, body: 'Point it at the models folder.', author: { id: null, username: null } }
    });
  });

  it('deletes a whole question that has an accepted answer', async () => {
    const { asker, id, commentId } = await seedAnswered();
    const root = staff();
    await accept(asker, id, commentId);

    expect((await request(app).delete(`/api/feedback/${id}`).set(authHeader(root))).status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_comments WHERE feedback_id = ?').get(id).n).toBe(0);
    expect((await read(asker, id)).status).toBe(404);
  });
});
