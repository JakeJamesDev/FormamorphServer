/**
 * An invisible mark that names the account a copy of an image was made for.
 *
 * `embed(image, mark)` writes a 32-bit mark number into an RGBA image; `read(image)` finds it again or
 * returns null. Both work on raw `{ width, height, data }` RGBA buffers, so the module has no image
 * library and no I/O; callers decode and encode with `sharp`.
 *
 * The mark lives in the luma of opaque pixels, in two frequency bands that carry the same codeword:
 *
 * - **Coarse band.** A grid of 8 px cells, anchored at the image origin. Each cell's coefficient on a
 *   separable sine basis (one period per axis) is pushed up or down by one chip. Cells repeat in 16x16
 *   tiles; a quarter of each tile is known pilot chips, which find the grid in a cropped copy. Faint
 *   sinusoids of known periods ride along, so the reader can measure scale. This band survives one
 *   re-encode, resize or crop, and compositing; `docs-internal/server.md` lists what it does not.
 * - **Fine band.** Each 2x2 block's HH (Haar) coefficient carries one chip, placed by absolute position.
 *   It holds far more chips per pixel, so it reads the exact copy of even a tiny layer, and nothing else.
 *
 * The codeword is the mark plus its CRC-32 under a rate-1/2 convolutional code, decoded by soft Viterbi.
 * A read is accepted only when the CRC holds and, on the coarse band, the pilots stand out (`MIN_Z`). An
 * unmarked image usually gets two decode attempts, so it reads as marked about once in four billion.
 */

const CELL = 8;
const TILE = 16;
const PILOTS = 64;
const CHIP_AMP = 3;
const SYNC_AMP = 0.3;
const SYNC_PERIODS = [17.3, 21.1, 25.7];
const FINE_AMP = 1;
const FINE_MAX = 2;
// A cell reading beyond this many mark amplitudes is dominated by the art and is skipped.
const GATE = 2;
// A quarter of a clean chip's response; a cell below it carries no mark worth weighing.
const MARK_FLOOR = CHIP_AMP * (CELL / 2) ** 2 / 4;
// Unmarked images clear this about once in a hundred tries; the CRC must still hold after it.
const MIN_Z = 6;
// Unmarked images peak below 2.4 over their median; marked half-size composites read 3.9 and above.
const SYNC_RATIO = 3;
const MAX_SCALE_GUESSES = 4;
const MAX_NATIVE_AREA = 2.5e6;
const MARK_BYTES = 4;
const CRC_BYTES = 4;
// Scales a median absolute deviation to a standard deviation.
const MAD_TO_SIGMA = 1.4826;
// Pixels at least this opaque count as solid art for the sync and cell responses.
const SOLID = 0.99;

// --- codeword ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Rate-1/2, constraint length 7, generators 133 and 171 (octal).
const K = 7;
const GENERATORS = [0o133, 0o171];
const INFO_BITS = (MARK_BYTES + CRC_BYTES) * 8;
const CODED_BITS = (INFO_BITS + K - 1) * 2;

const parity = (x) => {
  x ^= x >> 4; x ^= x >> 2; x ^= x >> 1;
  return x & 1;
};

const convEncode = (bits) => {
  const out = [];
  let reg = 0;
  for (const b of [...bits, ...new Array(K - 1).fill(0)]) {
    reg = ((reg << 1) | b) & 0x7f;
    for (const g of GENERATORS) out.push(parity(reg & g));
  }
  return out;
};

/** @param {Float64Array} soft - Per coded bit, positive for 1 and negative for 0 */
const viterbi = (soft) => {
  const states = 1 << (K - 1);
  const steps = INFO_BITS + K - 1;
  let metric = new Float64Array(states).fill(-Infinity);
  metric[0] = 0;
  const back = [];
  for (let t = 0; t < steps; t++) {
    const next = new Float64Array(states).fill(-Infinity);
    const from = new Int32Array(states);
    for (let st = 0; st < states; st++) {
      if (metric[st] === -Infinity) continue;
      for (let b = 0; b <= (t < INFO_BITS ? 1 : 0); b++) {
        const reg = ((st << 1) | b) & 0x7f;
        let m = metric[st];
        for (let j = 0; j < 2; j++) m += parity(reg & GENERATORS[j]) ? soft[2 * t + j] : -soft[2 * t + j];
        const ns = reg & (states - 1);
        if (m > next[ns]) { next[ns] = m; from[ns] = st; }
      }
    }
    back.push(from);
    metric = next;
  }
  const bits = new Array(steps);
  let st = 0;
  for (let t = steps - 1; t >= 0; t--) { bits[t] = st & 1; st = back[t][st]; }
  return bits.slice(0, INFO_BITS);
};

