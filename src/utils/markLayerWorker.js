const { parentPort } = require('worker_threads');
const { embed } = require('./watermark');
const { scramble } = require('./scramble');

// Watermarks then scrambles one raw RGBA layer, off the main thread.
parentPort.on('message', ({ width, height, data, mark, seed }) => {
  try {
    const marked = embed({ width, height, data }, mark);
    const out = scramble({ width, height, data: marked.data }, seed);
    parentPort.postMessage({ ok: true, out }, [out.data.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
