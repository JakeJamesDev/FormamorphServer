import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const PatreonLink = require('../src/models/PatreonLink');
const WatermarkMark = require('../src/models/WatermarkMark');
const MarkPicks = require('../src/models/MarkPicks');
const { read } = require('../src/utils/watermark');

/**
 * A world publish or update can carry `markPicks`. The server stores them per revision, checks each one, and
 * marks a valid pick's image ahead of the entity's approximated start picture. No route returns them.
 * Reads go through the gated route and the watermark reader.
 */

const tag = () => Math.random().toString(16).slice(2, 8);
const admin = () => createUser({ username: `admin-${tag()}`, accountType: 'admin' });
const author = () => createUser({ username: `author-${tag()}` });

const supporter = () => {
  const user = createUser();
  PatreonLink.link({
    userId: user.id, patreonUserId: `p-${user.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00',
    checkedAt: new Date().toISOString()
  });
  return user;
};

// Textured, so the mark has art to hide in; the variant number makes each picture its own string.
const picture = async (width, height, variant) => {
  const raw = Buffer.alloc(width * height * 3);
  let state = (variant + 1) * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    raw[i] = Math.min(255, 40 + (((i / 3) % width) * 160) / width + (i % 3) * 30 + (state >>> 29));
  }
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 60 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
};

const animated = async (width, height) => {
  const frame = (background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  const buffer = await sharp([await frame('#c00'), await frame('#0c0')], { join: { animated: true } })
    .webp({ delay: [100, 100], loop: 0 }).toBuffer();
  return `data:image/webp;base64,${buffer.toString('base64')}`;
};

const svg = () => `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#36c"/></svg>'
).toString('base64')}`;

const markOf = async (url) => {
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return read({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) });
};

const isMarked = (value) => typeof value === 'string' && /^data:image\/webp;base64,/.test(value);

const entry = (id, data) => ({ id, name: id, kind: 'image', data, type: 'image/jpeg' });

// Character art, 336k pixels each: eligible, and smaller than a backdrop.
const art = (i) => picture(600, 560, i);

/**
 * A world whose cover and entities `e2` to `e4` fill the character marks, so only `e1` is in question (`e5` is
 * past the budget).
 * `e1` owns a Layered Image `rig` (base Layer: `start`, `alt`; overlay: `over`) and the flat images in `extra`.
 */
const buildWorld = async (extra = {}) => {
  const images = {
    start: await art(1), alt: await art(2), over: await picture(900, 700, 3), ...extra.images
  };
  const mediaList = {
    start: entry('start', images.start),
    alt: entry('alt', images.alt),
    over: entry('over', images.over),
    rig: {
      id: 'rig', name: 'Rig', kind: 'layered',
      layers: [
        { id: 'l1', name: 'Body', variants: [{ mediaId: 'start' }, { mediaId: 'alt' }] },
        { id: 'l2', name: 'Carry', variants: [{ mediaId: 'over' }] }
      ]
    },
    ...Object.fromEntries(Object.entries(extra.images || {}).map(([id, data]) => [id, entry(id, data)]))
  };
  // Three characters beside `e1` spend the four character marks; a 4th is left over, so a wrong pick shows.
  const others = await Promise.all([4, 5, 6, 7].map((i) => art(i)));
  const contentData = {
    ...worldPayload().contentData,
    worldOverview: { name: 'Picks', thumbnail: await picture(700, 450, 99), mediaList },
    entities: [
      { id: 'e1', name: 'e1', images: [{ mediaId: 'rig' }, ...Object.keys(extra.images || {}).map((mediaId) => ({ mediaId }))] },
      ...others.map((data, i) => ({ id: `e${i + 2}`, name: `e${i + 2}`, images: [{ data }] }))
    ]
  };
  return { contentData, images };
};

const publish = (user, contentData, markPicks) => request(app).post('/api/worlds').set(authHeader(user))
  .send(worldPayload({ contentData, ...(markPicks === undefined ? {} : { markPicks }) }));

const flag = (id) => request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(admin())).send({ supporterOnly: true });

const gated = async (id, member = supporter()) => {
  const res = await request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(member));
  expect(res.status).toBe(200);
  return { member, out: res.body.data.contentData.worldOverview.mediaList, entities: res.body.data.contentData.entities };
};

const published = async (markPicks, build = buildWorld) => {
  const owner = author();
  const world = await build();
  const created = await publish(owner, world.contentData, markPicks);
  expect(created.status).toBe(201);
  const { id } = created.body.data;
  expect((await flag(id)).status).toBe(200);
  return { id, owner, ...world, created };
};

const expectMarkedFor = async (url, member) => {
  expect(isMarked(url)).toBe(true);
  expect(await markOf(url)).toBe(WatermarkMark.markFor(member.id));
};

describe('a pick on a published world', () => {
  it('marks a flat gallery image ahead of the approximated one', async () => {
    const { id, images } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    const { member, out } = await gated(id);

    await expectMarkedFor(out.alt.data, member);
    expect(out.start.data).toBe(images.start);
  }, 120000);

  it('marks a base Layer Variant that is not the first, and no overlay Variant', async () => {
    const { id, images } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    const { out } = await gated(id);

    expect(isMarked(out.alt.data)).toBe(true);
    expect(out.over.data).toBe(images.over);
  }, 120000);

  it('falls back to the approximation without picks', async () => {
    const { id, images } = await published(undefined);

    const { member, out } = await gated(id);

    await expectMarkedFor(out.start.data, member);
    expect(out.alt.data).toBe(images.alt);
  }, 120000);
});

describe('a pick that fails the check', () => {
  const smallArt = () => picture(300, 300, 40);
  const cases = [
    ['an overlay Variant', 'over', undefined],
    ['an image of another entity', 'e2art', { e2art: undefined }],
    ['a missing id', 'gone', undefined],
    ['a small image', 'tiny', { tiny: smallArt }],
    ['an animated image', 'anim', { anim: () => animated(700, 500) }],
    ['an SVG', 'vector', { vector: async () => svg() }]
  ];

  it.each(cases)('falls back to the approximation for %s', async (_label, mediaId, extra) => {
    const build = async () => {
      const images = {};
      for (const [key, make] of Object.entries(extra || {})) if (make) images[key] = await make();
      const world = await buildWorld({ images });
      if (mediaId === 'e2art') {
        // Another entity's image: in the Media List, but in no gallery of `e1`.
        world.contentData.worldOverview.mediaList.e2art = entry('e2art', world.contentData.entities[1].images[0].data);
        world.contentData.entities[1].images = [{ mediaId: 'e2art' }];
      }
      return world;
    };
    const { id, images } = await published([{ entityId: 'e1', mediaId }], build);

    const { member, out } = await gated(id);

    await expectMarkedFor(out.start.data, member);
    expect(out.alt.data).toBe(images.alt);
    // The rejected pick's own image stays as uploaded, where it is the entity's own.
    if (images[mediaId]) expect(out[mediaId].data).toBe(images[mediaId]);
  }, 120000);

  it('falls back for an entity the content does not have, and keeps the valid picks beside it', async () => {
    const { id, images } = await published([{ entityId: 'nobody', mediaId: 'alt' }, { entityId: 'e1', mediaId: 'alt' }]);

    const { out } = await gated(id);

    expect(isMarked(out.alt.data)).toBe(true);
    expect(out.start.data).toBe(images.start);
  }, 120000);
});

describe('malformed picks', () => {
  it.each([
    ['a string', 'alt'],
    ['an object', { entityId: 'e1', mediaId: 'alt' }],
    ['a list of non-objects', [1, 'a', null]],
    ['entries with wrong fields', [{ entityId: 1, mediaId: 'alt' }, { entityId: 'e1' }, { mediaId: 'alt' }]]
  ])('publish normally with no picks stored for %s', async (_label, markPicks) => {
    const { id, created, images } = await published(markPicks);

    expect(created.status).toBe(201);
    expect(MarkPicks.get(id)).toEqual([]);
    const { member, out } = await gated(id);
    await expectMarkedFor(out.start.data, member);
    expect(out.alt.data).toBe(images.alt);
  }, 120000);

  it('drops only the bad entries and keeps the rest', async () => {
    const { id } = await published([null, { entityId: 'e1', mediaId: 'alt' }, { entityId: 5, mediaId: 'x' }]);

    expect(MarkPicks.get(id)).toEqual([{ entityId: 'e1', mediaId: 'alt' }]);
  }, 120000);
});

describe('updating a world', () => {
  const edit = (id, user, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);

  it('clears the picks when content comes without markPicks, so the approximation marks again', async () => {
    const { id, owner, contentData, images } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    expect((await edit(id, owner, { contentData })).status).toBe(200);

    expect(MarkPicks.get(id)).toEqual([]);
    const { member, out } = await gated(id);
    await expectMarkedFor(out.start.data, member);
    expect(out.alt.data).toBe(images.alt);
  }, 120000);

  it('replaces the picks when content comes with new ones', async () => {
    const { id, owner, contentData } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    expect((await edit(id, owner, { contentData, markPicks: [{ entityId: 'e1', mediaId: 'start' }] })).status).toBe(200);

    expect(MarkPicks.get(id)).toEqual([{ entityId: 'e1', mediaId: 'start' }]);
  }, 120000);

  it('keeps the picks through an update without content', async () => {
    const { id, owner } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    expect((await edit(id, owner, { name: 'Renamed' })).status).toBe(200);

    expect(MarkPicks.get(id)).toEqual([{ entityId: 'e1', mediaId: 'alt' }]);
    const { out, member } = await gated(id);
    await expectMarkedFor(out.alt.data, member);
  }, 120000);
});

describe('a held update', () => {
  const setReview = (value) => request(app).put('/api/settings/listing_review').set(authHeader(admin())).send({ value });

  // An approved listing with no picks, then review on, then a held update that carries a pick.
  const heldWithPick = async () => {
    await setReview(false);
    const owner = author();
    const world = await buildWorld();
    const created = await publish(owner, world.contentData);
    expect(created.status).toBe(201);
    const { id } = created.body.data;
    expect((await flag(id)).status).toBe(200);
    await setReview(true);
    const held = await request(app).put(`/api/worlds/${id}`).set(authHeader(owner))
      .send({ contentData: world.contentData, markPicks: [{ entityId: 'e1', mediaId: 'alt' }] });
    expect(held.status).toBe(200);
    return { id, owner, ...world };
  };

  it('applies its picks only when the update is approved', async () => {
    const { id, images } = await heldWithPick();
    expect(MarkPicks.get(id)).toEqual([]);

    const before = await gated(id);
    await expectMarkedFor(before.out.start.data, before.member);
    expect(before.out.alt.data).toBe(images.alt);

    const approved = await request(app).post(`/api/reviews/${id}/approve`).set(authHeader(admin()));
    expect(approved.status).toBe(200);

    expect(MarkPicks.get(id)).toEqual([{ entityId: 'e1', mediaId: 'alt' }]);
    const after = await gated(id);
    await expectMarkedFor(after.out.alt.data, after.member);
    expect(after.out.start.data).toBe(images.start);
  }, 120000);

  it('shows staff the held content marked by its held picks', async () => {
    const { id, images } = await heldWithPick();
    const member = admin();

    const res = await request(app).get(`/api/reviews/${id}/content`).set(authHeader(member));

    expect(res.status).toBe(200);
    const out = res.body.data.contentData.worldOverview.mediaList;
    await expectMarkedFor(out.alt.data, member);
    expect(out.start.data).toBe(images.start);
  }, 120000);

  it('drops its picks when the update is rejected, and leaves the live ones', async () => {
    const { id } = await heldWithPick();
    MarkPicks.set(id, [{ entityId: 'e1', mediaId: 'start' }]);

    const rejected = await request(app).post(`/api/reviews/${id}/reject`).set(authHeader(admin())).send({});
    expect(rejected.status).toBe(200);

    expect(MarkPicks.get(id, { held: true })).toEqual([]);
    expect(MarkPicks.get(id)).toEqual([{ entityId: 'e1', mediaId: 'start' }]);
  }, 120000);

  it('clears the live picks on approval when the held content came without picks', async () => {
    const { id, owner, contentData } = await heldWithPick();
    MarkPicks.set(id, [{ entityId: 'e1', mediaId: 'start' }]);
    const reedit = await request(app).put(`/api/worlds/${id}`).set(authHeader(owner)).send({ contentData });
    expect(reedit.status).toBe(200);

    expect((await request(app).post(`/api/reviews/${id}/approve`).set(authHeader(admin()))).status).toBe(200);

    expect(MarkPicks.get(id)).toEqual([]);
  }, 120000);
});

describe('what routes return', () => {
  it('no route response carries the picks', async () => {
    const { id, owner, contentData } = await published([{ entityId: 'e1', mediaId: 'alt' }]);
    const staff = admin();
    // Sequential: the update rewrites the content file the gated read opens.
    const reads = [
      [200, () => request(app).get(`/api/worlds/${id}`).set(authHeader(staff))],
      [200, () => request(app).get('/api/worlds').set(authHeader(staff))],
      // Supporter-only content leaves only through the gated route.
      [403, () => request(app).get(`/api/worlds/${id}/content`).set(authHeader(staff))],
      [200, () => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(staff))],
      [200, () => request(app).get('/api/users/me/worlds').set(authHeader(owner))],
      [200, () => request(app).get(`/api/users/${owner.id}/worlds`).set(authHeader(staff))],
      [200, () => request(app).put(`/api/worlds/${id}`).set(authHeader(owner))
        .send({ contentData, markPicks: [{ entityId: 'e1', mediaId: 'alt' }] })]
    ];

    for (const [status, send] of reads) {
      const res = await send();
      expect(res.status).toBe(status);
      expect(JSON.stringify(res.body)).not.toMatch(/mark_?picks/i);
    }
  }, 120000);

  it('the publish reply carries no picks', async () => {
    const { created } = await published([{ entityId: 'e1', mediaId: 'alt' }]);

    expect(JSON.stringify(created.body)).not.toMatch(/mark_?picks/i);
  }, 120000);
});

describe('MarkPicks.parse', () => {
  it('keeps the first pick of an entity', () => {
    expect(MarkPicks.parse([{ entityId: 'a', mediaId: 'x' }, { entityId: 'a', mediaId: 'y' }]))
      .toEqual([{ entityId: 'a', mediaId: 'x' }]);
  });

  it('drops an id over 200 characters and counts only usable entries toward the cap', () => {
    const junk = Array.from({ length: 6000 }, () => null);
    const good = Array.from({ length: 5100 }, (_, i) => ({ entityId: `e${i}`, mediaId: 'm' }));

    expect(MarkPicks.parse([{ entityId: 'a'.repeat(201), mediaId: 'x' }])).toEqual([]);
    expect(MarkPicks.parse([...junk, ...good])).toHaveLength(5000);
  });
});
