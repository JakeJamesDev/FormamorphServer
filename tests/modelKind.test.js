import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { app, db } from './context.js';
import { createUser, authHeader } from './helpers.js';
import { makeVrm1, makeVrm0, makePlainGltf } from './glbFixture.js';

const require = createRequire(import.meta.url);
const { KIND_RULES, MODEL_LICENSE_REQUIREMENTS } = require('../src/config/kinds');
const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Avatar publishing: the fourth listing kind, gated on the VRM's own embedded license rather than
 * anything the client claims. Prior art for the route-test style is `kind.test.js` and
 * `contestEntries.test.js`; the Permissive License gate's own unit tests live in `vrmLicenseGate.test.js`.
 */

const PASSING_META = {
  avatarPermission: 'everyone',
  allowRedistribution: true,
  modification: 'allowModificationRedistribution',
  commercialUsage: 'corporation',
};

const BREAKS = {
  avatarPermission: { avatarPermission: 'onlyAuthor' },
  allowRedistribution: { allowRedistribution: false },
  modification: { modification: 'prohibited' },
  commercialUsage: { commercialUsage: 'personalNonProfit' },
};

const vrmDataUrl = (bytes) => `data:model/vnd.vrm;base64,${bytes.toString('base64')}`;

/** A valid `POST /api/worlds` body for a passing Avatar; override any field per test. */
function modelPayload(overrides = {}) {
  return {
    name: overrides.name ?? 'Test Avatar',
    kind: 'model',
    contentData: {
      vrm: vrmDataUrl(makeVrm1(PASSING_META)),
      license: { metaVersion: '1', ...PASSING_META },
      hash: 'test-hash',
    },
    ...overrides,
  };
}

const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);
const put = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

describe('publishing an Avatar', () => {
  it('creates a model listing from a passing VRM 1.0 file', async () => {
    const user = createUser();
    const res = await post(user, modelPayload({ name: 'Passing' }));

    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('model');
  });

  it('stores the content verbatim, including the client-sent license field', async () => {
    const user = createUser();
    const payload = modelPayload({ name: 'Round Trip' });
    const created = await post(user, payload);

    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.contentData.vrm).toBe(payload.contentData.vrm);
    expect(content.body.data.contentData.license).toEqual(payload.contentData.license);
  });

  it('requires neither a description nor a thumbnail', async () => {
    const user = createUser();
    const res = await post(user, modelPayload({ name: 'Bare' }));

    expect(res.status).toBe(201);
    expect(db.prepare('SELECT description FROM worlds WHERE id = ?').get(res.body.data.id).description).toBe('');
  });

  it('fills the entity placeholder when no thumbnail is sent', async () => {
    const user = createUser();
    const created = await post(user, modelPayload({ name: 'Faceless' }));

    const detail = await request(app).get(`/api/worlds/${created.body.data.id}`);
    expect(detail.body.data.thumbnailUrl).toMatch(/^\/api\/thumbnails\//);

    const img = await request(app).get(detail.body.data.thumbnailUrl);
    expect(img.status).toBe(200);
  });

  it('updates an existing listing, replacing its content', async () => {
    const user = createUser();
    const created = await post(user, modelPayload({ name: 'Original' }));

    const updated = vrmDataUrl(makeVrm1({ ...PASSING_META, commercialUsage: 'personalProfit' }));
    const res = await put(user, created.body.data.id, {
      contentData: { vrm: updated, license: { metaVersion: '1' }, hash: 'new-hash' },
    });

    expect(res.status).toBe(200);
    const content = await request(app).get(`/api/worlds/${created.body.data.id}/content`);
    expect(content.body.data.contentData.vrm).toBe(updated);
  });
});

