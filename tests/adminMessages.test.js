import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * `/api/messages` — one-way admin notices. Admins send from Manage Users; users read them in the profile
 * dialog. Nothing here accepts user-authored text, so the only writes a non-admin can make are the
 * read/dismiss flags on their own copy.
 */

const admin = (over = {}) => createUser({ username: 'root-admin', accountType: 'admin', ...over });

const compose = (over = {}) => ({ subject: 'Hello', body: 'A notice.', ...over });

const send = (sender, payload) =>
  request(app).post('/api/messages').set(authHeader(sender)).send(payload);

const inbox = (user) => request(app).get('/api/messages').set(authHeader(user));

const sentList = (adminUser, query = '') =>
  request(app).get(`/api/messages/sent${query}`).set(authHeader(adminUser));

/** Move a message in time so visibility can be tested against a fixed signup date. */
const backdate = (messageId, timestamp) =>
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(timestamp, messageId);

describe('POST /api/messages access', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/messages').send(compose({ recipientIds: ['x'] }));
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin sender', async () => {
    const plain = createUser({ username: 'plain' });
    const target = createUser({ username: 'target' });

    const res = await send(plain, compose({ recipientIds: [target.id] }));

    expect(res.status).toBe(403);
  });
});

describe('POST /api/messages validation', () => {
  const cases = [
    [{ subject: '', body: 'x', recipientIds: ['r'] }, 'an empty subject'],
    [{ subject: '   ', body: 'x', recipientIds: ['r'] }, 'a whitespace-only subject'],
    [{ subject: 'a'.repeat(121), body: 'x', recipientIds: ['r'] }, 'an oversize subject'],
    [{ subject: 'ok', body: '', recipientIds: ['r'] }, 'an empty body'],
    [{ subject: 'ok', body: 'a'.repeat(4001), recipientIds: ['r'] }, 'an oversize body'],
    [{ subject: 'ok', body: 'x', recipientIds: ['r'], severity: 'catastrophic' }, 'an unknown severity'],
    [{ subject: 'ok', body: 'x', recipientIds: ['r'], senderAs: 'anonymous' }, 'an unknown attribution'],
    [{ subject: 'ok', body: 'x' }, 'no recipients and no broadcast flag'],
    [{ subject: 'ok', body: 'x', recipientIds: [] }, 'an empty recipient list'],
    [{ subject: 'ok', body: 'x', broadcast: true, recipientIds: ['r'] }, 'a broadcast that also names recipients'],
    [{ subject: 'ok', body: 'x', recipientIds: ['r'], scope: 'new' }, 'widening a 1:1 send to new accounts'],
    [{ subject: 'ok', body: 'x', recipientIds: ['r'], scope: 'sticky' }, 'an unknown scope'],
    [{ subject: 'ok', body: 'x', recipientIds: Array.from({ length: 201 }, (_, i) => `r${i}`) }, 'more recipients than the ceiling'],
  ];

  for (const [payload, label] of cases) {
    it(`rejects ${label}`, async () => {
      const res = await send(admin(), payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c).toBe(0);
    });
  }

  it('accepts the maximum-length subject and body', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });

    const res = await send(root, {
      subject: 'a'.repeat(120),
      body: 'b'.repeat(4000),
      recipientIds: [target.id],
    });

    expect(res.status).toBe(201);
  });

  it('writes nothing when any recipient is unknown', async () => {
    // A partial send would leave some users messaged and the admin believing the whole batch failed.
    const root = admin();
    const real = createUser({ username: 'real' });

    const res = await send(root, compose({ recipientIds: [real.id, 'no-such-user'] }));

    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c).toBe(0);
  });
});

