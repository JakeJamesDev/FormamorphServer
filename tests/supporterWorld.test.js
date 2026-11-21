import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');

/**
 * Supporter-only worlds on the gated route: every embedded image is processed, other media passes through
 * unchanged (R8), a world that links images is refused where it is published, updated or flagged (R11), and
 * the dependency routes follow R30.
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

const AUDIO = 'data:audio/mpeg;base64,SUQzBAAAAAAA';
const MODEL = 'data:model/gltf-binary;base64,Z2xURgIAAAA=';
const AVATAR = 'data:application/octet-stream;base64,Vk1MQUJD';
const LINK = 'https://cdn.example.com/art.png';

/** A world with an image in each slot, plus audio, an Avatar and a 3D model. */
const richContent = (overrides = {}) => ({
  ...worldPayload().contentData,
  worldOverview: {
    name: 'Rich',
    thumbnail: TINY_PNG,
    bgm: AUDIO,
    mapBackground: { images: [{ data: TINY_PNG }] },
    vrmStore: { v1: { name: 'Avatar', file: { name: 'a.vrm', data: AVATAR } } }
  },
  entities: [{ id: 'e1', name: 'Mira', images: [{ data: TINY_PNG }, TINY_PNG], sound: { name: 's.mp3', data: AUDIO }, model: { name: 'm.glb', data: MODEL } }],
  locations: [{ id: 'l1', name: 'Dock', images: [{ data: TINY_PNG }], ambientSound: { name: 'a.mp3', data: AUDIO } }],
  bodies: [{ id: 'b1', backdrop: { kind: 'image', image: { data: TINY_PNG } } }],
  dictionaries: [{ id: 'd1', name: 'Terms', thumbnail: TINY_PNG }],
  ...overrides
});

const publish = (author, contentData, extra = {}) =>
  request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload({ contentData, ...extra }));

const flag = (id, supporterOnly = true) =>
  request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staff())).send({ supporterOnly });

const gated = (id, user) => request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(user));

const flagged = async (contentData = richContent()) => {
  const author = createUser();
  const created = await publish(author, contentData);
  expect(created.status).toBe(201);
  expect((await flag(created.body.data.id)).status).toBe(200);
  return { id: created.body.data.id, author };
};

const isMarkedWebp = (value) => typeof value === 'string' && /^data:image\/webp;base64,/.test(value);

describe('the gated route serving a world', () => {
  it('marks the cover wherever it appears as a plain WebP string and leaves other media byte-equal', async () => {
    const { id } = await flagged();

    const res = await gated(id, supporter());
    expect(res.status).toBe(200);
    const content = res.body.data.contentData;

    expect(isMarkedWebp(content.worldOverview.thumbnail)).toBe(true);
    expect(isMarkedWebp(content.worldOverview.mapBackground.images[0].data)).toBe(true);
    expect(isMarkedWebp(content.entities[0].images[0].data)).toBe(true);
    expect(isMarkedWebp(content.entities[0].images[1])).toBe(true);
    expect(isMarkedWebp(content.locations[0].images[0].data)).toBe(true);
    expect(isMarkedWebp(content.bodies[0].backdrop.image.data)).toBe(true);
    expect(isMarkedWebp(content.dictionaries[0].thumbnail)).toBe(true);

    expect(content.worldOverview.bgm).toBe(AUDIO);
    expect(content.worldOverview.vrmStore.v1.file.data).toBe(AVATAR);
    expect(content.entities[0].sound.data).toBe(AUDIO);
    expect(content.entities[0].model.data).toBe(MODEL);
    expect(content.locations[0].ambientSound.data).toBe(AUDIO);
    expect(JSON.stringify(content)).not.toContain(TINY_PNG);
  });
});

