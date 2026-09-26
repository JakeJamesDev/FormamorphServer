import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import { app, db, paths } from './context.js';
import { createUser, authHeader } from './helpers.js';
import { makeVrm1, makeVrm0 } from './glbFixture.js';

const require = createRequire(import.meta.url);
const { sha256Hex, loadBundledFingerprints } = require('../src/utils/bundledFingerprint');

const REFUSAL = 'This is the default avatar. Upload your own VRM.';

const PASSING_META = {
  avatarPermission: 'everyone',
  allowRedistribution: true,
  modification: 'allowModificationRedistribution',
  commercialUsage: 'corporation',
};

// The test list (vitest.config) holds the byte hashes of these two files and no others.
const DEFAULT_AVATAR = makeVrm1({ ...PASSING_META, name: 'Fixture Default Avatar' });
// Fails the license gate, so a refusal with the default Avatar message proves the hash check runs first.
const OLD_DEFAULT_AVATAR = makeVrm0({ title: 'Fixture Old Default Avatar' });
const OWN_AVATAR = makeVrm1(PASSING_META);

const avatarContent = (bytes) => ({
  vrm: `data:model/vnd.vrm;base64,${bytes.toString('base64')}`,
  license: { metaVersion: '1', ...PASSING_META },
  hash: 'h',
});

const publishAvatar = (user, bytes) =>
  request(app)
    .post('/api/worlds')
    .set(authHeader(user))
    .send({ name: 'Avatar', kind: 'model', contentData: avatarContent(bytes) });

const updateAvatar = (user, id, bytes) =>
  request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send({ contentData: avatarContent(bytes) });

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;

describe('the test fingerprint list', () => {
  // A change to glbFixture changes these bytes; regenerate the list's hashes from them.
  it('holds the byte hashes of the fixture default Avatars', () => {
    const { avatars } = loadBundledFingerprints(paths.BUNDLED_FINGERPRINTS_PATH);
    expect(avatars).toEqual(new Set([sha256Hex(DEFAULT_AVATAR), sha256Hex(OLD_DEFAULT_AVATAR)]));
  });
});

describe('publishing the default Avatar', () => {
  it('refuses it and stores nothing', async () => {
    const res = await publishAvatar(createUser(), DEFAULT_AVATAR);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REFUSAL });
    expect(rowCount()).toBe(0);
  });

  it('refuses it before the license gate runs', async () => {
    const res = await publishAvatar(createUser(), OLD_DEFAULT_AVATAR);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REFUSAL });
  });

  it('refuses an update that replaces a listing with it', async () => {
    const user = createUser();
    const created = await publishAvatar(user, OWN_AVATAR);

    const res = await updateAvatar(user, created.body.data.id, DEFAULT_AVATAR);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REFUSAL });
    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.contentData.vrm).toBe(avatarContent(OWN_AVATAR).vrm);
  });

  it('accepts any other permissive VRM', async () => {
    const res = await publishAvatar(createUser(), OWN_AVATAR);

    expect(res.status).toBe(201);
  });
});
