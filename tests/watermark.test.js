import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './context.js';
import { createUser } from './helpers.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { embed, read } = require('../src/utils/watermark');
const WatermarkMark = require('../src/models/WatermarkMark');
const { readLeak, describeLeak } = require('../src/utils/readLeak');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MORPHIE = path.join(ROOT, 'tests/fixtures/morphie');
const LAYERS = fs.readdirSync(MORPHIE).filter((name) => name.endsWith('.webp')).sort();

// One expression of the rig, bottom layer first, as the app stacks it.
const RIG = ['base', 'blush', 'eyes-wide', 'eyebrows-raised', 'mouth-grin', 'arms-wave'].map((name) => `${name}.webp`);

/**
 * The Supporter-download watermark, on Morphie's real layers.
 *
 * The bar: every layer reads back exactly; the full composite and every layer at or above the opaque-area
 * floor read back after each attack; nothing unmarked reads as marked.
 */

// Measured: a window of base with 341k opaque pixels read 12 of 12 attacked copies, one with 270k read 11.
const OPAQUE_FLOOR = 340000;
const opaqueArea = (image) => {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) count++;
  return count;
};

/** Over the RGB of every pixel that is not fully transparent. */
const psnr = (a, b) => {
  let squared = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) squared += (a[i + ch] - b[i + ch]) ** 2;
    count += 3;
  }
  return 10 * Math.log10((255 * 255 * count) / squared);
};

const toImage = ({ data, info }) => ({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) });
const decode = async (input) => toImage(await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
const rawInput = (image) => sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length), {
  raw: { width: image.width, height: image.height, channels: 4 }
});

const ATTACKS = {
  'WebP at quality 50': async (image) => decode(await rawInput(image).webp({ quality: 50 }).toBuffer()),
  'a 50% downscale': async (image) => decode(await rawInput(image).resize(Math.round(image.width / 2), Math.round(image.height / 2)).png().toBuffer()),
  'a 20% crop around the center': async (image) => decode(await rawInput(image).extract({
    left: Math.round(image.width * 0.1), top: Math.round(image.height * 0.1), width: Math.round(image.width * 0.8), height: Math.round(image.height * 0.8)
  }).png().toBuffer()),
  'a 20% crop from one corner': async (image) => decode(await rawInput(image).extract({
    left: Math.round(image.width * 0.2), top: Math.round(image.height * 0.2), width: Math.round(image.width * 0.8), height: Math.round(image.height * 0.8)
  }).png().toBuffer())
};

/** The layers drawn over an opaque background, the way a screenshot of the Mascot sees them. */
const composite = async (layers, background = { r: 40, g: 60, b: 90 }) => {
  const { width, height } = layers[0];
  const png = await sharp({ create: { width, height, channels: 4, background: { ...background, alpha: 1 } } })
    .composite(layers.map((layer) => ({ input: Buffer.from(layer.data.buffer), raw: { width, height, channels: 4 } })))
    .png()
    .toBuffer();
  return decode(png);
};

const MARK = 0x5eed2026;
const OTHER = 0x0badf00d;
const source = {};
const marked = {};

beforeAll(async () => {
  for (const name of LAYERS) {
    source[name] = await decode(path.join(MORPHIE, name));
    marked[name] = embed(source[name], MARK);
  }
});

