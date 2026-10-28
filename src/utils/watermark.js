/**
 * An invisible mark that names the account a copy of an image was made for.
 *
 * `embed(image, mark)` writes a 32-bit mark number into an RGBA image; `read(image)` finds it again or
 * returns null. Both work on raw `{ width, height, data }` RGBA buffers, so the module has no image
 * library and no I/O; callers decode and encode with `sharp`.
 *
 * The mark lives in opaque pixels, in two bands that carry the same codeword:
 *
 * - **Coarse band**, on the blue-yellow axis, which leaves luma alone. A grid of 16 px cells, anchored at
 *   the image origin. Each cell's coefficient on a separable sine basis (one period per axis) is pushed up
 *   or down by one chip. Cells repeat in 16x16 tiles; a quarter of each tile is known pilot chips. The
 *   reader finds the scale by folding the image at each candidate tile period and looking for the pilots,
 *   then finds the grid offset the same way. Cells are weighted by how busy the art around them is.
 *   `docs-internal/server.md` lists what this band survives.
 * - **Fine band**, in luma. Each 2x2 block's HH (Haar) coefficient carries one chip, placed by absolute
 *   position. It reads the exact copy of even a tiny layer, and nothing else.
 *
 * The codeword is the mark plus its CRC-32 under a rate-1/2 convolutional code, decoded by soft Viterbi.
 * A read is accepted only when the CRC holds and, on the coarse band, the pilots stand out (`MIN_Z`). An
 * unmarked image gets one fine and at most four coarse decode attempts, so it reads as marked about once
 * in four billion.
 */

const CELL = 16;
const TILE = 16;
const PILOTS = 64;
// In blue-channel steps: about 37 dB, yet near-invisible, since the eye barely resolves blue-yellow at 16 px.
const CHIP_AMP = 12;
// A luma-neutral blue-yellow direction: blue up, red and green down so 0.299R + 0.587G + 0.114B stays put.
const CHROMA_DIR = [-0.114 / 0.886, -0.114 / 0.886, 1];
const FINE_AMP = 1;
const FINE_MAX = 2;
// A fine-band block reading beyond this many mark amplitudes is dominated by the art and is skipped.
const GATE = 2;
// Unmarked images clear this about once in a hundred tries; the CRC must still hold after it.
const MIN_Z = 6;
// A cell response is clipped to this many clean chips, so one hard edge cannot outvote its neighbors.
const CELL_CLIP = 4;
// Art energy, in clean-chip units, below which a cell counts as flat: flatter cells weigh no more.
const HOST_FLOOR = 0.5;
const MAX_NATIVE_AREA = 2.5e6;
const MARK_BYTES = 4;
const CRC_BYTES = 4;
// Pixels at least this opaque count as solid art for the cell responses and the scale search.
const SOLID = 0.99;

// The scale search: resize factors it covers, its log step, and how far each peak is then refined.
const SCALE_MIN = 0.25;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.007;
const SCALE_REFINE = 0.001;
// Bins per cell in the folded tile: 8 gains about 5% of z for twice the time, 4 loses 10%.
const FOLD_BINS = 6;
// Loose on purpose: unmarked images peak near 6 and halved WebP copies read 8+; MIN_Z and the CRC filter after.
const FOLD_Z = 5;
const MAX_FOLD_GUESSES = 3;
// In blue-minus-luma units: art flatter than this weighs no more in the scale search.
const FOLD_FLOOR = 4;
// Radii of the local mean the scale search removes and of the art energy it divides by.
const MEAN_RADIUS = 6;
const ENERGY_RADIUS = 4;
const FOLD_BLOCKS = [1, 2, 4, 8];
// Below this many solid pixels no copy carries enough mark at any scale, so the search is skipped.
const MIN_FOLD_AREA = 50000;

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
// The same period in cosine phase carries no mark, so it measures the art around a cell.
const COMPANION = Float64Array.from({ length: CELL }, (_, u) => Math.cos(2 * Math.PI * (u + 0.5) / CELL));

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
  for (let cy = 0; cy * CELL < height; cy++) {
    for (let cx = 0; cx * CELL < width; cx++) {
      const delta = CHIP_AMP * chip[(cy % TILE) * TILE + (cx % TILE)];
      for (let v = 0; v < CELL; v++) for (let u = 0; u < CELL; u++) {
        const x = cx * CELL + u;
        const y = cy * CELL + v;
        if (x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        if (source[i + 3] === 0) continue;
        const d = delta * BASIS[u] * BASIS[v];
        // Shrink the step where a channel would clip, so the clip cannot leak into luma.
        let fit = 1;
        for (let ch = 0; ch < 3; ch++) {
          const step = d * CHROMA_DIR[ch];
          if (source[i + ch] + step > 255) fit = Math.min(fit, (255 - source[i + ch]) / step);
          if (source[i + ch] + step < 0) fit = Math.min(fit, -source[i + ch] / step);
        }
        for (let ch = 0; ch < 3; ch++) out[i + ch] = source[i + ch] + fit * d * CHROMA_DIR[ch];
      }
    }
  }
};