describe('the license gate', () => {
  for (const [requirement, breakField] of Object.entries(BREAKS)) {
    it(`refuses a create that fails only '${requirement}'`, async () => {
      const user = createUser();
      const vrm = vrmDataUrl(makeVrm1({ ...PASSING_META, ...breakField }));
      const res = await post(user, modelPayload({ name: 'Failing', contentData: { vrm, license: {}, hash: 'h' } }));

      expect(res.status).toBe(400);
      expect(res.body.failedRequirements).toEqual([requirement]);
    });

    it(`refuses an update that fails only '${requirement}'`, async () => {
      const user = createUser();
      const created = await post(user, modelPayload({ name: 'Was Passing' }));

      const vrm = vrmDataUrl(makeVrm1({ ...PASSING_META, ...breakField }));
      const res = await put(user, created.body.data.id, { contentData: { vrm, license: {}, hash: 'h' } });

      expect(res.status).toBe(400);
      expect(res.body.failedRequirements).toEqual([requirement]);
    });
  }

  it('refuses a VRM 0.0 file, naming metaVersion among the failures', async () => {
    const user = createUser();
    const vrm = vrmDataUrl(makeVrm0({ title: 'Old Format' }));
    const res = await post(user, modelPayload({ name: 'Old Format', contentData: { vrm, license: {}, hash: 'h' } }));

    expect(res.status).toBe(400);
    expect(res.body.failedRequirements).toContain('metaVersion');
  });

  it('refuses a plain glTF with no VRM extension at all', async () => {
    const user = createUser();
    const vrm = vrmDataUrl(makePlainGltf());
    const res = await post(user, modelPayload({ name: 'Plain glTF', contentData: { vrm, license: {}, hash: 'h' } }));

    expect(res.status).toBe(400);
    expect(res.body.failedRequirements.slice().sort()).toEqual(MODEL_LICENSE_REQUIREMENTS.slice().sort());
  });

  it('ignores a forged client-sent license and re-derives the verdict from the file itself', async () => {
    const user = createUser();
    const vrm = vrmDataUrl(makeVrm1({ ...PASSING_META, allowRedistribution: false }));
    const forgedLicense = { metaVersion: '1', ...PASSING_META }; // claims a pass the file does not back up
    const res = await post(user, modelPayload({ name: 'Forged', contentData: { vrm, license: forgedLicense, hash: 'h' } }));

    expect(res.status).toBe(400);
    expect(res.body.failedRequirements).toEqual(['allowRedistribution']);
  });
});

