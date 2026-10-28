import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scramble, unscramble, VERSION, GRID } = require('../src/utils/scramble');
const fixture = require('./fixtures/scramble-vectors.json');

// A copy of the client's vector file, so both implementations are pinned to one answer.
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

const gridOf = (size) => Math.ceil(size / GRID) * GRID;

// True when the tile at (col, row) differs between two images of one padded size.
const tileChanged = (a, b, width, height, tile) => {
  const tw = width / GRID;
  const th = height / GRID;
  const x0 = (tile % GRID) * tw;
  const y0 = Math.floor(tile / GRID) * th;
  for (let y = y0; y < y0 + th; y++) {
    for (let x = x0; x < x0 + tw; x++) {
      for (let c = 0; c < 4; c++) if (a[(y * width + x) * 4 + c] !== b[(y * width + x) * 4 + c]) return true;
    }
  }
  return false;
};

const hasContent = (data, width, height, tile) => {
  const tw = width / GRID;
  const th = height / GRID;
  const x0 = (tile % GRID) * tw;
  const y0 = Math.floor(tile / GRID) * th;
  for (let y = y0; y < y0 + th; y++) {
    for (let x = x0; x < x0 + tw; x++) if (data[(y * width + x) * 4 + 3] !== 0) return true;
  }
  return false;
};

const paddedSource = ({ source, sourceWidth, sourceHeight, scrambledWidth, scrambledHeight }) => {
  const out = new Uint8Array(scrambledWidth * scrambledHeight * 4);
  for (let y = 0; y < sourceHeight; y++) out.set(source.subarray(y * sourceWidth * 4, (y + 1) * sourceWidth * 4), y * scrambledWidth * 4);
  return out;
};

const vectors = fixture.vectors.map((v) => ({ ...v, source: fromBase64(v.source), scrambled: fromBase64(v.scrambled) }));

describe('scramble vectors', () => {
  it('covers an unaligned size, a tiny layer, and two seeds on one source', () => {
    expect(vectors.some((v) => v.sourceWidth % GRID && v.sourceHeight % GRID)).toBe(true);
    expect(vectors.some((v) => v.sourceWidth < GRID && v.sourceHeight < GRID + 1)).toBe(true);
    const sizes = vectors.map((v) => `${v.sourceWidth}x${v.sourceHeight}`);
    expect(sizes.filter((s) => s === '16x16').length).toBeGreaterThanOrEqual(2);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      const image = { width: v.sourceWidth, height: v.sourceHeight, data: v.source };

      it('scrambles to the committed bytes', () => {
        const out = scramble(image, v.seed);
        expect(out.version).toBe(v.version);
        expect(out.version).toBe(VERSION);
        expect([out.width, out.height]).toEqual([v.scrambledWidth, v.scrambledHeight]);
        expect([out.sourceWidth, out.sourceHeight]).toEqual([v.sourceWidth, v.sourceHeight]);
        expect(Buffer.from(out.data).equals(Buffer.from(v.scrambled))).toBe(true);
      });

      it('unscrambles to the source exactly', () => {
        const back = unscramble(
          { width: v.scrambledWidth, height: v.scrambledHeight, data: v.scrambled },
          { seed: v.seed, version: v.version, sourceWidth: v.sourceWidth, sourceHeight: v.sourceHeight },
        );
        expect([back.width, back.height]).toEqual([v.sourceWidth, v.sourceHeight]);
        expect(Buffer.from(back.data).equals(Buffer.from(v.source))).toBe(true);
      });

      it('moves every tile that holds art', () => {
        const padded = paddedSource(v);
        for (let tile = 0; tile < GRID * GRID; tile++) {
          if (!hasContent(padded, v.scrambledWidth, v.scrambledHeight, tile)) continue;
          expect(tileChanged(padded, v.scrambled, v.scrambledWidth, v.scrambledHeight, tile), `tile ${tile}`).toBe(true);
        }
      });
    });
  }
});

describe('scramble', () => {
  const v = vectors.find((x) => x.name === 'unaligned-21x13');
  const image = { width: v.sourceWidth, height: v.sourceHeight, data: v.source };

  it('is deterministic for a seed', () => {
    const a = scramble(image, 99);
    const b = scramble(image, 99);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('gives two seeds two different outputs', () => {
    const a = scramble(image, 1);
    const b = scramble(image, 2);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
  });

  it('pads each axis to a multiple of the grid with transparent pixels', () => {
    const out = scramble(image, 5);
    expect([out.width, out.height]).toEqual([gridOf(21), gridOf(13)]);
    const restored = unscramble(out, { seed: 5, version: VERSION, sourceWidth: 21, sourceHeight: 13 });
    expect(Buffer.from(restored.data).equals(Buffer.from(v.source))).toBe(true);
  });

  it('refuses an unknown version and a bad seed', () => {
    const out = scramble(image, 5);
    const params = { seed: 5, sourceWidth: 21, sourceHeight: 13 };
    expect(() => unscramble(out, { ...params, version: 2 })).toThrow(/version/);
    expect(() => scramble(image, -1)).toThrow(/seed/);
    expect(() => scramble(image, 1.5)).toThrow(/seed/);
    expect(() => scramble(image, 2 ** 32)).toThrow(/seed/);
  });
});