// The most one pixel of a fine-band block moves, when its neighbors sit at black or white and cannot.
const FINE_PIXEL_MAX = 6;

/**
 * Moves a block's HH by `d` in whole luma steps, all channels together. Each step goes to the pixel moved
 * least so far that still has room, so a block on a black line rises where the plain pattern would clip.
 */
const shiftHH = (out, at, d) => {
  const moved = [0, 0, 0, 0];
  const room = at.map(([i]) => {
    const channels = [out[i], out[i + 1], out[i + 2]];
    return { up: 255 - Math.max(...channels), down: Math.min(...channels) };
  });
  for (let left = 4 * Math.abs(d); left > 0; left--) {
    let pick = -1;
    for (let k = 0; k < 4; k++) {
      const step = at[k][1] * Math.sign(d);
      const free = step > 0 ? room[k].up - moved[k] : room[k].down + moved[k];
      if (free < 1 || Math.abs(moved[k] + step) > FINE_PIXEL_MAX) continue;
      if (pick < 0 || Math.abs(moved[k]) < Math.abs(moved[pick])) pick = k;
    }
    if (pick < 0) return false;
    moved[pick] += at[pick][1] * Math.sign(d);
  }
  at.forEach(([i], k) => { for (let ch = 0; ch < 3; ch++) out[i + ch] += moved[k]; });
  return true;
};

const embedFine = (out, width, height, code) => {
  for (let by = 0; 2 * by + 1 < height; by++) {
    for (let bx = 0; 2 * bx + 1 < width; bx++) {
      const at = QUAD.map(([u, v, w]) => [((2 * by + v) * width + 2 * bx + u) * 4, w]);
      if (at.some(([i]) => out[i + 3] === 0)) continue;
      const hh = at.reduce((sum, [i, w]) => sum + w * lumaAt(out, i), 0) / 4;
      const { bit, sign } = fineChip(bx, by);
      const target = FINE_AMP * sign * (code[bit] ? 1 : -1);
      const want = target - hh;
      // Art too busy here to move without showing is left alone; the reader skips it past the gate.
      if (Math.abs(want) <= FINE_MAX + 0.5 && shiftHH(out, at, Math.round(want) || Math.sign(want))) continue;
      // A block the reader would count against its bit goes just past the gate instead.
      if (Math.abs(hh) <= GATE && hh * target <= 0) shiftHH(out, at, hh >= 0 ? Math.floor(GATE - hh) + 1 : -(Math.floor(GATE + hh) + 1));
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

/** Luma for the fine band, and blue minus luma for the coarse one. */
const planesOf = ({ width, height, data }) => {
  const n = width * height;
  const Y = new Float64Array(n);
  const C = new Float64Array(n);
  const W = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    W[p] = data[p * 4 + 3] / 255;
    if (W[p] === 0) continue;
    Y[p] = lumaAt(data, p * 4);
    C[p] = data[p * 4 + 2] - Y[p];
  }
  return { Y, C, W, width, height };
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

/** The mean over a (2r+1)^2 window of the values where `M` is set, from integral images. */
const boxMean = (V, M, width, height, r) => {
  const w1 = width + 1;
  const sums = new Float64Array(w1 * (height + 1));
  const counts = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    const q = (y + 1) * w1 + x + 1;
    sums[q] = V[p] * M[p] + sums[q - 1] + sums[q - w1] - sums[q - w1 - 1];
    counts[q] = M[p] + counts[q - 1] + counts[q - w1] - counts[q - w1 - 1];
  }
  const area = (A, x0, y0, x1, y1) => A[y1 * w1 + x1] - A[y0 * w1 + x1] - A[y1 * w1 + x0] + A[y0 * w1 + x0];
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - r);
    const x1 = Math.min(width, x + r + 1);
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height, y + r + 1);
    const c = area(counts, x0, y0, x1, y1);
    out[y * width + x] = c > 0 ? area(sums, x0, y0, x1, y1) / c : 0;
  }
  return out;
};