const markBytes = (mark) => {
  const bytes = new Uint8Array(MARK_BYTES + CRC_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, mark);
  view.setUint32(MARK_BYTES, crc32(bytes.subarray(0, MARK_BYTES)));
  return bytes;
};

const codeword = (mark) => {
  const bits = [];
  for (const b of markBytes(mark)) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return convEncode(bits);
};

/** @returns {number|null} The mark, when the decoded bits pass their CRC */
const decodeSoft = (soft) => {
  const bits = viterbi(soft);
  const bytes = new Uint8Array(INFO_BITS / 8);
  bits.forEach((bit, i) => { bytes[i >> 3] |= bit << (7 - (i & 7)); });
  const view = new DataView(bytes.buffer);
  const mark = view.getUint32(0);
  return crc32(bytes.subarray(0, MARK_BYTES)) === view.getUint32(MARK_BYTES) ? mark : null;
};

// --- layout ---

const xorshift = (seed) => {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};

// Each tile chip is a pilot (bit -1) or carries one coded bit, under a fixed sign.
const LAYOUT = (() => {
  const n = TILE * TILE;
  const next = xorshift(0x5eed1e55);
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const sign = new Int8Array(n);
  const bit = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) sign[i] = next() < 0.5 ? -1 : 1;
  order.forEach((pos, i) => { if (i >= PILOTS) bit[pos] = (i - PILOTS) % CODED_BITS; });
  return { sign, bit };
})();

const PILOT_CHIPS = [...Array(TILE * TILE).keys()].filter((k) => LAYOUT.bit[k] < 0);

// One full sine period per cell: zero at the cell's edges, so neighboring chips leave no visible grid.
const BASIS = Float64Array.from({ length: CELL }, (_, u) => Math.sin(2 * Math.PI * (u + 0.5) / CELL));

