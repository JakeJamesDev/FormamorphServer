const HostedPause = require('../models/HostedPause');
const HostedUsage = require('../models/HostedUsage');
const { alertAdmins } = require('./hostedAlerts');

/**
 * The Formamorph AI daily ceiling. When the UTC day's spend, open rows included, reaches it, the day is
 * paused and the admins are alerted once. A paused day refuses first calls and gives each started turn one
 * more call. A lift holds until 00:00 UTC; the next day starts unpaused.
 */

const PAUSE_ALERT = Object.freeze({
  subject: 'Formamorph AI is paused',
  body: [
    "Today's Formamorph AI spend reached the daily ceiling. New turns are refused until 00:00 UTC.",
    'Each turn already started gets one more call, then is refused too. An admin can lift the pause for the rest of the day.'
  ].join('\n\n')
});

/** 'YYYY-MM-DD' of the UTC day `now` falls in. */
const utcDay = (now) => now.toISOString().slice(0, 10);

/** 00:00 UTC of the day after `now`: when a pause or a lift ends. */
const nextDayStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

/** Every subject's spend on one UTC day, open rows included, in micro-dollars. */
const daySpend = (day) => {
  const start = new Date(`${day}T00:00:00.000Z`);
  return HostedUsage.totalBetween(start.toISOString(), nextDayStart(start));
};

/**
 * Whether the day is paused at `now`. Pauses the day, and alerts once, when its spend reached the ceiling.
 *
 * @param {Date} now - The instant
 * @param {number} ceilingMicros - The daily ceiling
 * @param {number} [reservingMicros] - A reservation not yet recorded, counted as spend
 * @returns {boolean}
 */
const checkPause = (now, ceilingMicros, reservingMicros = 0) => {
  const day = utcDay(now);
  const pause = HostedPause.forDay(day);
  if (pause) return !pause.lifted_at;
  if (daySpend(day) + reservingMicros < ceilingMicros) return false;
  if (HostedPause.start(day, now.toISOString())) void alertAdmins(PAUSE_ALERT);

  return true;
};

/**
 * Whether a paused day has already admitted a call of this turn.
 *
 * @param {Date} now - The instant
 * @param {number} ceilingMicros - The daily ceiling
 * @param {string} subject - The spend subject
 * @param {string} turnId - The turn
 * @returns {boolean}
 */
const pausedCallUsed = (now, ceilingMicros, subject, turnId) => checkPause(now, ceilingMicros)
  && HostedUsage.turnStartedSince(subject, turnId, HostedPause.forDay(utcDay(now)).paused_at);

/**
 * The day's pause as staff see it. No dollar figures.
 *
 * @param {Date} now - The instant
 * @returns {{ paused: boolean, pausedAt: string|null, liftedAt: string|null, until: string|null }}
 */
const pauseState = (now) => {
  const pause = HostedPause.forDay(utcDay(now));
  if (!pause) return { paused: false, pausedAt: null, liftedAt: null, until: null };

  return { paused: !pause.lifted_at, pausedAt: pause.paused_at, liftedAt: pause.lifted_at, until: nextDayStart(now) };
};

/**
 * Lift the day's pause until 00:00 UTC.
 *
 * @param {Date} now - The instant
 * @param {string} userId - The admin
 * @returns {boolean} Whether there was a pause to lift
 */
const liftPause = (now, userId) => HostedPause.lift(utcDay(now), now.toISOString(), userId);

module.exports = { utcDay, daySpend, checkPause, pausedCallUsed, pauseState, liftPause };