/**
 * The solid pixels' blue-yellow value with its local mean removed, each divided by the art's local
 * energy, so flat areas, where the mark stands out, count most.
 */
const flattened = ({ C, W, width, height }) => {
  const M = new Float64Array(width * height);
  let n = 0;
  for (let p = 0; p < M.length; p++) if (W[p] >= SOLID) { M[p] = 1; n++; }
  const mean = boxMean(C, M, width, height, MEAN_RADIUS);
  const H = new Float64Array(width * height);
  for (let p = 0; p < H.length; p++) H[p] = M[p] ? C[p] - mean[p] : 0;
  const energy = boxMean(H.map((h) => h * h), M, width, height, ENERGY_RADIUS);
  const V = new Float64Array(width * height);
  for (let p = 0; p < V.length; p++) if (M[p]) V[p] = H[p] / (energy[p] + FOLD_FLOOR * FOLD_FLOOR);
  // Block sums at 1, 2, 4 and 8 px, so a large scale folds a quarter, a sixteenth or less of the points.
  return FOLD_BLOCKS.map((block) => {
    const gw = Math.ceil(width / block);
    const gh = Math.ceil(height / block);
    const sums = new Float64Array(gw * gh);
    const solid = new Uint8Array(gw * gh);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!M[p]) continue;
      const q = ((y / block) | 0) * gw + ((x / block) | 0);
      sums[q] += V[p];
      solid[q] = 1;
    }
    let size = 0;
    for (let q = 0; q < solid.length; q++) size += solid[q];
    const cols = new Int32Array(size);
    const lines = new Int32Array(size);
    const vs = new Float64Array(size);
    let i = 0;
    for (let q = 0; q < solid.length; q++) {
      if (!solid[q]) continue;
      cols[i] = q % gw; lines[i] = (q / gw) | 0; vs[i++] = sums[q];
    }
    return { block, gw, gh, cols, lines, vs, size, n };
  });
};

/** Folds the image at the tile period a resize by `s` gives, and returns how far the best pilot fit stands out. */
const foldScore = (levels, s, work) => {
  const { F, rows, R, fit, binX, binY, basis, pilots } = work;
  const G = TILE * FOLD_BINS;
  const period = TILE * CELL * s;
  // The coarsest blocks still at most a quarter of a cell wide.
  const level = levels.filter((l) => l.block <= CELL * s / 4).pop() || levels[0];
  const { block, gw, gh, cols, lines, vs, size } = level;
  const k = G / period;
  // A block sits at its center.
  const center = (block - 1) / 2;
  for (let c = 0; c < gw; c++) binX[c] = (((c * block + center) % period) * k) | 0;
  for (let r = 0; r < gh; r++) binY[r] = ((((r * block + center) % period) * k) | 0) * G;
  F.fill(0);
  for (let i = 0; i < size; i++) F[binY[lines[i]] + binX[cols[i]]] += vs[i];

  // Each cell's response at every offset of the folded tile, which wraps around.
  for (let y = 0; y < G; y++) {
    const row = y * G;
    for (let x = 0; x < G; x++) {
      let sum = 0;
      for (let j = 0; j < FOLD_BINS; j++) {
        const xx = x + j;
        sum += basis[j] * F[row + (xx < G ? xx : xx - G)];
      }
      rows[row + x] = sum;
    }
  }
  R.fill(0);
  for (let j = 0; j < FOLD_BINS; j++) {
    for (let y = 0; y < G; y++) {
      const yy = y + j;
      const src = (yy < G ? yy : yy - G) * G;
      const dst = y * G;
      for (let x = 0; x < G; x++) R[dst + x] += basis[j] * rows[src + x];
    }
  }

  fit.fill(0);
  for (const [oy, ox, sign] of pilots) {
    const split = G - ox;
    for (let dy = 0; dy < G; dy++) {
      const yy = dy + oy;
      const src = (yy < G ? yy : yy - G) * G;
      const dst = dy * G;
      for (let dx = 0; dx < split; dx++) fit[dst + dx] += sign * R[src + dx + ox];
      for (let dx = split; dx < G; dx++) fit[dst + dx] += sign * R[src + dx + ox - G];
    }
  }
  let best = -Infinity;
  let squares = 0;
  for (let i = 0; i < fit.length; i++) {
    squares += fit[i] * fit[i];
    if (fit[i] > best) best = fit[i];
  }
  return best / Math.sqrt(squares / fit.length);
};