describe('POST /api/messages delivery', () => {
  it('delivers a 1:1 message to its recipient only', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const bystander = createUser({ username: 'bystander' });

    await send(root, compose({ subject: 'For you', recipientIds: [target.id] }));

    const mine = await inbox(target);
    const theirs = await inbox(bystander);

    expect(mine.body.data.map((m) => m.subject)).toEqual(['For you']);
    expect(theirs.body.data).toEqual([]);
  });

  it('creates one independent message per selected recipient', async () => {
    const root = admin();
    const targets = [1, 2, 3].map((n) => createUser({ username: `pick-${n}` }));

    const res = await send(root, compose({ recipientIds: targets.map((t) => t.id) }));

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(3);
    expect(new Set(res.body.data.map((m) => m.id)).size).toBe(3);

    // Recalling one must not touch the others.
    await request(app).delete(`/api/messages/sent/${res.body.data[0].id}`).set(authHeader(root));

    const stillDelivered = await Promise.all(targets.map((t) => inbox(t)));
    expect(stillDelivered.map((r) => r.body.data.length)).toEqual([0, 1, 1]);
  });

  it('deduplicates a repeated recipient', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });

    const res = await send(root, compose({ recipientIds: [target.id, target.id] }));

    expect(res.body.count).toBe(1);
  });

  it('signs with the admin username only when asked', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });

    await send(root, compose({ subject: 'Team', recipientIds: [target.id] }));
    await send(root, compose({ subject: 'Named', recipientIds: [target.id], senderAs: 'username' }));

    const res = await inbox(target);
    const bySubject = Object.fromEntries(res.body.data.map((m) => [m.subject, m]));

    expect(bySubject.Team.senderAs).toBe('team');
    expect(bySubject.Team.senderName).toBeNull();
    expect(bySubject.Named.senderName).toBe('root-admin');
  });

  it('carries the message severity through to the reader', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });

    await send(root, compose({ recipientIds: [target.id], severity: 'urgent' }));

    const res = await inbox(target);
    expect(res.body.data[0].severity).toBe('urgent');
  });

  it('defaults to the quietest severity', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });

    await send(root, compose({ recipientIds: [target.id] }));

    const res = await inbox(target);
    expect(res.body.data[0].severity).toBe('info');
  });
});

describe('broadcast visibility', () => {
  it('reaches every existing user', async () => {
    const root = admin();
    const a = createUser({ username: 'a' });
    const b = createUser({ username: 'b' });

    await send(root, compose({ subject: 'Notice', broadcast: true }));

    for (const user of [a, b, root]) {
      const res = await inbox(user);
      expect(res.body.data.map((m) => m.subject)).toEqual(['Notice']);
      expect(res.body.data[0].broadcast).toBe(true);
    }
  });

  it('does not reach an account created after it was sent', async () => {
    const root = admin();
    const sent = await send(root, compose({ subject: 'Old news', broadcast: true }));
    backdate(sent.body.data[0].id, '2020-01-01 00:00:00');

    const latecomer = createUser({ username: 'latecomer', createdAt: '2030-01-01 00:00:00' });

    const res = await inbox(latecomer);
    expect(res.body.data).toEqual([]);
  });

  it('reaches an account created after it was sent when pinned', async () => {
    const root = admin();
    const sent = await send(root, compose({ subject: 'House rules', broadcast: true, scope: 'pinned' }));
    backdate(sent.body.data[0].id, '2020-01-01 00:00:00');

    const latecomer = createUser({ username: 'latecomer', createdAt: '2030-01-01 00:00:00' });

    const res = await inbox(latecomer);
    expect(res.body.data.map((m) => m.subject)).toEqual(['House rules']);
  });

  it('compares signup and send dates as dates, not as strings', async () => {
    // `users.created_at` is CURRENT_TIMESTAMP ('… …') but ISO timestamps ('…T…Z') are written elsewhere
    // in this codebase and can arrive through an import. The two formats agree as raw strings until the
    // date separator, so a same-day pair compares on ' ' vs 'T' — ' ' sorts lower, and a broadcast sent
    // hours after an ISO signup looks older than it and silently vanishes from that inbox.
    const root = admin();
    const isoUser = createUser({ username: 'iso-user', createdAt: '2026-06-01T00:00:00.000Z' });

    const sent = await send(root, compose({ subject: 'After signup', broadcast: true }));
    backdate(sent.body.data[0].id, '2026-06-01 12:00:00');

    const res = await inbox(isoUser);
    expect(res.body.data.map((m) => m.subject)).toEqual(['After signup']);
  });
});