const fineChip = (bx, by) => {
  let h = Math.imul(bx + 0x9e37, 0x85ebca6b) ^ Math.imul(by + 0x79b9, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 13;
  return { bit: (h >>> 1) % CODED_BITS, sign: h & 1 ? 1 : -1 };
};

// The HH weights of a 2x2 block, as [dx, dy, weight].
const QUAD = [[0, 0, 1], [1, 0, -1], [0, 1, -1], [1, 1, 1]];

const lumaAt = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

// --- embed ---

const embedCoarse = (source, out, width, height, code) => {
  const chip = Float64Array.from({ length: TILE * TILE }, (_, k) => {
    const value = LAYOUT.bit[k] < 0 ? 1 : (code[LAYOUT.bit[k]] ? 1 : -1);
    return LAYOUT.sign[k] * value;
  });
  const syncX = new Float64Array(width);
  const syncY = new Float64Array(height);
  for (const period of SYNC_PERIODS) {
    for (let x = 0; x < width; x++) syncX[x] += Math.cos(2 * Math.PI * x / period);
    for (let y = 0; y < height; y++) syncY[y] += Math.cos(2 * Math.PI * y / period);
  }

  for (let cy = 0; cy * CELL < height; cy++) {
    for (let cx = 0; cx * CELL < width; cx++) {
      const delta = CHIP_AMP * chip[(cy % TILE) * TILE + (cx % TILE)];
      for (let v = 0; v < CELL; v++) for (let u = 0; u < CELL; u++) {
        const x = cx * CELL + u;
        const y = cy * CELL + v;
        if (x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        if (source[i + 3] === 0) continue;
        const d = delta * BASIS[u] * BASIS[v] + SYNC_AMP * (syncX[x] + syncY[y]);
        out[i] = source[i] + d;
        out[i + 1] = source[i + 1] + d;
        out[i + 2] = source[i + 2] + d;
      }
    }
  }
};

const embedFine = (out, width, height, code) => {
  for (let by = 0; 2 * by + 1 < height; by++) {
    for (let bx = 0; 2 * bx + 1 < width; bx++) {
      const at = QUAD.map(([u, v, w]) => [((2 * by + v) * width + 2 * bx + u) * 4, w]);
      if (at.some(([i]) => out[i + 3] === 0)) continue;
      const hh = at.reduce((sum, [i, w]) => sum + w * lumaAt(out, i), 0) / 4;
      const { bit, sign } = fineChip(bx, by);
      const want = FINE_AMP * sign * (code[bit] ? 1 : -1) - hh;
      // Art too busy here to move without showing; the reader skips such blocks too.
      if (Math.abs(want) > FINE_MAX + 0.5) continue;
      const d = Math.round(want) || Math.sign(want);
      const clips = at.some(([i, w]) => [0, 1, 2].some((ch) => out[i + ch] + w * d < 0 || out[i + ch] + w * d > 255));
      if (clips) continue;
      for (const [i, w] of at) for (let ch = 0; ch < 3; ch++) out[i + ch] += w * d;
    }
  }
};

/**
 * Mark a copy of an image. Alpha is left as it was, bit for bit.
 *
 * @param {Object} image - `{ width, height, data }`, RGBA, 8 bits per channel
 * @param {number} mark - The 32-bit mark number to carry
 * @returns {Object} A new image of the same shape
 */
const embed = (image, mark) => {
  const { width, height, data } = image;
  if (!Number.isInteger(mark) || mark < 0 || mark > 0xffffffff) throw new RangeError('A mark is a 32-bit unsigned integer');
  const code = codeword(mark);
  const out = new Uint8ClampedArray(data);
  embedCoarse(data, out, width, height, code);
  embedFine(out, width, height, code);
  return { width, height, data: out };
};

// --- read ---

const lumaPlanes = ({ width, height, data }) => {
  const n = width * height;
  const Y = new Float64Array(n);
  const W = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    W[p] = data[p * 4 + 3] / 255;
    Y[p] = W[p] > 0 ? lumaAt(data, p * 4) : 0;
  }
  return { Y, W, width, height };
};

const readFine = ({ Y, W, width, height }) => {
  const soft = new Float64Array(CODED_BITS);
  let used = 0;
  for (let by = 0; 2 * by + 1 < height; by++) {
    for (let bx = 0; 2 * bx + 1 < width; bx++) {
      let hh = 0;
      let opaque = true;
      for (const [u, v, w] of QUAD) {
        const p = (2 * by + v) * width + 2 * bx + u;
        if (W[p] === 0) opaque = false;
        hh += w * Y[p];
      }
      if (!opaque) continue;
      const r = hh / 4 / FINE_AMP;
      if (Math.abs(r) > GATE) continue;
      const { bit, sign } = fineChip(bx, by);
      soft[bit] += sign * r;
      used++;
    }
  }
  return used ? decodeSoft(soft) : null;
};

/** The magnitude of one frequency in a profile, by rotating a phasor rather than calling trig per sample. */
const toneMagnitude = (profile, period) => {
  const step = 2 * Math.PI / period;
  const cs = Math.cos(step);
  const sn = Math.sin(step);
  let c = 1;
  let s = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < profile.length; i++) {
    re += profile[i] * c;
    im += profile[i] * s;
    const nc = c * cs - s * sn;
    s = s * cs + c * sn;
    c = nc;
  }
  return Math.hypot(re, im);
};

/** Row and column sums of a clipped second difference `d` px wide, where the sync tones show. */
const syncProfiles = ({ Y, W, width, height }, d) => {
  // Tight, so the art's edges drown the faint tones less.
  const clip = 4;
  const px = new Float64Array(width);
  const py = new Float64Array(height);
  for (let y = 0; y < height; y++) for (let x = d; x < width - d; x++) {
    const p = y * width + x;
    if (W[p] < SOLID || W[p - d] < SOLID || W[p + d] < SOLID) continue;
    px[x] += Math.max(-clip, Math.min(clip, 2 * Y[p] - Y[p - d] - Y[p + d]));
  }
  for (let y = d; y < height - d; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    const up = p - d * width;
    const down = p + d * width;
    if (W[p] < SOLID || W[up] < SOLID || W[down] < SOLID) continue;
    py[y] += Math.max(-clip, Math.min(clip, 2 * Y[p] - Y[up] - Y[down]));
  }
  return { px, py };
};