describe('embed and read', () => {
  it.each(LAYERS)('reads the exact copy of %s', (name) => {
    expect(read(marked[name])).toBe(MARK);
  });

  it.each(LAYERS)('keeps %s within 40 dB of its source and leaves alpha alone', (name) => {
    expect(psnr(source[name].data, marked[name].data)).toBeGreaterThanOrEqual(40);
    const before = source[name].data;
    const after = marked[name].data;
    for (let i = 3; i < before.length; i += 4) {
      if (after[i] !== before[i]) throw new Error(`alpha changed at pixel ${(i - 3) / 4}`);
      if (before[i] === 0 && (after[i - 1] !== before[i - 1] || after[i - 2] !== before[i - 2] || after[i - 3] !== before[i - 3])) {
        throw new Error(`transparent pixel ${(i - 3) / 4} changed color`);
      }
    }
  });

  it.each(Object.keys(ATTACKS))('reads every layer at or above the floor after %s', async (attack) => {
    const large = LAYERS.filter((name) => opaqueArea(source[name]) >= OPAQUE_FLOOR);
    expect(large).toContain('base.webp');
    for (const name of large) expect(read(await ATTACKS[attack](marked[name]))).toBe(MARK);
  });

  it.each(Object.keys(ATTACKS))('reads the composite after %s', async (attack) => {
    const rig = await composite(RIG.map((name) => marked[name]));
    expect(read(await ATTACKS[attack](rig))).toBe(MARK);
  });

  const BACKGROUNDS = [['blue', { r: 40, g: 60, b: 90 }], ['light', { r: 240, g: 240, b: 235 }], ['dark', { r: 20, g: 20, b: 20 }]];

  it.each(BACKGROUNDS.slice(1))('reads the composite over a %s background after it is re-encoded or downscaled', async (_, background) => {
    const rig = await composite(RIG.map((name) => marked[name]), background);
    expect(read(await ATTACKS['WebP at quality 50'](rig))).toBe(MARK);
    expect(read(await ATTACKS['a 50% downscale'](rig))).toBe(MARK);
  });

  // The rig is a small part of the frame, so most of what the reader sees carries no mark.
  it.each(BACKGROUNDS)('reads the composite as a screenshot inside a larger %s window', async (_, background) => {
    for (const mark of [MARK, OTHER]) {
      const rig = await composite(RIG.map((name) => (mark === MARK ? marked[name] : embed(source[name], mark))), background);
      const png = await sharp({ create: { width: 1600, height: 1900, channels: 4, background: { ...background, alpha: 1 } } })
        .composite([{ input: await rawInput(rig).png().toBuffer(), left: 357, top: 403 }])
        .png()
        .toBuffer();
      expect(read(await decode(png))).toBe(mark);
    }
  });

  it('reads the composite from a screenshot taken at twice its size', async () => {
    const rig = await composite(RIG.map((name) => marked[name]));
    expect(read(await decode(await rawInput(rig).resize(rig.width * 2, rig.height * 2).png().toBuffer()))).toBe(MARK);
  });

  it('tells two accounts apart', async () => {
    const other = embed(source['base.webp'], OTHER);
    expect(read(other)).toBe(OTHER);
    expect(read(await ATTACKS['WebP at quality 50'](other))).toBe(OTHER);
  });

  it.each(LAYERS)('reads unmarked %s as no mark', (name) => {
    expect(read(source[name])).toBeNull();
  });

  it('reads an unmarked composite, and its attacked copies, as no mark', async () => {
    const rig = await composite(RIG.map((name) => source[name]));
    expect(read(rig)).toBeNull();
    for (const attack of Object.values(ATTACKS)) expect(read(await attack(rig))).toBeNull();
  });

  it('refuses a mark that is not a 32-bit unsigned integer', () => {
    for (const bad of [-1, 2 ** 32, 1.5, '7']) expect(() => embed(source['base.webp'], bad)).toThrow(RangeError);
  });
});

describe('WatermarkMark', () => {
  it('gives an account one mark for good, and different accounts different marks', () => {
    const ada = createUser();
    const bo = createUser();
    const first = WatermarkMark.markFor(ada.id);
    expect(WatermarkMark.markFor(ada.id)).toBe(first);
    expect(WatermarkMark.markFor(bo.id)).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0xffffffff);
  });

  it('names the account behind a mark, and nobody for a mark no account holds', () => {
    const ada = createUser();
    const mark = WatermarkMark.markFor(ada.id);
    expect(WatermarkMark.accountFor(mark)).toEqual({ id: ada.id, username: ada.username });
    expect(WatermarkMark.accountFor((mark + 1) >>> 0)).toBeNull();
  });

  it('lets an erased account take its mark with it', () => {
    const ada = createUser();
    const mark = WatermarkMark.markFor(ada.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(ada.id);
    expect(WatermarkMark.accountFor(mark)).toBeNull();
  });
});

describe('read-leak', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-leak-'));

  it('names the account a leaked file was marked for', async () => {
    const ada = createUser();
    const copy = embed(source['base.webp'], WatermarkMark.markFor(ada.id));
    const file = path.join(tmp, 'leak.webp');
    await rawInput(copy).webp({ quality: 50 }).toFile(file);
    const line = describeLeak(await readLeak(file));
    expect(line).toContain(ada.id);
    expect(line).toContain(ada.username);
  });

  it('says when a mark names no account', () => {
    expect(describeLeak({ mark: 0x2a, account: null })).toBe('Mark 0x0000002a: no account holds it');
  });

  it('prints a no-mark line for an unmarked file, from the command line', () => {
    const run = spawnSync(process.execPath, ['src/utils/runReadLeak.js', path.join(MORPHIE, 'base.webp')], { cwd: ROOT, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('No mark found');
    expect(run.status).toBe(0);
  });
});