/** Scales the image may have been resized by, most likely first, from where its folded pilots stand out. */
const scaleGuesses = (planes) => {
  const levels = flattened(planes);
  if (levels[0].n < MIN_FOLD_AREA) return [];
  const G = TILE * FOLD_BINS;
  const work = {
    F: new Float64Array(G * G),
    rows: new Float64Array(G * G),
    R: new Float64Array(G * G),
    fit: new Float64Array(G * G),
    binX: new Int32Array(planes.width),
    binY: new Int32Array(planes.height),
    basis: Float64Array.from({ length: FOLD_BINS }, (_, j) => Math.sin(2 * Math.PI * (j + 0.5) / FOLD_BINS)),
    pilots: PILOT_CHIPS.map((c) => [((c / TILE) | 0) * FOLD_BINS, (c % TILE) * FOLD_BINS, LAYOUT.sign[c]])
  };
  const score = (s) => foldScore(levels, s, work);
  const scores = [];
  for (let ls = Math.log(SCALE_MIN); ls < Math.log(SCALE_MAX); ls += SCALE_STEP) {
    const s = Math.exp(ls);
    scores.push({ s, z: score(s) });
  }
  return scores
    .filter((e, i) => e.z >= FOLD_Z && (i === 0 || e.z >= scores[i - 1].z) && (i === scores.length - 1 || e.z >= scores[i + 1].z))
    .sort((a, b) => b.z - a.z)
    .slice(0, MAX_FOLD_GUESSES)
    .map(({ s, z }) => {
      // The coarse step leaves the grid drifting across a large image; settle the scale more finely.
      let best = { s, z };
      for (const f of [-3, -2, -1, 1, 2, 3]) {
        const t = s * (1 + f * SCALE_REFINE);
        const zt = score(t);
        if (zt > best.z) best = { s: t, z: zt };
      }
      return best.s;
    });
};

/** Resample so the image is back at the size it was marked at, given it was resized by `s`. */
const toNative = (planes, s) => {
  if (s === 1) return planes;
  const { C, W, width, height } = planes;
  const nw = Math.max(1, Math.round(width / s));
  const nh = Math.max(1, Math.round(height / s));
  const nC = new Float64Array(nw * nh);
  const nW = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * s - 0.5;
      const sy = (y + 0.5) * s - 0.5;
      let sumC = 0;
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
          sumC += C[p] * W[p]; sumW += W[p]; total++;
        }
      } else {
        const fx = Math.floor(sx);
        const fy = Math.floor(sy);
        const tx = sx - fx;
        const ty = sy - fy;
        for (const [xx, yy, w] of [[fx, fy, (1 - tx) * (1 - ty)], [fx + 1, fy, tx * (1 - ty)], [fx, fy + 1, (1 - tx) * ty], [fx + 1, fy + 1, tx * ty]]) {
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const p = yy * width + xx;
          sumC += C[p] * W[p] * w; sumW += W[p] * w; total += w;
        }
      }
      const q = y * nw + x;
      nW[q] = total > 0 ? sumW / total : 0;
      nC[q] = sumW > 0 ? sumC / sumW : 0;
    }
  }
  return { C: nC, W: nW, width: nw, height: nh };
};