/** Local score peaks over one range of scales, each as its ratio to that range's median. */
const syncPeaks = (planes, d, from, to) => {
  const { px, py } = syncProfiles(planes, d);
  const scores = [];
  for (let ls = Math.log(from); ls < Math.log(to); ls += 0.002) {
    const s = Math.exp(ls);
    if (SYNC_PERIODS[0] * s < 2.5) continue;
    let score = 0;
    for (const period of SYNC_PERIODS) {
      score += toneMagnitude(px, period * s) / Math.sqrt(planes.width) + toneMagnitude(py, period * s) / Math.sqrt(planes.height);
    }
    scores.push({ s, score });
  }
  const sorted = scores.map((e) => e.score).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] || 1;
  return scores
    .filter((e, i) => (i === 0 || e.score >= scores[i - 1].score) && (i === scores.length - 1 || e.score >= scores[i + 1].score))
    .map((e) => ({ s: e.s, ratio: e.score / median }));
};

/**
 * Scales the sync tones say the image was resized by, strongest first; none when no tone stands out.
 * An enlarged copy stretches the tones, so it is searched with a difference twice as wide.
 */
const scaleGuesses = (planes) => [...syncPeaks(planes, 2, 0.2, 1.4), ...syncPeaks(planes, 4, 1.4, 2.5)]
  .filter((e) => e.ratio >= SYNC_RATIO)
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, MAX_SCALE_GUESSES)
  .map((e) => e.s);

/** Resample so the image is back at the size it was marked at, given it was resized by `s`. */
const toNative = (planes, s) => {
  if (s === 1) return planes;
  const { Y, W, width, height } = planes;
  const nw = Math.max(1, Math.round(width / s));
  const nh = Math.max(1, Math.round(height / s));
  const nY = new Float64Array(nw * nh);
  const nW = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * s - 0.5;
      const sy = (y + 0.5) * s - 0.5;
      let sumY = 0;
      let sumW = 0;
      let total = 0;
      if (s > 1) {
        // Shrinking: average the source pixels the output pixel covers.
        const x0 = Math.max(0, Math.ceil(sx - s / 2));
        const x1 = Math.min(width - 1, Math.floor(sx + s / 2));
        const y0 = Math.max(0, Math.ceil(sy - s / 2));
        const y1 = Math.min(height - 1, Math.floor(sy + s / 2));
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
          const p = yy * width + xx;
          sumY += Y[p] * W[p]; sumW += W[p]; total++;
        }
      } else {
        const fx = Math.floor(sx);
        const fy = Math.floor(sy);
        const tx = sx - fx;
        const ty = sy - fy;
        for (const [xx, yy, w] of [[fx, fy, (1 - tx) * (1 - ty)], [fx + 1, fy, tx * (1 - ty)], [fx, fy + 1, (1 - tx) * ty], [fx + 1, fy + 1, tx * ty]]) {
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const p = yy * width + xx;
          sumY += Y[p] * W[p] * w; sumW += W[p] * w; total += w;
        }
      }
      const q = y * nw + x;
      nW[q] = total > 0 ? sumW / total : 0;
      nY[q] = sumW > 0 ? sumY / sumW : 0;
    }
  }
  return { Y: nY, W: nW, width: nw, height: nh };
};

/**
 * Every pixel's response to the cell basis, and those responses folded into one tile, so one pass of
 * pilot correlation finds the grid at any crop offset.
 */
