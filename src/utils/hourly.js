const { HOUR_MS } = require('../config/time');

/**
 * Run `fn` once an hour. Every sweeper's deadline is a date, so hourly is finer than any of them needs.
 * Unref'd so a pending sweep never holds the process open on its own.
 *
 * @param {Function} fn - The sweep; a returned promise is not awaited
 * @returns {Object} The interval handle, so a caller can stop it
 */
const hourly = (fn) => {
  const timer = setInterval(() => { void fn(); }, HOUR_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

module.exports = { hourly };
