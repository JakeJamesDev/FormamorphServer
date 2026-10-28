import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { app, request, paths } from './context.js';
import { createUser, authHeader, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const PatreonLink = require('../src/models/PatreonLink');
const WatermarkMark = require('../src/models/WatermarkMark');
const { embed } = require('../src/utils/watermark');
const { unscramble, VERSION } = require('../src/utils/scramble');
const { PROCESSING_VERSION } = require('../src/utils/supporterProcessing');
const { sweepQuarantine } = require('../src/utils/sweepQuarantine');
const deleteUser = require('../src/utils/deleteUser');
const World = require('../src/models/World');

/**
 * The per-account step on the gated route and the staff review route, on Morphie's real layers: each image
 * layer arrives scrambled and marked for the requesting account, from a cache keyed by account and revision.
 */

const MORPHIE = path.join(fileURLToPath(new URL('..', import.meta.url)), 'tests/fixtures/morphie');
const LAYER_FILES = fs.readdirSync(MORPHIE).filter((name) => name.endsWith('.webp')).sort();
const dataUrl = (file) => `data:image/webp;base64,${fs.readFileSync(path.join(MORPHIE, file)).toString('base64')}`;

// Morphie's 26 layers, plus the card's embedded Initial render, which counts as a layer.
const mascotContent = () => ({
  rig: { parts: ['base', 'eyes'] },
  voice: { pitch: 1 },
  transition: 'fade',
  layers: Object.fromEntries(LAYER_FILES.map((file) => [file.replace('.webp', ''), dataUrl(file)])),
  initialRender: dataUrl('base.webp')
});

const staffUser = () => createUser({ accountType: 'admin' });

const supporter = () => {
  const user = createUser();
  PatreonLink.link({
    userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00',
    checkedAt: new Date().toISOString()
  });
  return user;
};

const publishFlagged = async (author = createUser()) => {
  const created = await request(app).post('/api/worlds').set(authHeader(author))
    .send({ name: 'Exclusive', kind: 'mascot', thumbnail: TINY_PNG, contentData: mascotContent() });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  expect((await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staffUser())).send({ supporterOnly: true })).status).toBe(200);
  return { id, author };
};

const gated = (id, user) => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(user));

const decodePng = async (url) => {
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
};

/** The layer as the client rebuilds it. */
const unscrambled = async (layer) => unscramble(await decodePng(layer.dataUrl), layer);