describe('read state', () => {
  const seed = async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));
    return { root, target, messageId: sent.body.data[0].id };
  };

  const markRead = (user, id) =>
    request(app).post(`/api/messages/${id}/read`).set(authHeader(user));

  it('starts unread and clears once read', async () => {
    const { target, messageId } = await seed();

    const before = await request(app).get('/api/messages/unread-count').set(authHeader(target));
    expect(before.body.unread).toBe(1);

    await markRead(target, messageId);

    const after = await request(app).get('/api/messages/unread-count').set(authHeader(target));
    expect(after.body.unread).toBe(0);
  });

  it('keeps the first timestamp when marked read twice', async () => {
    const { target, messageId } = await seed();

    const first = await markRead(target, messageId);
    const second = await markRead(target, messageId);

    expect(second.status).toBe(200);
    expect(second.body.readAt).toBe(first.body.readAt);
  });

  it('refuses to mark a message the caller cannot see', async () => {
    // Without the visibility check this would write a state row for someone else's message and inflate
    // its read receipt with a reader who was never an audience for it.
    const { messageId } = await seed();
    const outsider = createUser({ username: 'outsider' });

    const res = await markRead(outsider, messageId);

    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS c FROM message_states').get().c).toBe(0);
  });

  it('reports the read timestamp back in the inbox', async () => {
    const { target, messageId } = await seed();
    await markRead(target, messageId);

    const res = await inbox(target);
    expect(res.body.data[0].readAt).toBeTruthy();
  });
});

describe('dismissal', () => {
  it('removes the message from the inbox but keeps the receipt', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));
    const messageId = sent.body.data[0].id;

    await request(app).delete(`/api/messages/${messageId}`).set(authHeader(target));

    const mine = await inbox(target);
    expect(mine.body.data).toEqual([]);
    expect(mine.body.unread).toBe(0);

    const sentRes = await sentList(root);
    expect(sentRes.body.data[0].recipient.dismissedAt).toBeTruthy();
  });

  it('distinguishes dismissed-unread from read-then-dismissed', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));
    const messageId = sent.body.data[0].id;

    await request(app).delete(`/api/messages/${messageId}`).set(authHeader(target));

    const res = await sentList(root);
    expect(res.body.data[0].recipient.readAt).toBeNull();
    expect(res.body.data[0].recipient.dismissedAt).toBeTruthy();
  });

  it('refuses to dismiss a message the caller cannot see', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const outsider = createUser({ username: 'outsider' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));

    const res = await request(app)
      .delete(`/api/messages/${sent.body.data[0].id}`)
      .set(authHeader(outsider));

    expect(res.status).toBe(404);
  });

  it('hides only the dismissing user\'s copy of a broadcast', async () => {
    const root = admin();
    const quitter = createUser({ username: 'quitter' });
    const stayer = createUser({ username: 'stayer' });
    const sent = await send(root, compose({ subject: 'Notice', broadcast: true }));

    await request(app).delete(`/api/messages/${sent.body.data[0].id}`).set(authHeader(quitter));

    expect((await inbox(quitter)).body.data).toEqual([]);
    expect((await inbox(stayer)).body.data.map((m) => m.subject)).toEqual(['Notice']);
  });
});