describe('refusing a linked image on a Supporter-only world', () => {
  const linkedContent = () => richContent({
    entities: [{ id: 'e1', name: 'Mira', images: [{ data: TINY_PNG }, { data: LINK }] }],
    locations: [{ id: 'l1', name: 'Dock', backgroundImage: LINK }]
  });
  const expectRefused = (res) => {
    expect(res.status).toBe(400);
    expect(res.body.linkedImages).toEqual([
      { where: 'Entity "Mira", image 2', url: LINK },
      { where: 'Location "Dock", image 1', url: LINK }
    ]);
    expect(res.body.error).toContain('Entity "Mira", image 2');
    expect(res.body.error).toContain('Location "Dock", image 1');
  };

  it('refuses create, names each location, and accepts the same world without the flag', async () => {
    const admin = staff();
    const refused = await publish(admin, linkedContent(), { supporterOnly: true });
    expectRefused(refused);

    const plain = await publish(admin, linkedContent());
    expect(plain.status).toBe(201);
  });

  it('refuses an update that adds a link to a Supporter-only world, and accepts it on a plain one', async () => {
    const { id, author } = await flagged();
    const before = db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision;

    const refused = await request(app).put(`/api/worlds/${id}`).set(authHeader(author)).send({ contentData: linkedContent() });
    expectRefused(refused);
    expect(db.prepare('SELECT revision FROM worlds WHERE id = ?').get(id).revision).toBe(before);

    const plainAuthor = createUser();
    const plain = (await publish(plainAuthor, richContent())).body.data;
    const accepted = await request(app).put(`/api/worlds/${plain.id}`).set(authHeader(plainAuthor)).send({ contentData: linkedContent() });
    expect(accepted.status).toBe(200);
  });

  it('refuses the flag on a world that links images, leaves it unflagged, and flags it once embedded', async () => {
    const author = createUser();
    const created = (await publish(author, linkedContent())).body.data;

    expectRefused(await flag(created.id));
    expect(db.prepare('SELECT supporter_only FROM worlds WHERE id = ?').get(created.id).supporter_only).toBe(0);

    const fixed = richContent();
    expect((await request(app).put(`/api/worlds/${created.id}`).set(authHeader(author)).send({ contentData: fixed })).status).toBe(200);
    expect((await flag(created.id)).status).toBe(200);
  });

  describe('with a Media List', () => {
    const LINK_SOUND = 'https://cdn.example.com/theme.mp3';
    const listed = (mediaList) => richContent({
      worldOverview: { name: 'Listed', mediaList },
      entities: [{ id: 'e1', name: 'Mira', images: [{ mediaId: 'm1' }] }]
    });

    it('refuses a linked image that sits only in the list, keyed by id, and skips the { mediaId } gallery value', async () => {
      const refused = await publish(staff(), listed({
        m1: { id: 'm1', name: 'Wren', kind: 'image', data: LINK },
        m2: { id: 'm2', name: 'Fern', kind: 'image', data: TINY_PNG }
      }), { supporterOnly: true });
      expect(refused.status).toBe(400);
      expect(refused.body.linkedImages).toEqual([{ where: 'Media List image "Wren"', url: LINK }]);
    });

    it('refuses a linked sound and an unnamed entry, used or not', async () => {
      const refused = await publish(staff(), listed({
        m1: { id: 'm1', kind: 'image', data: LINK },
        m2: { id: 'm2', name: 'Theme', kind: 'sound', data: LINK_SOUND }
      }), { supporterOnly: true });
      expect(refused.status).toBe(400);
      expect(refused.body.linkedImages.map((l) => l.where)).toEqual(['Media List image #1', 'Media List sound "Theme"']);
    });

    it('accepts a list that holds only data URLs', async () => {
      const ok = await publish(staff(), listed({
        m1: { id: 'm1', name: 'Wren', kind: 'image', data: TINY_PNG },
        m2: { id: 'm2', name: 'Theme', kind: 'sound', data: AUDIO }
      }), { supporterOnly: true });
      expect(ok.status).toBe(201);
    });
  });

  it('flags a world with no linked images, and a Mascot never goes through the world check', async () => {
    const author = createUser();
    const mascot = await request(app).post('/api/worlds').set(authHeader(author))
      .send({ name: 'Mascot', kind: 'entity', thumbnail: TINY_PNG, contentData: { images: [{ data: LINK }] } });
    expect(mascot.status).toBe(201);
    expect((await flag(mascot.body.data.id)).status).toBe(200);
  });
});

describe('the dependency routes (R30)', () => {
  const declare = (owner, id, sourceIds) =>
    request(app).put(`/api/worlds/${id}/dependencies`).set(authHeader(owner)).send({ sourceIds });
  const dependencyContent = (worldId, sourceId) => request(app).get(`/api/worlds/${worldId}/dependencies/${sourceId}/content`);

  it("serves a Supporter-only world's public required source and add-on", async () => {
    const { id, author } = await flagged();
    const source = (await request(app).post('/api/worlds').set(authHeader(createUser()))
      .send({ name: 'Public Source', kind: 'entity', thumbnail: TINY_PNG, contentData: { name: 'x' } })).body.data;
    expect((await declare(author, id, [source.id])).status).toBe(200);

    const resolved = await request(app).get(`/api/worlds/${id}/dependencies`);
    expect(resolved.body.data.dependencies).toMatchObject([{ id: source.id, status: 'ok' }]);
    expect((await dependencyContent(id, source.id)).status).toBe(200);

    const componentAuthor = createUser();
    const component = (await request(app).post('/api/worlds').set(authHeader(componentAuthor))
      .send({ name: 'Add-on', kind: 'entity', thumbnail: TINY_PNG, contentData: { name: 'y' } })).body.data;
    expect((await request(app).put(`/api/worlds/${component.id}/compatibility`).set(authHeader(componentAuthor)).send({ worldIds: [id] })).status).toBe(200);

    const addons = await request(app).get(`/api/worlds/${id}/addons`);
    expect(addons.status).toBe(200);
    expect(addons.body.data.map((a) => a.id)).toEqual([component.id]);
  });

  it('refuses a Supporter-only dependency of a Supporter-only world', async () => {
    const { id, author } = await flagged();
    const source = (await request(app).post('/api/worlds').set(authHeader(createUser()))
      .send({ name: 'Locked Source', kind: 'entity', thumbnail: TINY_PNG, contentData: { name: 'z' } })).body.data;
    expect((await flag(source.id)).status).toBe(200);
    expect((await declare(author, id, [source.id])).status).toBe(200);

    expect((await dependencyContent(id, source.id)).status).toBe(403);
  });
});