const sourceLayer = async (file) => {
  const { data, info } = await sharp(path.join(MORPHIE, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};

/** Every served layer with the file it came from; the card's Initial render is the base layer. */
const layersOf = (content) => [
  ...Object.entries(content.layers).map(([name, layer]) => [`${name}.webp`, layer]),
  ['base.webp', content.initialRender]
];

/** The layer, unscrambled, is exactly the source marked for the account. */
const expectMarkedFor = async (file, layer, userId) => {
  const restored = await unscrambled(layer);
  const expected = embed(await sourceLayer(file), WatermarkMark.markFor(userId));
  expect(restored.width).toBe(expected.width);
  expect(restored.height).toBe(expected.height);
  expect(Buffer.from(restored.data).equals(Buffer.from(expected.data.buffer))).toBe(true);
};

/** A flagged Mascot and a Supporter's first (cold) response for it. */
const served = async () => {
  const listing = await publishFlagged();
  const member = supporter();
  const response = await gated(listing.id, member);
  expect(response.status).toBe(200);
  return { ...listing, member, response, content: response.body.data.contentData };
};

describe('an image layer on the gated route', () => {
  it('unscrambles to the source marked for the requesting account, for every layer', async () => {
    const { member, content } = await served();
    const layers = layersOf(content);
    expect(layers).toHaveLength(LAYER_FILES.length + 1);

    for (const [file, layer] of layers) await expectMarkedFor(file, layer, member.id);
  }, 120000);

  it('carries the seed, format version and original size beside each layer', async () => {
    const { content } = await served();

    for (const [name, layer] of Object.entries(content.layers)) {
      const source = await sourceLayer(`${name}.webp`);
      expect(layer).toEqual({
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        seed: expect.any(Number),
        version: VERSION,
        sourceWidth: source.width,
        sourceHeight: source.height
      });
    }
  });

  it('leaves the scrambled copy unlike the layer it hides', async () => {
    const { content } = await served();
    const scrambled = await decodePng(content.layers.base.dataUrl);
    const plain = await sourceLayer('base.webp');

    expect(scrambled.width % 8).toBe(0);
    expect(Buffer.from(scrambled.data).equals(Buffer.from(plain.data.buffer))).toBe(false);
  }, 120000);

  it('gives two accounts different seeds and different marks', async () => {
    const { id, member, content } = await served();
    const other = supporter();
    const theirs = (await gated(id, other)).body.data.contentData.layers.base;

    expect(theirs.seed).not.toBe(content.layers.base.seed);
    expect(WatermarkMark.markFor(other.id)).not.toBe(WatermarkMark.markFor(member.id));
    await expectMarkedFor('base.webp', theirs, other.id);
  }, 120000);

  it('passes everything that is not an image through unchanged', async () => {
    const { rig, voice, transition } = (await served()).content;

    expect({ rig, voice, transition }).toEqual({ rig: { parts: ['base', 'eyes'] }, voice: { pitch: 1 }, transition: 'fade' });
  }, 120000);

  it('leaves a string that only looks like an image, and a non-image data URL, as they were', async () => {
    const author = createUser();
    const created = await request(app).post('/api/worlds').set(authHeader(author)).send({
      name: 'Odd', kind: 'mascot', thumbnail: TINY_PNG,
      contentData: { note: 'data:text/plain;base64,aGk=', broken: 'data:image/webp;base64,AAAA', plain: 'hello' }
    });
    const id = created.body.data.id;
    await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staffUser())).send({ supporterOnly: true });

    const res = await gated(id, supporter());

    expect(res.body.data.contentData).toEqual({ note: 'data:text/plain;base64,aGk=', broken: 'data:image/webp;base64,AAAA', plain: 'hello' });
  });
});

describe('the cache', () => {
  const cacheFiles = (id) => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).filter((name) => name.startsWith(`processed-${id}-`));

  it('serves a second request for the same revision from the cache', async () => {
    const { id, member } = await served();
    const [file] = cacheFiles(id);
    fs.writeFileSync(path.join(paths.SUPPORTER_PRIVATE_DIR, file), JSON.stringify({ fromCache: true }));

    expect((await gated(id, member)).body.data.contentData).toEqual({ fromCache: true });
  }, 120000);

  it('times the cold and the cached request on Morphie-sized content', async () => {
    const listing = await publishFlagged();
    const member = supporter();

    let started = performance.now();
    await gated(listing.id, member);
    const cold = performance.now() - started;
    started = performance.now();
    await gated(listing.id, member);
    const cached = performance.now() - started;

    console.log(`Morphie-sized gated request: cold ${Math.round(cold)} ms, cached ${Math.round(cached)} ms`);
    expect(cached).toBeLessThan(cold / 2);
  }, 120000);

  it('drops the old revision\'s cache when the revision changes, and marks the new copy', async () => {
    const { id, author, member, content: before } = await served();
    const [oldFile] = cacheFiles(id);

    const update = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: { ...mascotContent(), transition: 'slide' } });
    expect(update.status).toBe(200);
    const after = (await gated(id, member)).body.data.contentData;

    expect(after.transition).toBe('slide');
    expect(after.layers.base.seed).not.toBe(before.layers.base.seed);
    expect(cacheFiles(id)).toHaveLength(1);
    expect(cacheFiles(id)).not.toContain(oldFile);
    await expectMarkedFor('base.webp', after.layers.base, member.id);
  }, 120000);
});