const cellResponses = ({ Y, W, width, height }) => {
  const rw = width - CELL + 1;
  const rh = height - CELL + 1;
  if (rw < 1 || rh < 1) return null;
  const rows = new Float64Array(rw * height);
  const rowsOpaque = new Uint8Array(rw * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < rw; x++) {
    let s = 0;
    let opaque = 1;
    for (let u = 0; u < CELL; u++) {
      const p = y * width + x + u;
      s += BASIS[u] * Y[p];
      if (W[p] < SOLID) opaque = 0;
    }
    rows[y * rw + x] = s;
    rowsOpaque[y * rw + x] = opaque;
  }
  const R = new Float64Array(rw * rh);
  const opaque = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    let s = 0;
    let o = 1;
    for (let v = 0; v < CELL; v++) {
      const p = (y + v) * rw + x;
      s += BASIS[v] * rows[p];
      o &= rowsOpaque[p];
    }
    R[y * rw + x] = s;
    opaque[y * rw + x] = o;
  }
  const sample = [];
  for (let i = 0; i < R.length; i += 7) if (opaque[i]) sample.push(Math.abs(R[i]));
  if (sample.length < 20) return null;
  sample.sort((a, b) => a - b);
  // Flat unmarked area, such as a wide background, reads near zero and would pull the median down with it.
  const spread = Math.max(sample[sample.length >> 1] * MAD_TO_SIGMA, MARK_FLOOR);
  const T = TILE * CELL;
  const folded = new Float64Array(T * T);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = y * rw + x;
    if (opaque[p]) folded[(y % T) * T + (x % T)] += Math.max(-3, Math.min(3, R[p] / spread));
  }
  return { folded, R, opaque, rw, rh };
};

/** Find the grid by its pilots, then decode the cells at that offset. */
const readCoarse = ({ folded, R, opaque, rw, rh }) => {
  const T = TILE * CELL;
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  let squares = 0;
  for (let dy = 0; dy < T; dy++) for (let dx = 0; dx < T; dx++) {
    let s = 0;
    for (const k of PILOT_CHIPS) {
      s += LAYOUT.sign[k] * folded[((dy + ((k / TILE) | 0) * CELL) % T) * T + ((dx + (k % TILE) * CELL) % T)];
    }
    squares += s * s;
    if (s > best) { best = s; bx = dx; by = dy; }
  }
  if (best / Math.sqrt(squares / (T * T)) < MIN_Z) return null;

  const cells = [];
  for (let y = by % CELL; y < rh; y += CELL) for (let x = bx % CELL; x < rw; x += CELL) {
    const p = y * rw + x;
    if (!opaque[p]) continue;
    const cx = (((x % T) - bx + T) % T) / CELL;
    const cy = (((y % T) - by + T) % T) / CELL;
    cells.push([cy * TILE + cx, R[p]]);
  }
  // Unmarked flat cells, such as a background, read near zero, so only pilots above the floor set the amplitude.
  const strong = cells.filter(([k, r]) => LAYOUT.bit[k] < 0 && Math.abs(r) >= MARK_FLOOR);
  const amplitude = strong.reduce((sum, [k, r]) => sum + LAYOUT.sign[k] * r, 0) / (strong.length || 1);
  if (!(amplitude > 0)) return null;
  const soft = new Float64Array(CODED_BITS);
  for (const [k, r] of cells) {
    const v = r / amplitude;
    if (LAYOUT.bit[k] >= 0 && Math.abs(v) <= GATE) soft[LAYOUT.bit[k]] += LAYOUT.sign[k] * v;
  }
  return decodeSoft(soft);
};

/**
 * Find the mark in an image: an exact copy, or one that was re-encoded, resized, cropped, or drawn over a
 * background with other marked layers.
 *
 * @param {Object} image - `{ width, height, data }`, RGBA, 8 bits per channel
 * @returns {number|null} The mark number, or null when no mark is found
 */
const read = (image) => {
  const planes = lumaPlanes(image);
  const exact = readFine(planes);
  if (exact !== null) return exact;

  for (const guess of [1, ...scaleGuesses(planes)]) {
    if (guess < 1 && (planes.width / guess) * (planes.height / guess) > MAX_NATIVE_AREA) continue;
    // A grid drifts a cell's width across the image at under half a percent of scale error.
    const steps = guess === 1 ? [0] : [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6];
    for (const step of steps) {
      const responses = cellResponses(toNative(planes, guess * (1 + step * 0.001)));
      const mark = responses && readCoarse(responses);
      if (mark !== null) return mark;
    }
  }
  return null;
};

module.exports = { embed, read };
