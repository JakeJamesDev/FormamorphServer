import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload, fromAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const Setting = require('../src/models/Setting');
const { ANONYMOUS_LIKES, INSTALL_HEADER_NAME } = require('../src/config/anonymousLikes');
const { NETWORK_KIND } = require('../src/config/networkKind');
const { networkClassifier } = require('../src/utils/networkClassifier');

/**
 * A fresh install: collection on, and no list ever loaded.
 *
 * A file of its own, so its worker's classifier has never seen a list. `networkKind.test.js` loads them.
 */

describe('liking before any network list is loaded', () => {
  it('accepts both likes and stores no kind', async () => {
    Setting.set(NETWORK_KIND, true);
    Setting.set(ANONYMOUS_LIKES, true);
    const author = createUser({ username: 'fresh-author' });
    const reader = createUser({ username: 'fresh-reader' });
    const id = (await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload())).body.data.id;
    const installId = crypto.randomUUID();

    const account = await fromAddress('192.0.2.10', request(app).put(`/api/worlds/${id}/like`).set(authHeader(reader)))
      .send({ liked: true });
    const anonymous = await fromAddress('192.0.2.10', request(app).put(`/api/worlds/${id}/anonymous-like`))
      .set(INSTALL_HEADER_NAME, installId).send({ liked: true });

    expect(networkClassifier.loadedAt()).toEqual({});
    expect(account.status).toBe(200);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.data).toEqual({ liked: true, likes: 2 });
    expect(db.prepare('SELECT network_kind FROM world_likes WHERE world_id = ?').get(id).network_kind).toBeNull();
    expect(db.prepare('SELECT network_kind FROM anonymous_likes WHERE world_id = ?').get(id).network_kind).toBeNull();
  });
});