describe('the cache lifecycle', () => {
  const cacheFiles = (id) => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).filter((name) => name.startsWith(`processed-${id}-`));
  const accountFiles = (userId) => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR)
    .filter((name) => name.startsWith('processed-') && name.endsWith(`-${userId}.json`));

  it('never serves a copy made under another processing version', async () => {
    const { id, member } = await served();
    const [current] = cacheFiles(id);
    expect(current).toContain(`-v${PROCESSING_VERSION}-`);
    const stale = current.replace(`-v${PROCESSING_VERSION}-`, '-v000000000000-');
    fs.renameSync(path.join(paths.SUPPORTER_PRIVATE_DIR, current), path.join(paths.SUPPORTER_PRIVATE_DIR, stale));
    fs.writeFileSync(path.join(paths.SUPPORTER_PRIVATE_DIR, stale), JSON.stringify({ fromCache: true }));

    const again = (await gated(id, member)).body.data.contentData;

    expect(again.fromCache).toBeUndefined();
    await expectMarkedFor('base.webp', again.layers.base, member.id);
    expect(cacheFiles(id)).toEqual([current]);
  }, 120000);

  it('deletes only the erased account\'s files when a Supporter is erased', async () => {
    const { id, member } = await served();
    const other = supporter();
    await gated(id, other);
    expect(accountFiles(member.id)).toHaveLength(1);

    await deleteUser(member.username, { keepContent: true });

    expect(accountFiles(member.id)).toHaveLength(0);
    expect(accountFiles(other.id)).toHaveLength(1);
  }, 120000);

  it('deletes a listing\'s files when its author is erased with the content', async () => {
    const { id, author } = await served();
    expect(cacheFiles(id)).toHaveLength(1);

    await deleteUser(author.username);

    expect(cacheFiles(id)).toHaveLength(0);
  }, 120000);

  it('deletes a listing\'s files when the author deletes it', async () => {
    const { id, author } = await served();

    expect((await request(app).delete(`/api/worlds/${id}`).set(authHeader(author))).status).toBe(200);

    expect(cacheFiles(id)).toHaveLength(0);
  }, 120000);

  it('deletes a listing\'s files when its quarantine expires', async () => {
    const { id } = await served();
    World.quarantine(id, 1);

    await sweepQuarantine(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString());

    expect(cacheFiles(id)).toHaveLength(0);
  }, 120000);

  it('deletes a listing\'s files when staff clear its Supporter-only flag', async () => {
    const { id } = await served();

    const res = await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staffUser())).send({ supporterOnly: false });

    expect(res.status).toBe(200);
    expect(cacheFiles(id)).toHaveLength(0);
  }, 120000);
});

describe('the staff review content route', () => {
  it('serves a flagged listing waiting for its first review marked for the reviewing account', async () => {
    const admin = staffUser();
    const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
    expect((await setReview(true)).status).toBe(200);

    try {
      const created = await request(app).post('/api/worlds').set(authHeader(createUser()))
        .send({ name: 'Waiting', kind: 'mascot', thumbnail: TINY_PNG, contentData: mascotContent() });
      const id = created.body.data.id;
      await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(admin)).send({ supporterOnly: true });

      const res = await request(app).get(`/api/reviews/${id}/content`).set(authHeader(admin));

      expect(res.status).toBe(200);
      await expectMarkedFor('base.webp', res.body.data.contentData.layers.base, admin.id);
    } finally {
      await setReview(false);
    }
  }, 120000);

  it('marks a held update for the reviewing account and caches nothing', async () => {
    const { id, author } = await publishFlagged();
    const admin = staffUser();
    const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
    expect((await setReview(true)).status).toBe(200);

    try {
      const held = { ...mascotContent(), transition: 'held' };
      expect((await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: held })).status).toBe(200);

      const res = await request(app).get(`/api/reviews/${id}/content`).set(authHeader(admin));

      expect(res.status).toBe(200);
      expect(res.body.data.contentData.transition).toBe('held');
      await expectMarkedFor('base.webp', res.body.data.contentData.layers.base, admin.id);
      expect(fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).filter((name) => name.startsWith(`processed-${id}-`))).toHaveLength(0);
    } finally {
      await setReview(false);
    }
  }, 120000);
});
