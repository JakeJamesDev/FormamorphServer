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

// Measured: windows of base with 308k to 415k opaque pixels read 12 of 12 attacked copies each.
const OPAQUE_FLOOR = 310000;
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

/** Over the luma of every pixel that is not fully transparent, where the eye sees a pattern most. */
const lumaPsnr = (a, b) => {
  const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let squared = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0) continue;
    squared += (luma(a, i) - luma(b, i)) ** 2;
    count++;
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

const webp50 = async (image) => decode(await rawInput(image).webp({ quality: 50 }).toBuffer());
// JPEG has no alpha, so a layer lands on a background first, as any JPEG screenshot of it would.
const jpeg75 = async (image) => decode(await rawInput(image).flatten({ background: '#28405a' }).jpeg({ quality: 75 }).toBuffer());
const shifted = async (image, dx, dy) => decode(await rawInput(image).extract({
  left: dx, top: dy, width: image.width - dx, height: image.height - dy
}).png().toBuffer());
const halved = async (image) => ATTACKS['a 50% downscale'](image);

// Each offset off WebP's 4 px transform blocks, on each axis, then a lossy save.
const SHIFTS = [[1, 0], [2, 0], [3, 0], [0, 1], [0, 2], [0, 3]];
const LOSSY = { 'WebP at quality 50': webp50, 'JPEG at quality 75': jpeg75 };

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

  // The smallest layers are mostly line art, where the fine band has the least room; 100 marks over every
  // layer read back with no miss when measured.
  it('reads the exact copy of the smallest layers for any mark', () => {
    expect(read(embed(source['arms-no-thinking.webp'], 2145859145))).toBe(2145859145);
    let seed = 0x2026;
    for (let n = 0; n < 50; n++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      for (const name of ['arms-no-thinking.webp', 'eyes-blank.webp']) expect(read(embed(source[name], seed)), `mark ${seed}`).toBe(seed);
    }
  }, 30000);

  // The coarse band moves only blue-yellow, which costs RGB PSNR without showing; luma barely moves.
  it.each(LAYERS)('keeps %s within 36 dB of its source, 45 dB in luma, and leaves alpha alone', (name) => {
    expect(psnr(source[name].data, marked[name].data)).toBeGreaterThanOrEqual(36);
    expect(lumaPsnr(source[name].data, marked[name].data)).toBeGreaterThanOrEqual(45);
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

  describe.each([['base', () => marked['base.webp']], ['the composite', () => composite(RIG.map((name) => marked[name]))]])('%s', (_, subject) => {
    it.each(Object.keys(LOSSY))('reads after every 1-3 px offset and then %s', async (codec) => {
      const image = await subject();
      for (const [dx, dy] of SHIFTS) expect(read(await LOSSY[codec](await shifted(image, dx, dy))), `offset ${dx},${dy}`).toBe(MARK);
    });

    // Halved first, WebP's half-size chroma leaves the mark no room: that order is a known, accepted loss.
    it('reads after WebP at quality 50 and then a 50% downscale', async () => {
      expect(read(await halved(await webp50(await subject())))).toBe(MARK);
    });
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

  // Each copy runs the full scale search, about a second, so each gets its own case.
  const UNMARKED_COPIES = {
    'as it is': async (image) => image,
    ...ATTACKS,
    'shifted and saved WebP at quality 50': async (image) => webp50(await shifted(image, 3, 1)),
    'shifted and saved JPEG at quality 75': async (image) => jpeg75(await shifted(image, 1, 2)),
    'halved and saved WebP at quality 50': async (image) => webp50(await halved(image))
  };

  it.each(Object.keys(UNMARKED_COPIES))('reads an unmarked composite %s as no mark', async (copy) => {
    const rig = await composite(RIG.map((name) => source[name]));
    expect(read(await UNMARKED_COPIES[copy](rig))).toBeNull();
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