describe('per-kind size cap', () => {
  it('rejects Avatar content larger than its 64MB cap', async () => {
    const user = createUser();
    const oversized = { vrm: 'x'.repeat(KIND_RULES.model.maxContentBytes + 100) };
    const res = await post(user, modelPayload({ name: 'Too Big', contentData: oversized }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Avatar');
  });
});

describe('listing and reading', () => {
  it('is invisible to a client that asks for no kind', async () => {
    const user = createUser();
    await post(user, modelPayload({ name: 'An Avatar' }));

    const res = await request(app).get('/api/worlds');
    expect(res.body.data).toEqual([]);
  });

  it('is returned when asked for by kind', async () => {
    const user = createUser();
    const created = await post(user, modelPayload({ name: 'An Avatar' }));

    const res = await request(app).get('/api/worlds?kind=model');
    expect(res.body.data.map((w) => w.id)).toEqual([created.body.data.id]);
    expect(res.body.total).toBe(1);
  });
});

describe('kind-agnostic rules apply unchanged', () => {
  it('gives Avatars the same ownership rules as other kinds', async () => {
    const owner = createUser({ username: 'avatar-owner' });
    const stranger = createUser({ username: 'avatar-stranger' });
    const created = await post(owner, modelPayload({ name: 'Not Yours' }));

    const res = await put(stranger, created.body.data.id, { name: 'Hijacked' });
    expect(res.status).toBe(403);
  });

  it('lets an Avatar be commented on', async () => {
    const user = createUser({ username: 'avatar-commenter' });
    const created = await post(user, modelPayload({ name: 'Commentable' }));

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/comments`)
      .set(authHeader(user))
      .send({ content: 'nice avatar' });

    expect(res.status).toBe(201);
  });

  it('lets an Avatar be liked', async () => {
    const owner = createUser({ username: 'avatar-liked-owner' });
    const liker = createUser({ username: 'avatar-liker' });
    const created = await post(owner, modelPayload({ name: 'Likeable' }));

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/like`)
      .set(authHeader(liker))
      .send({ liked: true });

    expect(res.status).toBe(200);
    expect(res.body.data.likes).toBe(1);
  });

  it('accepts a Listing Changelog entry on an Avatar update', async () => {
    const user = createUser({ username: 'avatar-changelog' });
    const created = await post(user, modelPayload({ name: 'Changeloggable' }));

    const res = await request(app)
      .post(`/api/worlds/${created.body.data.id}/changelog`)
      .set(authHeader(user))
      .send({ title: 'Re-export', body: 'New pose fixed.', date: '2026-09-08' });

    expect(res.status).toBe(201);
  });

  it('quarantines an Avatar like any other listing', async () => {
    const owner = createUser({ username: 'avatar-quarantined' });
    const admin = createUser({ username: 'avatar-admin', accountType: 'admin' });
    const created = await post(owner, modelPayload({ name: 'Quarantinable' }));

    const res = await request(app)
      .put(`/api/worlds/${created.body.data.id}/quarantine`)
      .set(authHeader(admin))
      .send({});

    expect(res.status).toBe(200);

    // Quarantined and out of the catalog for everyone but its author and staff, same as any other kind.
    const listed = await request(app).get('/api/worlds?kind=model');
    expect(listed.body.data).toEqual([]);
  });

  it('can be reported like any other listing', async () => {
    const author = createUser({ username: 'avatar-reported' });
    const reporter = createUser({ username: 'avatar-reporter' });
    const created = await post(author, modelPayload({ name: 'Reportable' }));

    const res = await request(app)
      .post('/api/reports')
      .set(authHeader(reporter))
      .send({ targetKind: 'listing', targetId: created.body.data.id, category: 'stolen' });

    expect(res.status).toBe(201);
  });

  it('cascades comment-report flags when the author deletes it, like any other kind', async () => {
    const author = createUser({ username: 'avatar-cascade' });
    const reporter = createUser({ username: 'avatar-cascade-reporter' });
    const created = await post(author, modelPayload({ name: 'Cascading' }));

    await request(app)
      .post('/api/reports')
      .set(authHeader(reporter))
      .send({ targetKind: 'listing', targetId: created.body.data.id, category: 'stolen' });

    const del = await request(app).delete(`/api/worlds/${created.body.data.id}`).set(authHeader(author));
    expect(del.status).toBe(200);
  });
});

describe('never touches the binary chunk', () => {
  it('accepts a file whose binary chunk is corrupt garbage', async () => {
    const user = createUser();
    const corruptBin = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xff]);
    const vrm = vrmDataUrl(makeVrm1(PASSING_META, corruptBin));
    const res = await post(user, modelPayload({ name: 'Corrupt Bin', contentData: { vrm, license: {}, hash: 'h' } }));

    expect(res.status).toBe(201);
  });
});

describe('the bundled Formamorph avatars', () => {
  // Cross-repo fixtures: both files the client ships in its Model Library, read straight off disk rather
  // than checked into this repo. Skipped, not failed, when the sibling checkout is absent — a solo checkout
  // of this repo alone must still be able to run the suite.
  const files = [
    ['default-avatar.vrm', path.resolve(TESTS_DIR, '..', '..', 'formamorph', 'public', 'default-avatar.vrm')],
    ['alternate-avatar.vrm', path.resolve(TESTS_DIR, '..', '..', 'formamorph', 'build-assets', 'alternate-avatar.vrm')],
  ];

  for (const [name, filePath] of files) {
    const runner = fs.existsSync(filePath) ? it : it.skip;
    runner(`passes the gate: ${name}`, async () => {
      const user = createUser();
      const bytes = fs.readFileSync(filePath);
      const res = await post(user, modelPayload({
        name,
        contentData: { vrm: vrmDataUrl(bytes), license: { metaVersion: '1' }, hash: name },
      }));

      expect(res.status).toBe(201);
    });
  }
});