describe('recall', () => {
  it('hides the message from the reader but keeps it on the sent list', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ subject: 'Oops', recipientIds: [target.id] }));

    const res = await request(app)
      .delete(`/api/messages/sent/${sent.body.data[0].id}`)
      .set(authHeader(root));

    expect(res.status).toBe(200);
    expect((await inbox(target)).body.data).toEqual([]);

    const list = await sentList(root);
    expect(list.body.data.map((m) => m.subject)).toEqual(['Oops']);
    expect(list.body.data[0].recalledAt).toBeTruthy();
  });

  it('drops a recalled message from the unread count', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));

    await request(app).delete(`/api/messages/sent/${sent.body.data[0].id}`).set(authHeader(root));

    const res = await request(app).get('/api/messages/unread-count').set(authHeader(target));
    expect(res.body.unread).toBe(0);
  });

  it('keeps the original timestamp when recalled twice', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));
    const url = `/api/messages/sent/${sent.body.data[0].id}`;

    const first = await request(app).delete(url).set(authHeader(root));
    const second = await request(app).delete(url).set(authHeader(root));

    expect(second.body.recalledAt).toBe(first.body.recalledAt);
  });

  it('404s an unknown message', async () => {
    const res = await request(app).delete('/api/messages/sent/no-such-id').set(authHeader(admin()));
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));

    const res = await request(app)
      .delete(`/api/messages/sent/${sent.body.data[0].id}`)
      .set(authHeader(target));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/messages/sent', () => {
  it('rejects a non-admin', async () => {
    const res = await sentList(createUser({ username: 'plain' }));
    expect(res.status).toBe(403);
  });

  it('reports read progress for a broadcast as a share of eligible accounts', async () => {
    const root = admin();
    const readers = [1, 2].map((n) => createUser({ username: `reader-${n}` }));
    createUser({ username: 'idler' });

    const sent = await send(root, compose({ broadcast: true }));
    const messageId = sent.body.data[0].id;

    for (const reader of readers) {
      await request(app).post(`/api/messages/${messageId}/read`).set(authHeader(reader));
    }

    const res = await sentList(root);
    expect(res.body.data[0].readCount).toBe(2);
    expect(res.body.data[0].eligibleCount).toBe(4); // 2 readers + idler + the admin
    expect(res.body.data[0].recipient).toBeNull();
  });

  it('counts only accounts that could see the broadcast', async () => {
    // The denominator is the eligible audience, not the user table — a later signup was never a reader.
    const root = admin({ createdAt: '2019-01-01 00:00:00' });
    const sent = await send(root, compose({ broadcast: true }));
    backdate(sent.body.data[0].id, '2020-01-01 00:00:00');
    createUser({ username: 'latecomer', createdAt: '2030-01-01 00:00:00' });

    const res = await sentList(root);
    expect(res.body.data[0].eligibleCount).toBe(1); // the admin only — the latecomer never saw it
  });

  it('reports a 1:1 message against its single recipient', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const sent = await send(root, compose({ recipientIds: [target.id] }));

    await request(app).post(`/api/messages/${sent.body.data[0].id}/read`).set(authHeader(target));

    const res = await sentList(root);
    expect(res.body.data[0].broadcast).toBe(false);
    expect(res.body.data[0].recipient.username).toBe('target');
    expect(res.body.data[0].recipient.readAt).toBeTruthy();
    expect(res.body.data[0].readCount).toBeNull();
  });

  it('narrows to one user\'s history without pulling in broadcasts', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const other = createUser({ username: 'other' });

    await send(root, compose({ subject: 'Yours', recipientIds: [target.id] }));
    await send(root, compose({ subject: 'Theirs', recipientIds: [other.id] }));
    await send(root, compose({ subject: 'Everyone', broadcast: true }));

    const res = await sentList(root, `?userId=${target.id}`);

    expect(res.body.data.map((m) => m.subject)).toEqual(['Yours']);
    expect(res.body.total).toBe(1);
  });

  describe('audience filter', () => {
    // Direct messages and broadcasts live in separate admin surfaces now, so each asks for its own half.
    const seedBoth = async () => {
      const root = admin();
      const target = createUser({ username: 'target' });
      await send(root, compose({ subject: 'Direct one', recipientIds: [target.id] }));
      await send(root, compose({ subject: 'Everyone', broadcast: true }));
      return root;
    };

    it('lists only direct messages', async () => {
      const res = await sentList(await seedBoth(), '?audience=direct');

      expect(res.body.data.map((m) => m.subject)).toEqual(['Direct one']);
      expect(res.body.total).toBe(1);
    });

    it('lists only broadcasts', async () => {
      const res = await sentList(await seedBoth(), '?audience=broadcast');

      expect(res.body.data.map((m) => m.subject)).toEqual(['Everyone']);
      expect(res.body.total).toBe(1);
    });

    it('lists everything when no audience is named', async () => {
      const res = await sentList(await seedBoth());

      expect(res.body.total).toBe(2);
    });

    it('ignores an unknown audience rather than failing', async () => {
      const res = await sentList(await seedBoth(), '?audience=nonsense');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    });

    it('lets a user filter win over the audience', async () => {
      const root = admin();
      const target = createUser({ username: 'target' });
      await send(root, compose({ subject: 'Direct one', recipientIds: [target.id] }));
      await send(root, compose({ subject: 'Everyone', broadcast: true }));

      // A contradictory pair must not return the broadcast under a user's history.
      const res = await sentList(root, `?userId=${target.id}&audience=broadcast`);

      expect(res.body.data.map((m) => m.subject)).toEqual(['Direct one']);
    });

    it('pages the filtered half, not the whole table', async () => {
      const root = admin();
      const target = createUser({ username: 'target' });
      for (let i = 0; i < 3; i++) await send(root, compose({ subject: `b-${i}`, broadcast: true }));
      for (let i = 0; i < 4; i++) await send(root, compose({ subject: `d-${i}`, recipientIds: [target.id] }));

      const res = await sentList(root, '?audience=broadcast&limit=2');

      expect(res.body.data).toHaveLength(2);
      expect(res.body.total).toBe(3);
    });
  });

  it('pages and reports the true total', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    for (let i = 0; i < 5; i++) {
      await send(root, compose({ subject: `note-${i}`, recipientIds: [target.id] }));
    }

    const res = await sentList(root, '?page=1&limit=2');

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });
});

