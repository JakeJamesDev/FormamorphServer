const { MINUTE_MS } = require('../config/time');

/**
 * Formamorph AI per-account limits, held in process memory: calls in flight, and calls in the last minute.
 *
 * Keyed by account id, never by address. One process serves the API, as metering already assumes.
 */

const inFlight = new Map();
const recent = new Map();
let lastSweep = 0;

/**
 * Take a parallel slot for an account.
 *
 * @param {string} userId - The account
 * @param {number} limit - Calls the account may have in flight
 * @returns {Function|null} A release function, safe to call more than once; null when the account is at its limit
 */
const acquireSlot = (userId, limit) => {
  const held = inFlight.get(userId) || 0;
  if (held >= limit) return null;
  inFlight.set(userId, held + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = inFlight.get(userId) - 1;
    if (left > 0) inFlight.set(userId, left);
    else inFlight.delete(userId);
  };
};

/**
 * Count one call against an account's last minute.
 *
 * @param {string} userId - The account
 * @param {number} limit - Calls the account may make in any minute
 * @param {number} now - Epoch milliseconds
 * @returns {boolean} Whether the call fits; a call that does not fit is not counted
 */
const takeMinute = (userId, limit, now) => {
  // Drop accounts idle for a minute, at most once a minute, so the map holds only recent callers.
  if (now - lastSweep >= MINUTE_MS) {
    lastSweep = now;
    for (const [id, stamps] of recent) if (now - stamps[stamps.length - 1] >= MINUTE_MS) recent.delete(id);
  }
  const times = (recent.get(userId) || []).filter((time) => now - time < MINUTE_MS);
  if (times.length >= limit) {
    recent.set(userId, times);
    return false;
  }
  times.push(now);
  recent.set(userId, times);
  return true;
};

/** Parallel slots held across every account; zero when no call is in flight. */
const heldSlots = () => [...inFlight.values()].reduce((sum, held) => sum + held, 0);

module.exports = { acquireSlot, takeMinute, heldSlots };