/**
 * Every pixel's response to the cell basis, in clean-chip units, with the weight the art around it
 * allows; and those weighted responses folded into one tile, so one pass of pilot correlation finds the
 * grid at any crop offset.
 */
const cellResponses = ({ C, W, width, height }) => {
  const rw = width - CELL + 1;
  const rh = height - CELL + 1;
  if (rw < 1 || rh < 1) return null;
  const rowsS = new Float64Array(rw * height);
  const rowsC = new Float64Array(rw * height);
  const rowsOpaque = new Uint8Array(rw * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < rw; x++) {
    let s = 0;
    let c = 0;
    let opaque = 1;
    for (let u = 0; u < CELL; u++) {
      const p = y * width + x + u;
      s += BASIS[u] * C[p];
      c += COMPANION[u] * C[p];
      if (W[p] < SOLID) opaque = 0;
    }
    rowsS[y * rw + x] = s;
    rowsC[y * rw + x] = c;
    rowsOpaque[y * rw + x] = opaque;
  }
  const unit = CHIP_AMP * (CELL / 2) ** 2;
  const R = new Float64Array(rw * rh);
  const weight = new Float64Array(rw * rh);
  const opaque = new Uint8Array(rw * rh);
  let count = 0;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    let ss = 0;
    let sc = 0;
    let cs = 0;
    let cc = 0;
    let o = 1;
    for (let v = 0; v < CELL; v++) {
      const p = (y + v) * rw + x;
      ss += BASIS[v] * rowsS[p];
      sc += COMPANION[v] * rowsS[p];
      cs += BASIS[v] * rowsC[p];
      cc += COMPANION[v] * rowsC[p];
      o &= rowsOpaque[p];
    }
    const q = y * rw + x;
    const host = (sc * sc + cs * cs + cc * cc) / 3 / (unit * unit);
    R[q] = Math.max(-CELL_CLIP, Math.min(CELL_CLIP, ss / unit));
    weight[q] = 1 / (host + HOST_FLOOR * HOST_FLOOR);
    opaque[q] = o;
    count += o;
  }
  if (count < 20) return null;
  const T = TILE * CELL;
  const folded = new Float64Array(T * T);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = y * rw + x;
    if (opaque[p]) folded[(y % T) * T + (x % T)] += weight[p] * R[p];
  }
  return { folded, R, weight, opaque, rw, rh };
};

/** Find the grid by its pilots, then decode the cells at that offset. */
const readCoarse = ({ folded, R, weight, opaque, rw, rh }) => {
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

  // A cell's weight already scales its vote by how much the art around it can be trusted.
  const soft = new Float64Array(CODED_BITS);
  for (let y = by % CELL; y < rh; y += CELL) for (let x = bx % CELL; x < rw; x += CELL) {
    const p = y * rw + x;
    if (!opaque[p]) continue;
    const k = ((((y % T) - by + T) % T) / CELL) * TILE + (((x % T) - bx + T) % T) / CELL;
    if (LAYOUT.bit[k] >= 0) soft[LAYOUT.bit[k]] += LAYOUT.sign[k] * weight[p] * R[p];
  }
  return decodeSoft(soft);
};

/**
 * Find the mark in an image: an exact copy, or one that was shifted, re-encoded, resized, cropped, or
 * drawn over a background with other marked layers.
 *
 * @param {Object} image - `{ width, height, data }`, RGBA, 8 bits per channel
 * @returns {number|null} The mark number, or null when no mark is found
 */
const read = (image) => {
  const planes = planesOf(image);
  const exact = readFine(planes);
  if (exact !== null) return exact;

  const native = cellResponses(planes);
  const mark = native && readCoarse(native);
  if (mark !== null) return mark;
  for (const guess of scaleGuesses(planes)) {
    if (guess < 1 && (planes.width / guess) * (planes.height / guess) > MAX_NATIVE_AREA) continue;
    const responses = cellResponses(toNative(planes, guess));
    const found = responses && readCoarse(responses);
    if (found !== null) return found;
  }
  return null;
};

module.exports = { embed, read };
