const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

/**
 * A small pool of worker threads for the watermark and scramble steps, which are synchronous and take about
 * a second on a full rig. Running them here keeps every other route answering during an install rush.
 *
 * At most `SIZE` layers run at once, leaving a core for the API; the rest wait in order. An idle worker is
 * unref'd, so the pool never holds the process open.
 */

const SIZE = Math.max(1, Math.min(2, os.availableParallelism() - 1));
const WORKER_PATH = path.join(__dirname, 'markLayerWorker.js');

const slots = [];
const waiting = [];

const settle = (slot, settleTask) => {
  const task = slot.task;
  slot.task = null;
  if (task) settleTask(task);
};

const spawn = () => {
  const slot = { worker: new Worker(WORKER_PATH), task: null };
  slot.worker.unref();
  slot.worker.on('message', (message) => {
    slot.worker.unref();
    settle(slot, (task) => (message.ok ? task.resolve(message.out) : task.reject(new Error(message.message))));
    pump();
  });
  const retire = (error) => {
    const index = slots.indexOf(slot);
    if (index !== -1) slots.splice(index, 1);
    settle(slot, (task) => task.reject(error));
    pump();
  };
  slot.worker.on('error', retire);
  slot.worker.on('exit', (code) => retire(new Error(`The watermark worker exited with code ${code}`)));
  slots.push(slot);
  return slot;
};

function pump() {
  while (waiting.length > 0) {
    const slot = slots.find((candidate) => !candidate.task) || (slots.length < SIZE ? spawn() : null);
    if (!slot) return;
    const task = waiting.shift();
    slot.task = task;
    slot.worker.ref();
    slot.worker.postMessage(task.job, [task.job.data.buffer]);
  }
}

/**
 * Watermark then scramble one layer in a worker.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} image - Raw RGBA; its buffer is
 *   transferred, so the caller must not reuse it
 * @param {number} mark - The account's mark number
 * @param {number} seed - The scramble seed
 * @returns {Promise<Object>} What `scramble` returns
 */
const markLayer = (image, mark, seed) => new Promise((resolve, reject) => {
  waiting.push({ job: { ...image, mark, seed }, resolve, reject });
  pump();
});

module.exports = { markLayer, POOL_SIZE: SIZE };