describe('GET /api/messages', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(401);
  });

  it('clamps an absurd limit', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    await send(root, compose({ recipientIds: [target.id] }));

    const res = await request(app).get('/api/messages?limit=100000').set(authHeader(target));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(100);
  });

  it('never leaks a message the caller was not sent', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const outsider = createUser({ username: 'outsider' });
    await send(root, compose({ subject: 'Private', recipientIds: [target.id] }));

    const res = await inbox(outsider);

    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.unread).toBe(0);
  });
});

describe('suspended accounts', () => {
  const suspended = () => createUser({ username: 'benched', status: 'suspended' });

  it('can read the suspension notice', async () => {
    const root = admin();
    const user = suspended();
    await send(root, compose({ subject: 'You are suspended', recipientIds: [user.id], severity: 'urgent' }));

    const res = await inbox(user);

    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.subject)).toEqual(['You are suspended']);
  });

  it('can mark it read', async () => {
    // `protect` 403s every non-GET from a suspended account, which would leave the badge stuck forever.
    const root = admin();
    const user = suspended();
    const sent = await send(root, compose({ recipientIds: [user.id], severity: 'urgent' }));

    const res = await request(app)
      .post(`/api/messages/${sent.body.data[0].id}/read`)
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect((await request(app).get('/api/messages/unread-count').set(authHeader(user))).body.unread).toBe(0);
  });

  it('can dismiss it', async () => {
    const root = admin();
    const user = suspended();
    const sent = await send(root, compose({ recipientIds: [user.id], severity: 'urgent' }));

    const res = await request(app)
      .delete(`/api/messages/${sent.body.data[0].id}`)
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect((await inbox(user)).body.data).toEqual([]);
  });

  it('still cannot write anywhere else', async () => {
    // The relaxed middleware is scoped to the two message-state routes; everything else must keep
    // turning a suspended account away.
    const res = await request(app)
      .post('/api/worlds')
      .set(authHeader(suspended()))
      .send({ name: 'Nope' });

    expect(res.status).toBe(403);
  });

  it('cannot send messages even if somehow an admin', async () => {
    const suspendedAdmin = createUser({ username: 'fallen', accountType: 'admin', status: 'suspended' });
    const target = createUser({ username: 'target' });

    const res = await send(suspendedAdmin, compose({ recipientIds: [target.id] }));

    expect(res.status).toBe(403);
  });
});

