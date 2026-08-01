import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader } from './helpers.js';

/**
 * The badge on the main-menu profile circle is colored by the loudest thing waiting, so the count
 * endpoint has to say what that is. It rides along with the number rather than arriving separately:
 * two round trips to draw one circle would leave a window where the color and the count disagree.
 */

const admin = () => createUser({ username: `root-${Math.random().toString(36).slice(2, 8)}`, accountType: 'admin' });

const sendTo = (sender, target, severity) =>
  request(app).post('/api/messages')
    .set(authHeader(sender))
    .send({ subject: 'A notice', body: 'Something happened.', recipientIds: [target.id], severity });

const summary = async (user) =>
  (await request(app).get('/api/messages/unread-count').set(authHeader(user))).body;

describe('what the badge is told', () => {
  it('says nothing is waiting, and gives no severity for it', async () => {
    // Null rather than 'info': a caller should not have to know which severity meant "none".
    const reader = createUser();

    expect(await summary(reader)).toMatchObject({ unread: 0, topSeverity: null });
  });

  it('reports the severity of the one thing waiting', async () => {
    const root = admin();
    const reader = createUser();
    await sendTo(root, reader, 'warning');

    expect(await summary(reader)).toMatchObject({ unread: 1, topSeverity: 'warning' });
  });

  it('takes the loudest when several are waiting, not the newest', async () => {
    // The badge is one color for a stack of things; it should be the color of the worst of them.
    const root = admin();
    const reader = createUser();
    await sendTo(root, reader, 'urgent');
    await sendTo(root, reader, 'info');

    expect(await summary(reader)).toMatchObject({ unread: 2, topSeverity: 'urgent' });
  });

  it('ranks warning above info', async () => {
    const root = admin();
    const reader = createUser();
    await sendTo(root, reader, 'info');
    await sendTo(root, reader, 'warning');

    expect((await summary(reader)).topSeverity).toBe('warning');
  });

  it('ranks urgent above warning', async () => {
    const root = admin();
    const reader = createUser();
    await sendTo(root, reader, 'warning');
    await sendTo(root, reader, 'urgent');

    expect((await summary(reader)).topSeverity).toBe('urgent');
  });

  it('drops back down once the loudest is read', async () => {
    // Otherwise the circle stays red over an inbox holding nothing but an ordinary notice.
    const root = admin();
    const reader = createUser();
    const urgent = (await sendTo(root, reader, 'urgent')).body.data[0].id;
    await sendTo(root, reader, 'info');

    await request(app).post(`/api/messages/${urgent}/read`).set(authHeader(reader));

    expect(await summary(reader)).toMatchObject({ unread: 1, topSeverity: 'info' });
  });

  it('ignores a message that is read, however loud it was', async () => {
    const root = admin();
    const reader = createUser();
    const urgent = (await sendTo(root, reader, 'urgent')).body.data[0].id;

    await request(app).post(`/api/messages/${urgent}/read`).set(authHeader(reader));

    expect(await summary(reader)).toMatchObject({ unread: 0, topSeverity: null });
  });

  it('ignores somebody else’s mail', async () => {
    const root = admin();
    const reader = createUser();
    await sendTo(root, createUser(), 'urgent');

    expect(await summary(reader)).toMatchObject({ unread: 0, topSeverity: null });
  });
});
