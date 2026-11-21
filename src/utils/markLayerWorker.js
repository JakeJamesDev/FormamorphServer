const { parentPort } = require('worker_threads');
const { embed } = require('./watermark');
const { scramble } = require('./scramble');

// Watermarks one raw RGBA layer, then scrambles it unless the seed is null, off the main thread.
parentPort.on('message', ({ width, height, data, mark, seed }) => {
  try {
    const marked = embed({ width, height, data }, mark);
    const out = seed === null ? marked : scramble({ width, height, data: marked.data }, seed);
    parentPort.postMessage({ ok: true, out }, [out.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