describe('scope', () => {
  it('defaults to existing accounts only', async () => {
    const root = admin();
    const res = await send(root, compose({ broadcast: true }));

    expect(res.body.data[0].scope).toBe('existing');
  });

  it('lets a broadcast reach later signups without pinning it', async () => {
    // The welcome-message case: everyone gets it, and everyone can still clear it.
    const root = admin();
    const sent = await send(root, compose({ subject: 'Welcome', broadcast: true, scope: 'new' }));
    backdate(sent.body.data[0].id, '2020-01-01 00:00:00');
    const latecomer = createUser({ username: 'latecomer', createdAt: '2030-01-01 00:00:00' });

    const res = await inbox(latecomer);
    expect(res.body.data.map((m) => m.subject)).toEqual(['Welcome']);

    const dismissed = await request(app)
      .delete(`/api/messages/${sent.body.data[0].id}`)
      .set(authHeader(latecomer));
    expect(dismissed.status).toBe(200);
  });

  it('allows pinning a direct message', async () => {
    // Inverted rule: a 1:1 has no audience to widen, but making it permanent is meaningful.
    const root = admin();
    const target = createUser({ username: 'target' });
    const res = await send(root, compose({ recipientIds: [target.id], scope: 'pinned' }));

    expect(res.status).toBe(201);
    expect(res.body.data[0].scope).toBe('pinned');
  });
});

describe('pinned messages cannot be dismissed', () => {
  const seedPinned = async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'House rules', broadcast: true, scope: 'pinned' }));
    return { root, user, id: sent.body.data[0].id };
  };

  it('refuses the dismiss', async () => {
    const { user, id } = await seedPinned();

    const res = await request(app).delete(`/api/messages/${id}`).set(authHeader(user));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot be dismissed/i);
  });

  it('writes no dismissal row when refused', async () => {
    const { user, id } = await seedPinned();

    await request(app).delete(`/api/messages/${id}`).set(authHeader(user));

    const state = db.prepare('SELECT dismissed_at FROM message_states WHERE message_id = ?').get(id);
    expect(state ? state.dismissed_at : null).toBeNull();
  });

  it('refuses on a pinned direct message too', async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ recipientIds: [user.id], scope: 'pinned' }));

    const res = await request(app).delete(`/api/messages/${sent.body.data[0].id}`).set(authHeader(user));

    expect(res.status).toBe(403);
  });

  it('still lets the reader mark it read', async () => {
    // Permanent must not mean a badge that never clears.
    const { user, id } = await seedPinned();

    const res = await request(app).post(`/api/messages/${id}/read`).set(authHeader(user));

    expect(res.status).toBe(200);
    const unread = await request(app).get('/api/messages/unread-count').set(authHeader(user));
    expect(unread.body.unread).toBe(0);
  });
});

describe('pinning ignores an existing dismissal rather than erasing it', () => {
  /** Dismiss an unpinned broadcast, then raise it to pinned. */
  const dismissThenPin = async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'Guidelines', broadcast: true }));
    const id = sent.body.data[0].id;

    await request(app).delete(`/api/messages/${id}`).set(authHeader(user));
    await request(app)
      .put(`/api/messages/sent/${id}`)
      .set(authHeader(root))
      .send({ subject: 'Guidelines', body: 'A notice.', scope: 'pinned' });

    return { root, user, id };
  };

  it('brings the message back for someone who had cleared it', async () => {
    const { user } = await dismissThenPin();

    const res = await inbox(user);
    expect(res.body.data.map((m) => m.subject)).toEqual(['Guidelines']);
  });

  it('restores their dismissal when unpinned again', async () => {
    // The dismissal row was never deleted, so unpinning returns them to exactly the state they chose.
    const { root, user, id } = await dismissThenPin();

    await request(app)
      .put(`/api/messages/sent/${id}`)
      .set(authHeader(root))
      .send({ subject: 'Guidelines', body: 'A notice.', scope: 'existing' });

    const res = await inbox(user);
    expect(res.body.data).toEqual([]);
  });
});

