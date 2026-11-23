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
 * A Supporter world on the gated route and the staff review route marks 5 images of at least 310k pixels, as
 * plain lossless WebP: the cover, each entity's start picture in World Editor order, then the largest backdrops.
 * Every other image arrives as uploaded.
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

// 320k to 550k pixels, each distinct. Marks: the cover, each entity's first slot, then the two widest left.
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
  it('sends each marked image as lossless WebP', async () => {
    const { id } = await flagged(content({ worldOverview: { name: 'W', thumbnail: await picture(400, 400, 1) } }));

    const thumbnail = (await gated(id, supporter())).body.data.contentData.worldOverview.thumbnail;

    // A WebP file's first chunk is VP8L when lossless, VP8 when lossy.
    expect(Buffer.from(thumbnail.split(',')[1], 'base64').subarray(12, 16).toString('ascii')).toBe('VP8L');
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

describe('which images a world marks', () => {
  // A rule the start never meets: no world here defines the trait.
  const RULE = [{ conditions: [{ traitId: 't-unknown' }] }];
  const character = (id, images, extra = {}) => ({ id, name: id, images, ...extra });
  const flat = (data) => ({ data });
  // Character art is smaller than backdrops, as in a typical world: 336k pixels against 700k and more.
  const characterArt = (i) => picture(600, 560, i);
  const backdropArt = (i, width = 1000) => picture(width, 700, 100 + i);
  const backdropsOf = (images) => [{ id: 'l1', name: 'Square', images: images.map(flat) }];
  const served = (entity) => entity.images.map((image) => image.data);
  const expectMarked = async (url, member) => {
    expect(isMarked(url)).toBe(true);
    expect(await markOf(url)).toBe(WatermarkMark.markFor(member.id));
  };

  const castWorld = async (count, { thumbnail } = {}) => {
    const arts = await Promise.all(Array.from({ length: count }, (_, i) => characterArt(i)));
    const backdrops = await Promise.all([0, 1, 2].map((i) => backdropArt(i, 1000 + i * 100)));
    return {
      arts, backdrops,
      contentData: content({
        worldOverview: { name: 'Cast', ...(thumbnail === undefined ? {} : { thumbnail }) },
        entities: arts.map((art, i) => character(`c${i}`, [flat(art)])),
        locations: backdropsOf(backdrops)
      })
    };
  };

  it('marks the cover and the first 4 characters, and no backdrop larger than all of them', async () => {
    const cover = await picture(700, 450, 99);
    const { arts, backdrops, contentData } = await castWorld(5, { thumbnail: cover });
    const { id } = await flagged(contentData);
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;

    await expectMarked(out.worldOverview.thumbnail, member);
    for (const entity of out.entities.slice(0, 4)) await expectMarked(entity.images[0].data, member);
    expect(out.entities[4].images[0].data).toBe(arts[4]);
    expect(served(out.locations[0])).toEqual(backdrops);
  }, 120000);

  const svgCover = () => `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#36c"/></svg>'
  ).toString('base64')}`;

  it.each([
    ['no cover', async () => undefined],
    ['an undecodable cover', async () => 'data:image/webp;base64,AAAA'],
    ['a { mediaId } naming no entry', async () => ({ mediaId: 'gone' })],
    ['an SVG cover', async () => svgCover()],
    ['an animated cover', async () => animatedPicture(700, 500)]
  ])('gives the free mark to a 5th character with %s', async (_label, makeCover) => {
    const thumbnail = await makeCover();
    const { arts, backdrops, contentData } = await castWorld(6, { thumbnail });
    const { id } = await flagged(contentData);
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;

    expect(out.worldOverview.thumbnail).toEqual(thumbnail);
    for (const entity of out.entities.slice(0, 5)) await expectMarked(entity.images[0].data, member);
    expect(out.entities[5].images[0].data).toBe(arts[5]);
    expect(served(out.locations[0])).toEqual(backdrops);
  }, 120000);

  it('spends the marks no character can use on the largest backdrops, ties in first-appearance order', async () => {
    const cover = await picture(700, 450, 99);
    const arts = await Promise.all([0, 1].map((i) => characterArt(i)));
    const tooSmall = await picture(500, 600, 7); // 300k pixels
    const tied = await Promise.all([0, 1, 2].map((i) => backdropArt(i, 1200)));
    const smaller = await backdropArt(3, 1000);
    // Larger than every other image, and never markable.
    const animated = await animatedPicture(1600, 900);
    const svg = svgCover();
    const { id } = await flagged(content({
      worldOverview: { name: 'Few', thumbnail: cover },
      entities: [character('a', [flat(arts[0])]), character('small', [flat(tooSmall)]), character('b', [flat(arts[1])])],
      locations: backdropsOf([smaller, animated, svg, ...tied])
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;

    await expectMarked(out.worldOverview.thumbnail, member);
    await expectMarked(out.entities[0].images[0].data, member);
    await expectMarked(out.entities[2].images[0].data, member);
    expect(out.entities[1].images[0].data).toBe(tooSmall);
    const places = served(out.locations[0]);
    expect(places.slice(0, 3)).toEqual([smaller, animated, svg]);
    await expectMarked(places[3], member);
    await expectMarked(places[4], member);
    expect(places[5]).toBe(tied[2]);
  }, 120000);

  it('marks a character through its first slot without a rule, skipping a slot that names no entry', async () => {
    const cover = await picture(700, 450, 99);
    const ruled = await backdropArt(0, 1200);
    const arts = await Promise.all([0, 1, 2, 3].map((i) => characterArt(i)));
    const { id } = await flagged(content({
      worldOverview: { name: 'Rules', thumbnail: cover },
      entities: [
        character('a', [{ data: ruled, requires: RULE }, flat(arts[0])]),
        character('b', [{ mediaId: 'gone' }, flat(arts[1])]),
        character('c', [flat(arts[2])]),
        character('d', [flat(arts[3])])
      ]
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;

    expect(out.entities[0].images[0].data).toBe(ruled);
    await expectMarked(out.entities[0].images[1].data, member);
    expect(out.entities[1].images[0]).toEqual({ mediaId: 'gone' });
    await expectMarked(out.entities[1].images[1].data, member);
  }, 120000);

  const layeredWorld = async () => {
    const ruledBase = await backdropArt(1, 900);
    const startBase = await characterArt(2);
    const overlay = await backdropArt(3, 1400);
    const mediaList = {
      v0: { id: 'v0', name: 'Body Night', kind: 'image', data: ruledBase, type: 'image/jpeg' },
      v1: { id: 'v1', name: 'Body', kind: 'image', data: startBase, type: 'image/jpeg' },
      o1: { id: 'o1', name: 'Carry', kind: 'image', data: overlay, type: 'image/jpeg' },
      rig: {
        id: 'rig', name: 'Roxanne', kind: 'layered',
        layers: [
          { id: 'l0', name: 'Shadow', variants: [] },
          { id: 'l1', name: 'Body', variants: [{ mediaId: 'v0', requires: RULE }, { mediaId: 'v1' }] },
          { id: 'l2', name: 'Carry', variants: [{ mediaId: 'o1' }] }
        ]
      }
    };
    return { ruledBase, startBase, overlay, mediaList };
  };

  it('marks a Layered Image character on its base Layer\'s first ruleless Variant', async () => {
    const { ruledBase, overlay, mediaList } = await layeredWorld();
    const arts = await Promise.all([0, 1, 3, 4].map((i) => characterArt(i)));
    // Five characters spend every mark, so no backdrop pick can stand in for the character's own.
    const { id } = await flagged(content({
      worldOverview: { name: 'Rig', mediaList },
      entities: [character('roxanne', [{ mediaId: 'rig' }]), ...arts.map((art, i) => character(`c${i}`, [flat(art)]))]
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.worldOverview.mediaList;

    await expectMarked(out.v1.data, member);
    expect(out.v0.data).toBe(ruledBase);
    expect(out.o1.data).toBe(overlay);
  }, 120000);

  it('never spends a spare mark on an overlay Variant larger than the base, while base Variants stay in the pool', async () => {
    const { overlay, mediaList } = await layeredWorld();
    const { id } = await flagged(content({
      worldOverview: { name: 'Rig', mediaList },
      entities: [character('roxanne', [{ mediaId: 'rig' }])]
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.worldOverview.mediaList;

    await expectMarked(out.v1.data, member);
    await expectMarked(out.v0.data, member);
    expect(out.o1.data).toBe(overlay);
  }, 120000);

  it('keeps an overlay image in the backdrop pool when a gallery slot also shows it', async () => {
    const { mediaList } = await layeredWorld();
    const backdrops = await Promise.all([0, 1].map((i) => backdropArt(10 + i, 1600)));
    const { id } = await flagged(content({
      worldOverview: { name: 'Rig', mediaList },
      entities: [character('roxanne', [{ mediaId: 'rig' }]), character('prop', [{ mediaId: 'o1', requires: RULE }])],
      locations: backdropsOf(backdrops)
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;

    await expectMarked(out.worldOverview.mediaList.v1.data, member);
    await expectMarked(out.worldOverview.mediaList.o1.data, member);
    for (const url of served(out.locations[0])) await expectMarked(url, member);
  }, 120000);

  it('finds an embedded rig\'s base Layer past a Layer whose Variants hold no image', async () => {
    const [ruled, start] = await Promise.all([backdropArt(20, 900), characterArt(21)]);
    const embeddedRig = {
      name: 'Rig',
      layers: [
        { id: 'l0', name: 'Ghost', variants: [{ name: 'Empty' }] },
        { id: 'l1', name: 'Body', variants: [{ data: ruled, requires: RULE }, { data: start }] }
      ]
    };
    const backdrops = await Promise.all([0, 1, 2].map((i) => backdropArt(30 + i, 1600)));
    const { id } = await flagged(content({
      worldOverview: { name: 'Rig' },
      entities: [character('a', [{ layered: embeddedRig }])],
      locations: backdropsOf(backdrops)
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData;
    const variants = out.entities[0].images[0].layered.layers[1].variants;

    await expectMarked(variants[1].data, member);
    // A base Variant stays in the backdrop pool, with the 3 larger backdrops.
    await expectMarked(variants[0].data, member);
    for (const url of served(out.locations[0])) await expectMarked(url, member);
  }, 120000);

  it('marks an image two characters share once, and the next character takes the free mark', async () => {
    const cover = await picture(700, 450, 99);
    const arts = await Promise.all([0, 1, 2, 3, 4].map((i) => characterArt(i)));
    const backdrops = await Promise.all([0, 1, 2].map((i) => backdropArt(i, 1000 + i * 100)));
    const { id } = await flagged(content({
      worldOverview: { name: 'Twins', thumbnail: cover },
      entities: [
        character('a', [flat(arts[0])]), character('twin', [flat(arts[0])]),
        ...arts.slice(1).map((art, i) => character(`c${i}`, [flat(art)]))
      ],
      locations: backdropsOf(backdrops)
    }));
    const member = supporter();

    const world = (await gated(id, member)).body.data.contentData;
    const out = world.entities;

    await expectMarked(out[0].images[0].data, member);
    expect(out[1].images[0].data).toBe(out[0].images[0].data);
    for (const entity of out.slice(2, 5)) await expectMarked(entity.images[0].data, member);
    expect(out[5].images[0].data).toBe(arts[4]);
    expect(served(world.locations[0])).toEqual(backdrops);
  }, 120000);

  it('resolves embedded images, an embedded Layered Image and the legacy portrait field', async () => {
    const arts = await Promise.all([0, 1, 2, 3].map((i) => characterArt(i)));
    const overlay = await backdropArt(5, 1400);
    const embeddedRig = {
      name: 'Rig',
      layers: [
        { id: 'l0', name: 'Body', variants: [{ data: arts[2] }] },
        { id: 'l1', name: 'Carry', variants: [{ data: overlay }] }
      ]
    };
    const { id } = await flagged(content({
      worldOverview: { name: 'Shapes' },
      entities: [
        { id: 'a', name: 'a', images: [arts[0]] },
        character('b', [flat(arts[1])]),
        character('c', [{ layered: embeddedRig }]),
        { id: 'd', name: 'd', image: arts[3] }
      ]
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.entities;

    await expectMarked(out[0].images[0], member);
    await expectMarked(out[1].images[0].data, member);
    await expectMarked(out[2].images[0].layered.layers[0].variants[0].data, member);
    expect(out[2].images[0].layered.layers[1].variants[0].data).toBe(overlay);
    await expectMarked(out[3].image, member);
  }, 120000);

  it('takes characters in World Editor order: folders and `order` before the array', async () => {
    const cover = await picture(700, 450, 99);
    const arts = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => characterArt(i)));
    const entities = arts.map((art, i) => character(`c${i}`, [flat(art)]));
    // c5 sits in the first folder; c0 sorts last among the root rows.
    entities[5].groupId = 'g1';
    entities[0].order = 99;
    const { id } = await flagged(content({
      worldOverview: { name: 'Order', thumbnail: cover },
      entityGroups: [{ id: 'g1', name: 'Leads', parentId: null, order: 0 }],
      entities
    }));
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.entities;

    expect(out.map((entity) => isMarked(entity.images[0].data))).toEqual([false, true, true, true, false, true]);
  }, 120000);

  it('passes a character image whose body does not decode through, and the next character takes its mark', async () => {
    const cover = await picture(700, 450, 99);
    const whole = await characterArt(9);
    const bytes = Buffer.from(whole.split(',')[1], 'base64');
    // The header still reads as eligible; the body is cut short.
    const broken = `data:image/jpeg;base64,${bytes.subarray(0, Math.floor(bytes.length / 2)).toString('base64')}`;
    const { arts, contentData } = await castWorld(5, { thumbnail: cover });
    contentData.entities.unshift(character('broken', [flat(broken)]));
    const { id } = await flagged(contentData);
    const member = supporter();

    const out = (await gated(id, member)).body.data.contentData.entities;

    expect(out[0].images[0].data).toBe(broken);
    for (const entity of out.slice(1, 5)) await expectMarked(entity.images[0].data, member);
    expect(out[5].images[0].data).toBe(arts[4]);
  }, 120000);

  it('retires the cached copies of the cover-plus-4-largest rule', () => {
    // PROCESSING_VERSION under the cover-plus-4-largest rule, at 66dc591.
    expect(PROCESSING_VERSION).not.toBe('f5aaec31b413');
  });
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
