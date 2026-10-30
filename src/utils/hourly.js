const { HOUR_MS, DAY_MS } = require('../config/time');

/**
 * Run `fn` every `ms`. Unref'd so a pending run never holds the process open on its own.
 *
 * @param {number} ms - The period
 * @param {Function} fn - The job; a returned promise is not awaited
 * @returns {Object} The interval handle, so a caller can stop it
 */
const every = (ms, fn) => {
  const timer = setInterval(() => { void fn(); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

/** Every sweeper's deadline is a date, so hourly is finer than any of them needs. */
const hourly = (fn) => every(HOUR_MS, fn);

/** For the network lists, which their sources publish about once a day. */
const daily = (fn) => every(DAY_MS, fn);

module.exports = { hourly, daily };