describe('inbox ordering', () => {
  it('puts pinned messages above the stream, newest first within each group', async () => {
    const root = admin();
    // Predates every message below, so the `existing`-scoped one reaches them too.
    const user = createUser({ username: 'reader', createdAt: '2025-01-01 00:00:00' });

    const older = await send(root, compose({ subject: 'Old rule', broadcast: true, scope: 'pinned' }));
    const newer = await send(root, compose({ subject: 'New rule', broadcast: true, scope: 'pinned' }));
    const plain = await send(root, compose({ subject: 'Announcement', broadcast: true }));

    // Same-second sends would tie, so space them explicitly.
    backdate(older.body.data[0].id, '2026-01-01 00:00:00');
    backdate(newer.body.data[0].id, '2026-02-01 00:00:00');
    backdate(plain.body.data[0].id, '2026-06-01 00:00:00');

    const res = await inbox(user);

    expect(res.body.data.map((m) => m.subject)).toEqual(['New rule', 'Old rule', 'Announcement']);
  });
});

describe('PUT /api/messages/sent/:id', () => {
  const seed = async (over = {}) => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'Original', body: 'First draft.', ...over }));
    return { root, user, id: sent.body.data[0].id };
  };

  const edit = (adminUser, id, payload) =>
    request(app).put(`/api/messages/sent/${id}`).set(authHeader(adminUser)).send(payload);

  it('rejects a non-admin', async () => {
    const { user, id } = await seed({ broadcast: true });

    const res = await edit(user, id, { subject: 'Hacked', body: 'x' });

    expect(res.status).toBe(403);
  });

  it('404s an unknown message', async () => {
    const res = await edit(admin(), 'no-such-id', { subject: 'x', body: 'y' });
    expect(res.status).toBe(404);
  });

  it('rewrites the text readers see', async () => {
    const { root, user, id } = await seed({ broadcast: true });

    await edit(root, id, { subject: 'Corrected', body: 'Second draft.' });

    const res = await inbox(user);
    expect(res.body.data[0].subject).toBe('Corrected');
    expect(res.body.data[0].body).toBe('Second draft.');
  });

  it('stamps an edit date readers can see', async () => {
    const { root, user, id } = await seed({ broadcast: true });

    await edit(root, id, { subject: 'Corrected', body: 'Second draft.' });

    const res = await inbox(user);
    expect(res.body.data[0].editedAt).toBeTruthy();
  });

  it('leaves an unedited message with no edit date', async () => {
    const { user } = await seed({ broadcast: true });

    const res = await inbox(user);
    expect(res.body.data[0].editedAt).toBeNull();
  });

  it('lets a second admin re-sign it', async () => {
    const { root, user, id } = await seed({ broadcast: true });

    await edit(root, id, { subject: 'Original', body: 'First draft.', senderAs: 'username' });

    const res = await inbox(user);
    expect(res.body.data[0].senderName).toBe('root-admin');
  });

  it('applies the same validation as sending', async () => {
    const { root, id } = await seed({ broadcast: true });

    const res = await edit(root, id, { subject: '', body: 'x' });

    expect(res.status).toBe(400);
  });

  it('refuses to widen a direct message to new accounts', async () => {
    const root = admin();
    const target = createUser({ username: 'target' });
    const direct = await send(root, compose({ recipientIds: [target.id] }));

    const res = await edit(root, direct.body.data[0].id, { subject: 'x', body: 'y', scope: 'new' });

    expect(res.status).toBe(400);
  });

  it('refuses to edit a recalled message', async () => {
    const { root, id } = await seed({ broadcast: true });
    await request(app).delete(`/api/messages/sent/${id}`).set(authHeader(root));

    const res = await edit(root, id, { subject: 'x', body: 'y' });

    expect(res.status).toBe(409);
  });
});

