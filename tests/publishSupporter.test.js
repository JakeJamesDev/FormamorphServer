import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, db, paths } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const World = require('../src/models/World');
const PatreonLink = require('../src/models/PatreonLink');
const { publishSupporter, readMascotCard } = require('../src/utils/publishSupporter');

/**
 * The staff upload script for Supporter Mascots: the listing exists Supporter-only and pinned from its
 * first committed row, its content never lands in the public area, and its thumbnail carries no card.
 */

afterEach(() => vi.restoreAllMocks());

const chunk = (fourCC, data) => {
  const header = Buffer.alloc(8);
  header.write(fourCC, 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

/** A Mascot tab export: a VP8X WebP of the Initial look with the card JSON in its XMP chunk. */
async function cardFile(card, size = 64) {
  const look = await sharp({ create: { width: size, height: size, channels: 4, background: '#3a7' } }).webp({ lossless: true }).toBuffer();
  const bitstream = look.subarray(12);
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x04 | 0x10; // XMP + alpha
  vp8x.writeUIntLE(size - 1, 4, 3);
  vp8x.writeUIntLE(size - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), bitstream, chunk('XMP ', Buffer.from(JSON.stringify(card)))]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const layer = async (color) => `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer()).toString('base64')}`;

const mascotCard = async (overrides = {}) => ({
  formamorphKind: 'mascot',
  version: 1,
  appVersion: '3.5.0',
  name: 'Fixture Mascot',
  images: [await layer('#c84'), await layer('#48c')],
  rig: { base: 0, layers: [{ id: 'l1', name: 'Wave', images: [1] }], mask: null, picks: {}, voice: 'default' },
  ...overrides
});

const staff = () => createUser({ accountType: 'admin' });
const row = (id) => db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);

describe('publishing a Supporter Mascot from the server', () => {
  it('creates the listing Supporter-only, pinned and approved, with its content only in the private area', async () => {
    const author = staff();
    const created = await publishSupporter({ card: await cardFile(await mascotCard()), author: author.username });

    const stored = row(created.id);
    expect(stored).toMatchObject({ kind: 'mascot', name: 'Fixture Mascot', supporter_only: 1, moderation_state: 'approved', author_id: author.id });
    expect(stored.pinned_at).toBeTruthy();
    expect(fs.existsSync(path.join(paths.SUPPORTER_PRIVATE_DIR, stored.content_file))).toBe(true);
    expect(fs.existsSync(path.join(paths.WORLDS_DIR, stored.content_file))).toBe(false);
  });

  it('refuses the public content route and serves the gated route to a Supporter', async () => {
    const created = await publishSupporter({ card: await cardFile(await mascotCard()), author: staff().username });
    expect((await request(app).get(`/api/worlds/${created.id}/content`)).status).toBe(403);

    const supporter = createUser();
    PatreonLink.link({ userId: supporter.id, patreonUserId: `p-${supporter.id}`, tier: 'supporter', pledgeStart: '2026-03-01T00:00:00.000+00:00', checkedAt: new Date().toISOString() });
    const gated = await request(app).get(`/api/worlds/${created.id}/supporter-content`).set(authHeader(supporter));
    expect(gated.status).toBe(200);
  });

  it('stores a thumbnail that carries no card data', async () => {
    const created = await publishSupporter({ card: await cardFile(await mascotCard()), author: staff().username });
    const thumbnail = fs.readFileSync(path.join(paths.THUMBNAILS_DIR, row(created.id).thumbnail_file));
    expect(thumbnail.includes(Buffer.from('formamorphKind'))).toBe(false);
    expect((await sharp(thumbnail).metadata()).width).toBe(64);
  });

  it('takes the name and description it is given over the card name', async () => {
    const created = await publishSupporter({ card: await cardFile(await mascotCard()), author: staff().username, name: 'Willow Fixture', description: 'Hi' });
    expect(row(created.id)).toMatchObject({ name: 'Willow Fixture', description: 'Hi' });
  });

  it.each([
    ['an unknown author', async () => ({ author: 'nobody-here' }), /No account/],
    ['a player author', async () => ({ author: createUser().username }), /not a staff account/],
    ['a file with no card', async () => ({ card: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).webp().toBuffer() }), /not a Mascot card/],
    ['a card of another kind', async () => ({ card: await cardFile(await mascotCard({ formamorphKind: 'entity' })) }), /not a Mascot card/],
    ['a card over the size cap', async () => ({ card: await cardFile(await mascotCard({ images: [`data:image/webp;base64,${Buffer.alloc(11 * 1024 * 1024, 1).toString('base64')}`] })) }), /over the 10MB limit/]
  ])('refuses %s and writes nothing', async (_label, options, message) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;
    const base = { card: await cardFile(await mascotCard()), author: staff().username };
    await expect(publishSupporter({ ...base, ...(await options()) })).rejects.toThrow(message);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n).toBe(before);
  });

  it('rolls back the row and removes its files when a step fails', async () => {
    vi.spyOn(World, 'pin').mockImplementation(() => { throw new Error('pin failed'); });
    const privateBefore = fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR).length;
    const thumbnailsBefore = fs.readdirSync(paths.THUMBNAILS_DIR).length;

    await expect(publishSupporter({ card: await cardFile(await mascotCard({ name: 'Rolled Back' })), author: staff().username })).rejects.toThrow('pin failed');

    expect(db.prepare("SELECT COUNT(*) AS n FROM worlds WHERE name = 'Rolled Back'").get().n).toBe(0);
    expect(fs.readdirSync(paths.SUPPORTER_PRIVATE_DIR)).toHaveLength(privateBefore);
    expect(fs.readdirSync(paths.THUMBNAILS_DIR)).toHaveLength(thumbnailsBefore);
  });
});

describe('reading a Mascot card file', () => {
  it('reads the card from a chunk after an odd-sized one', async () => {
    const card = await mascotCard({ name: 'Odd' });
    expect(readMascotCard(await cardFile(card, 63)).name).toBe('Odd');
  });
});
