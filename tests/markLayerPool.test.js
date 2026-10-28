import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { markLayer } = require('../src/utils/markLayerPool');
const { embed } = require('../src/utils/watermark');
const { scramble } = require('../src/utils/scramble');

/** The worker pool behind per-account processing: same output as the in-thread steps, and off the main thread. */

const layer = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 251;
  return { width, height, data };
};

const copy = (image) => ({ ...image, data: new Uint8ClampedArray(image.data) });

describe('marking a layer in the worker pool', () => {
  it('gives the bytes the in-thread watermark and scramble give', async () => {
    const image = layer(96, 80);
    const expected = scramble({ width: 96, height: 80, data: embed(copy(image), 0x1234abcd).data }, 99);
    const out = await markLayer(copy(image), 0x1234abcd, 99);

    expect({ ...out, data: undefined }).toEqual({ ...expected, data: undefined });
    expect(Buffer.from(out.data).equals(Buffer.from(expected.data))).toBe(true);
  });

  it('leaves the main thread free while a large layer is marked', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      await markLayer(layer(1024, 1024), 7, 7);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(1);
  });

  it('runs more layers than workers and settles every one', async () => {
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => markLayer(layer(64, 64), i + 1, i)));
    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out.data.length).toBeGreaterThan(0);
  });
});