describe('edit re-notification', () => {
  const seedRead = async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'Notice', broadcast: true }));
    const id = sent.body.data[0].id;
    await request(app).post(`/api/messages/${id}/read`).set(authHeader(user));
    return { root, user, id };
  };

  const unreadFor = async (user) =>
    (await request(app).get('/api/messages/unread-count').set(authHeader(user))).body.unread;

  it('leaves it read by default', async () => {
    // Most edits are typo fixes; re-badging everyone for one would be noise.
    const { root, user, id } = await seedRead();

    await request(app).put(`/api/messages/sent/${id}`).set(authHeader(root))
      .send({ subject: 'Notice', body: 'Fixed typo.' });

    expect(await unreadFor(user)).toBe(0);
  });

  it('marks it unread again when asked', async () => {
    const { root, user, id } = await seedRead();

    await request(app).put(`/api/messages/sent/${id}`).set(authHeader(root))
      .send({ subject: 'Notice', body: 'Materially different.', renotify: true });

    expect(await unreadFor(user)).toBe(1);
  });

  it('resets the read receipts so the count reflects the new text', async () => {
    const { root, id } = await seedRead();
    expect((await sentList(root)).body.data[0].readCount).toBe(1);

    await request(app).put(`/api/messages/sent/${id}`).set(authHeader(root))
      .send({ subject: 'Notice', body: 'Materially different.', renotify: true });

    expect((await sentList(root)).body.data[0].readCount).toBe(0);
  });

  it('brings the message back for someone who had dismissed it', async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'Notice', broadcast: true }));
    const id = sent.body.data[0].id;
    await request(app).delete(`/api/messages/${id}`).set(authHeader(user));
    expect((await inbox(user)).body.data).toEqual([]);

    await request(app).put(`/api/messages/sent/${id}`).set(authHeader(root))
      .send({ subject: 'Notice', body: 'Materially different.', renotify: true });

    expect((await inbox(user)).body.data.map((m) => m.subject)).toEqual(['Notice']);
  });

  it('leaves a dismissal alone without renotify', async () => {
    const root = admin();
    const user = createUser({ username: 'reader' });
    const sent = await send(root, compose({ subject: 'Notice', broadcast: true }));
    const id = sent.body.data[0].id;
    await request(app).delete(`/api/messages/${id}`).set(authHeader(user));

    await request(app).put(`/api/messages/sent/${id}`).set(authHeader(root))
      .send({ subject: 'Notice', body: 'Fixed typo.' });

    expect((await inbox(user)).body.data).toEqual([]);
  });
});

describe('when the sending admin’s account is deleted', () => {
  it('leaves their messages in every inbox', async () => {
    // Cascading would pull a suspension notice out of an inbox while the suspension itself stood.
    const root = admin();
    const user = createUser({ username: 'reader' });
    await send(root, compose({ subject: 'Still here', broadcast: true }));

    db.prepare('DELETE FROM users WHERE id = ?').run(root.id);

    expect((await inbox(user)).body.data.map((m) => m.subject)).toEqual(['Still here']);
  });

  it('falls back to the team signature for one they had signed', async () => {
    // The name is resolved by join, so an unlinked sender reads as the team rather than as nobody.
    const root = admin();
    const user = createUser({ username: 'reader' });
    await send(root, compose({ subject: 'Signed', broadcast: true, senderAs: 'username' }));

    db.prepare('DELETE FROM users WHERE id = ?').run(root.id);

    expect((await inbox(user)).body.data[0].senderName).toBeNull();
  });

  it('keeps it on the sent list for the admins who remain', async () => {
    const root = admin();
    const second = createUser({ username: 'other-admin', accountType: 'admin' });
    await send(root, compose({ subject: 'Still listed', broadcast: true }));

    db.prepare('DELETE FROM users WHERE id = ?').run(root.id);

    expect((await sentList(second)).body.data.map((m) => m.subject)).toEqual(['Still listed']);
  });
});
