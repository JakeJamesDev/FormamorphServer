import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, paths } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const PatreonLink = require('../src/models/PatreonLink');
const WatermarkMark = require('../src/models/WatermarkMark');
const { read } = require('../src/utils/watermark');
const pool = require('../src/utils/markLayerPool');
const { PROCESSING_VERSION } = require('../src/utils/supporterProcessing');
const { clearWorldProcessedCache } = require('../src/utils/clearWorldProcessedCache');

/**
 * A Supporter world on the gated route and the staff review route marks only its cover and its 4 largest
 * images of at least 310k pixels, as plain lossless WebP. Every other image arrives as uploaded.
 */

const staff = () => createUser({ accountType: 'admin' });

const supporter = () => {
  const user = createUser();
  PatreonLink.link({
    userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00',
    checkedAt: new Date().toISOString()
  });
  return user;
};

// A textured picture, different for each variant: gradient plus noise, so the mark has art to hide in.
const picture = async (width, height, variant, { quality = 60, noiseShift = 29 } = {}) => {
  const raw = Buffer.alloc(width * height * 3);
  let state = (variant + 1) * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const x = (i / 3) % width;
    raw[i] = Math.min(255, 40 + ((x * 160) / width) + ((i % 3) * 30) + (state >>> noiseShift));
  }
  const encoded = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${encoded.toString('base64')}`;
};

const animatedPicture = async (width, height) => {
  const frame = (background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  const buffer = await sharp([await frame('#c00'), await frame('#0c0')], { join: { animated: true } })
    .webp({ delay: [100, 100], loop: 0 }).toBuffer();
  return `data:image/webp;base64,${buffer.toString('base64')}`;
};

const rawOf = async (url) => {
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};

/** The mark number a served image carries, or null. */
const markOf = async (url) => read(await rawOf(url));

const isMarked = (value) => typeof value === 'string' && /^data:image\/webp;base64,/.test(value);

const content = (parts) => ({ ...worldPayload().contentData, ...parts });

const entityWith = (images) => ({ id: 'e1', name: 'Mira', images: images.map((data) => ({ data })) });

const flagged = async (contentData, kind = 'world') => {
  const author = createUser();
  const created = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload({ kind, contentData }));
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  const set = await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staff())).send({ supporterOnly: true });
  expect(set.status).toBe(200);
  return { id, author };
};

const gated = (id, user) => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(user));

const cacheFiles = (id) => fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).filter((name) => name.startsWith(`processed-${id}-`));

afterEach(() => vi.restoreAllMocks());

// 320k to 550k pixels, each distinct. Only the cover and the four widest should carry a mark.
const SIZES = [[640, 500], [700, 500], [800, 500], [900, 500], [1000, 500], [1100, 500]];

const sixImageWorld = async () => {
  const sources = await Promise.all(SIZES.map(([w, h], i) => picture(w, h, i)));
  const small = [await picture(200, 200, 90), await picture(300, 300, 91)];
  const cover = await picture(700, 450, 99);
  return {
    sources, small, cover,
    contentData: content({
      worldOverview: { name: 'Big', thumbnail: cover },
      entities: [entityWith(sources.slice(0, 3)), { ...entityWith(sources.slice(3)), id: 'e2' }],
      locations: [{ id: 'l1', name: 'Dock', images: small.map((data) => ({ data })) }]
    })
  };
};

describe('a world on the gated route', () => {
  it('marks the cover and the 4 largest eligible images for the account, and passes every other image through byte for byte', async () => {
    const { sources, small, cover, contentData } = await sixImageWorld();
    const { id } = await flagged(contentData);
    const member = supporter();

    const res = await gated(id, member);

    expect(res.status).toBe(200);
    const out = res.body.data.contentData;
    const served = [...out.entities[0].images, ...out.entities[1].images].map((image) => image.data);
    // The four widest are sources[2..5]; the two narrowest stay.
    expect(served.slice(0, 2)).toEqual(sources.slice(0, 2));
    for (const url of [out.worldOverview.thumbnail, ...served.slice(2)]) {
      expect(isMarked(url)).toBe(true);
      expect(await markOf(url)).toBe(WatermarkMark.markFor(member.id));
    }
    expect(out.locations[0].images.map((image) => image.data)).toEqual(small);
    expect(out.worldOverview.thumbnail).not.toBe(cover);
  }, 120000);

  it('gives a second account the same marked images, each with its own mark', async () => {
    const { contentData } = await sixImageWorld();
    const { id } = await flagged(contentData);
    const [first, second] = [supporter(), supporter()];

    const a = (await gated(id, first)).body.data.contentData;
    const b = (await gated(id, second)).body.data.contentData;

    const markedPlaces = (c) => [c.worldOverview.thumbnail, ...c.entities.flatMap((e) => e.images.map((i) => i.data))].map(isMarked);
    expect(markedPlaces(a)).toEqual(markedPlaces(b));
    expect(markedPlaces(a).filter(Boolean)).toHaveLength(5);
    expect(await markOf(b.worldOverview.thumbnail)).toBe(WatermarkMark.markFor(second.id));
    expect(await markOf(a.worldOverview.thumbnail)).toBe(WatermarkMark.markFor(first.id));
  }, 120000);

  it('decodes only the marked images and sends no scrambled layer object', async () => {
    const { contentData } = await sixImageWorld();
    const { id } = await flagged(contentData);
    const marks = vi.spyOn(pool, 'markLayer');

    const res = await gated(id, supporter());

    expect(marks).toHaveBeenCalledTimes(5);
    expect(marks.mock.calls.every(([, , seed]) => seed === null)).toBe(true);
    expect(JSON.stringify(res.body.data.contentData)).not.toContain('"seed"');
  }, 120000);

  it('writes no cache file', async () => {
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: await picture(400, 400, 1) } }));

    expect((await gated(id, supporter())).status).toBe(200);

    expect(cacheFiles(id)).toHaveLength(0);
  }, 120000);

  it('marks only the cover when no image reaches 310k pixels', async () => {
    const cover = await picture(300, 300, 1);
    const other = await picture(500, 600, 2); // 300k pixels
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: cover }, entities: [entityWith([other])] }));

    const out = (await gated(id, supporter())).body.data.contentData;

    expect(isMarked(out.worldOverview.thumbnail)).toBe(true);
    expect(out.entities[0].images[0].data).toBe(other);
  }, 120000);

  it('marks the 4 largest eligible images when the world has no cover', async () => {
    const sources = await Promise.all([0, 1, 2, 3, 4].map((i) => picture(700 + i * 50, 500, i)));
    const { id } = await flagged(content({ worldOverview: { name: 'W' }, entities: [entityWith(sources)] }));
    const member = supporter();

    const served = (await gated(id, member)).body.data.contentData.entities[0].images.map((image) => image.data);

    expect(served[0]).toBe(sources[0]);
    for (const url of served.slice(1)) expect(await markOf(url)).toBe(WatermarkMark.markFor(member.id));
  }, 120000);

  it('breaks a size tie in the order the images first appear', async () => {
    const sources = await Promise.all([0, 1, 2, 3, 4].map((i) => picture(800, 500, i)));
    const { id } = await flagged(content({ worldOverview: { name: 'W' }, entities: [entityWith(sources)] }));

    const served = (await gated(id, supporter())).body.data.contentData.entities[0].images.map((image) => image.data);

    expect(served.map(isMarked)).toEqual([true, true, true, true, false]);
    expect(served[4]).toBe(sources[4]);
  }, 120000);

  it('marks a cover named by { mediaId } in its Media List entry, which loses its hash and takes the WebP type', async () => {
    const cover = await picture(500, 400, 1);
    const other = await picture(500, 400, 2);
    const mediaList = {
      m1: { id: 'm1', name: 'Cover', kind: 'image', data: cover, type: 'image/jpeg', hash: 'abc' },
      m2: { id: 'm2', name: 'Other', kind: 'image', data: other, type: 'image/jpeg', hash: 'def' }
    };
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: { mediaId: 'm1' }, mediaList } }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.worldOverview;

    expect(out.thumbnail).toEqual({ mediaId: 'm1' });
    expect(isMarked(out.mediaList.m1.data)).toBe(true);
    expect(await markOf(out.mediaList.m1.data)).toBe(WatermarkMark.markFor(member.id));
    expect(out.mediaList.m1).toMatchObject({ id: 'm1', name: 'Cover', kind: 'image', type: 'image/webp' });
    expect(out.mediaList.m1).not.toHaveProperty('hash');
    expect(out.mediaList.m2).toEqual(mediaList.m2);
  }, 120000);

  it('never marks an SVG, an SVG cover counting as no cover', async () => {
    const svg = (width) => `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1000"><rect width="${width}" height="1000" fill="#36c"/></svg>`
    ).toString('base64')}`;
    const cover = svg(1600);
    const large = svg(1700);
    const sources = await Promise.all([0, 1, 2, 3, 4].map((i) => picture(700 + i * 50, 500, i)));
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: cover }, entities: [entityWith([large, ...sources])] }));

    const out = (await gated(id, supporter())).body.data.contentData;
    const served = out.entities[0].images.map((image) => image.data);

    expect(out.worldOverview.thumbnail).toBe(cover);
    expect(served[0]).toBe(large);
    expect(served.slice(1).map(isMarked)).toEqual([false, true, true, true, true]);
  }, 120000);

  it('counts an image string once toward the 4 and marks every place it appears the same way', async () => {
    const repeated = await picture(1000, 500, 1);
    const others = await Promise.all([2, 3, 4, 5].map((i) => picture(800 + i, 500, i)));
    // Five distinct images; the repeated one is the largest, so the 4 are it plus the three next largest.
    const { id } = await flagged(content({
      worldOverview: { name: 'W' },
      entities: [entityWith([repeated, ...others]), { ...entityWith([repeated]), id: 'e2' }]
    }));

    const out = (await gated(id, supporter())).body.data.contentData.entities;
    const first = out[0].images.map((image) => image.data);

    expect(first.map(isMarked)).toEqual([true, false, true, true, true]);
    expect(first[1]).toBe(others[0]);
    expect(out[1].images[0].data).toBe(first[0]);
  }, 120000);

  it.each([
    ['an undecodable cover', 'data:image/webp;base64,AAAA'],
    ['a { mediaId } naming no entry', { mediaId: 'gone' }]
  ])('treats %s as no cover', async (_label, thumbnail) => {
    const sources = await Promise.all([0, 1, 2, 3, 4].map((i) => picture(700 + i * 50, 500, i)));
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail }, entities: [entityWith(sources)] }));

    const out = (await gated(id, supporter())).body.data.contentData;

    expect(out.worldOverview.thumbnail).toEqual(thumbnail);
    expect(out.entities[0].images.map((image) => isMarked(image.data))).toEqual([false, true, true, true, true]);
  }, 120000);

  it('never marks an animated image, an animated cover counting as no cover', async () => {
    const cover = await animatedPicture(700, 500);
    const sources = await Promise.all([0, 1, 2, 3, 4].map((i) => picture(700 + i * 50, 500, i)));
    const animated = await animatedPicture(1200, 800);
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: cover }, entities: [entityWith([animated, ...sources])] }));

    const out = (await gated(id, supporter())).body.data.contentData;
    const served = out.entities[0].images.map((image) => image.data);

    expect(out.worldOverview.thumbnail).toBe(cover);
    expect(served[0]).toBe(animated);
    expect(served.slice(1).map(isMarked)).toEqual([false, true, true, true, true]);
  }, 120000);

  it('leaves non-image data, undecodable strings and linked entries as they were', async () => {
    const odd = { sound: 'data:audio/mpeg;base64,SUQzBAAAAAAA', broken: 'data:image/webp;base64,AAAA', linked: 'https://cdn.example.com/a.png' };
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: await picture(400, 400, 1) }, extras: odd }));

    expect((await gated(id, supporter())).body.data.contentData.extras).toEqual(odd);
  }, 120000);

  it('keeps the shape of the content: only image strings change', async () => {
    const { contentData } = await sixImageWorld();
    const { id } = await flagged(contentData);

    const out = (await gated(id, supporter())).body.data.contentData;

    const skeleton = (value) => JSON.stringify(value, (key, item) => (typeof item === 'string' && item.startsWith('data:image') ? 'IMG' : item));
    expect(skeleton(out)).toBe(skeleton(contentData));
  }, 120000);

  it('answers a Sunmeadow-scale world within twice the source size and a time bound', async () => {
    const COUNT = 250;
    // About 280 kB each; the real Sunmeadow averages 165 kB over 284 images.
    const base = await Promise.all([0, 1, 2, 3].map((i) => picture(1920, 1097, i, { quality: 80, noiseShift: 27 })));
    // Distinct strings of one size: a different trailing comment byte per image keeps each its own image.
    const images = Array.from({ length: COUNT }, (_, i) => {
      const buffer = Buffer.from(base[i % 4].split(',')[1], 'base64');
      return `data:image/jpeg;base64,${Buffer.concat([buffer, Buffer.from(String(i).padStart(4, '0'))]).toString('base64')}`;
    });
    const contentData = content({ worldOverview: { name: 'Town', thumbnail: images[0] }, entities: [entityWith(images.slice(1))] });
    const sourceBytes = Buffer.byteLength(JSON.stringify(contentData));
    const { id } = await flagged(contentData);
    const member = supporter();

    const started = performance.now();
    const res = await gated(id, member);
    const took = performance.now() - started;

    expect(res.status).toBe(200);
    console.log(`Sunmeadow-scale world: ${COUNT} images, ${Math.round(sourceBytes / 1e6)} MB source, ${Math.round(res.text.length / 1e6)} MB served, ${Math.round(took)} ms`);
    expect(res.text.length).toBeLessThan(sourceBytes * 2);
    expect(took).toBeLessThan(30000);
    const marked = res.body.data.contentData.entities[0].images.filter((image) => isMarked(image.data));
    expect(marked).toHaveLength(4);
  }, 300000);
});

describe('the staff review content route for a world', () => {
  it('follows the world rule and caches nothing', async () => {
    const admin = staff();
    const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin)).send({ value });
    expect((await setReview(true)).status).toBe(200);

    try {
      const sources = await Promise.all([0, 1].map((i) => picture(800, 500, i)));
      const cover = await picture(400, 400, 9);
      const created = await request(app).post('/api/worlds').set(authHeader(createUser())).send(worldPayload({
        contentData: content({ worldOverview: { name: 'W', thumbnail: cover }, entities: [entityWith(sources)] })
      }));
      const id = created.body.data.id;
      await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(admin)).send({ supporterOnly: true });

      const res = await request(app).get(`/api/reviews/${id}/content`).set(authHeader(admin));

      expect(res.status).toBe(200);
      const out = res.body.data.contentData;
      expect(await markOf(out.worldOverview.thumbnail)).toBe(WatermarkMark.markFor(admin.id));
      expect(out.entities[0].images.map((image) => isMarked(image.data))).toEqual([true, true]);
      expect(cacheFiles(id)).toHaveLength(0);
    } finally {
      await setReview(false);
    }
  }, 120000);
});

describe('the one-time cleanup of world cache files', () => {
  const plant = (id, user = 'u1') => {
    const name = `processed-${id}-v${PROCESSING_VERSION}-r1-${user}.json`;
    fs.writeFileSync(path.join(paths.SUPPORTER_PRIVATE_DIR, name), '{}');
    return name;
  };
  const exists = (name) => fs.existsSync(path.join(paths.SUPPORTER_PRIVATE_DIR, name));

  it('deletes the files of world listings and keeps the Mascot files', async () => {
    const world = await flagged(content({ worldOverview: { name: 'W' } }));
    const mascot = await flagged({ layers: {} }, 'mascot');
    const worldFiles = [plant(world.id), plant(world.id, 'u2')];
    const mascotFile = plant(mascot.id);
    const orphan = plant('00000000-0000-4000-8000-000000000000');

    const dry = await clearWorldProcessedCache();
    expect(dry.found).toBeGreaterThanOrEqual(3);
    expect(dry.deleted).toBe(0);
    expect([...worldFiles, mascotFile, orphan].every(exists)).toBe(true);

    const wrote = await clearWorldProcessedCache({ write: true });
    expect(wrote.deleted).toBe(dry.found);

    expect([...worldFiles, orphan].some(exists)).toBe(false);
    expect(exists(mascotFile)).toBe(true);
  });
});
