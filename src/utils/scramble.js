/**
 * A versioned tile shuffle that hides an image until the client unscrambles it.
 *
 * `scramble(image, seed)` works on raw `{ width, height, data }` RGBA buffers, with no image library and no I/O.
 * Format version 1: the image is padded with transparent pixels to a multiple of 8 on each axis, cut into
 * a fixed 8x8 grid of equal tiles, and the tiles move by a permutation with no fixed point. The permutation
 * is Sattolo's shuffle driven by mulberry32 over the 32-bit unsigned seed. Destination tile i holds source
 * tile `permutation[i]`. The client copies this algorithm; both test against `tests/fixtures/scramble-vectors.json`.
 */

const VERSION = 1;
const GRID = 8;
const TILES = GRID * GRID;
const BYTES = 4;

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Sattolo's shuffle yields one cycle through all tiles, so no tile stays in its source position.
const permutationFor = (seed) => {
  const next = mulberry32(seed);
  const order = Array.from({ length: TILES }, (_, i) => i);
  for (let i = TILES - 1; i > 0; i--) {
    const j = Math.floor(next() * i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

const paddedSize = (size) => Math.ceil(size / GRID) * GRID;

const assertSeed = (seed) => {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a 32-bit unsigned integer');
};

const assertVersion = (version) => {
  if (version !== VERSION) throw new RangeError(`unknown scramble version ${version}`);
};

// Copies tile `from` of `source` into tile `to` of `target`; both buffers share one padded size.
const copyTile = (source, target, width, tileWidth, tileHeight, from, to) => {
  const fromX = (from % GRID) * tileWidth;
  const fromY = Math.floor(from / GRID) * tileHeight;
  const toX = (to % GRID) * tileWidth;
  const toY = Math.floor(to / GRID) * tileHeight;
  const rowBytes = tileWidth * BYTES;
  for (let row = 0; row < tileHeight; row++) {
    const start = ((fromY + row) * width + fromX) * BYTES;
    target.set(source.subarray(start, start + rowBytes), ((toY + row) * width + toX) * BYTES);
  }
};

const shuffle = (padded, width, height, seed, inverse) => {
  const permutation = permutationFor(seed);
  const tileWidth = width / GRID;
  const tileHeight = height / GRID;
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < TILES; i++) {
    if (inverse) copyTile(padded, out, width, tileWidth, tileHeight, i, permutation[i]);
    else copyTile(padded, out, width, tileWidth, tileHeight, permutation[i], i);
  }
  return out;
};

/**
 * @param {{ width: number, height: number, data: Uint8Array }} image - RGBA source
 * @param {number} seed - 32-bit unsigned integer
 * @returns {{ width: number, height: number, data: Uint8Array, sourceWidth: number, sourceHeight: number, version: number }}
 *   The padded, scrambled image and the source size the client crops back to.
 */
const scramble = ({ width, height, data }, seed) => {
  assertSeed(seed);
  const padWidth = paddedSize(width);
  const padHeight = paddedSize(height);
  const padded = new Uint8Array(padWidth * padHeight * BYTES);
  for (let y = 0; y < height; y++) padded.set(data.subarray(y * width * BYTES, (y + 1) * width * BYTES), y * padWidth * BYTES);
  return {
    width: padWidth,
    height: padHeight,
    data: shuffle(padded, padWidth, padHeight, seed, false),
    sourceWidth: width,
    sourceHeight: height,
    version: VERSION,
  };
};

/**
 * The inverse of `scramble`. The server never calls it; the tests use it to prove the format round-trips.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} image - the scrambled, padded image
 * @param {{ seed: number, version: number, sourceWidth: number, sourceHeight: number }} params
 * @returns {{ width: number, height: number, data: Uint8Array }} The source image
 */
const unscramble = ({ width, height, data }, { seed, version, sourceWidth, sourceHeight }) => {
  assertVersion(version);
  assertSeed(seed);
  const padded = shuffle(data, width, height, seed, true);
  const out = new Uint8Array(sourceWidth * sourceHeight * BYTES);
  for (let y = 0; y < sourceHeight; y++) out.set(padded.subarray(y * width * BYTES, y * width * BYTES + sourceWidth * BYTES), y * sourceWidth * BYTES);
  return { width: sourceWidth, height: sourceHeight, data: out };
};

module.exports = { scramble, unscramble, VERSION, GRID };
