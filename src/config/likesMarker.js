/**
 * The thresholds behind the staff-only **Likes Marker**, each a setting the operator tunes on real data.
 *
 * A listing is marked for one of two reasons, either alone enough. A **Burst**: at least `BURST_SIZE`
 * different likers inside `BURST_WINDOW_MINUTES`. A flagged share: at least `MIN_FLAGGED` of its recent
 * likes carry a Network Kind, and those are at least `FLAGGED_SHARE` of its recent likes. Nothing acts on
 * a marker; it points staff at a listing worth a look.
 */

const MIN_FLAGGED = 'likes_marker_min_flagged';
const FLAGGED_SHARE = 'likes_marker_share';
const BURST_SIZE = 'burst_size';
const BURST_WINDOW_MINUTES = 'burst_window_minutes';

/** The reason codes a marker can carry. */
const REASONS = Object.freeze({ BURST: 'burst', FLAGGED_SHARE: 'flagged_share' });

/** A day, so a window cannot reach past what one read is meant to scan for. */
const MAX_WINDOW_MINUTES = 24 * 60;

const wholeNumber = (min, max, label) => (value) =>
  Number.isInteger(value) && value >= min && value <= max
    ? null
    : `${label} must be a whole number of at least ${min}${max === Infinity ? '' : ` and at most ${max}`}`;

const validateMinFlagged = wholeNumber(1, Infinity, 'The minimum flagged count');

const validateBurstSize = wholeNumber(2, Infinity, 'The Burst size');

const validateBurstWindow = wholeNumber(1, MAX_WINDOW_MINUTES, 'The Burst window in minutes');

const validateFlaggedShare = (value) =>
  typeof value === 'number' && value > 0 && value <= 1 ? null : 'The flagged share must be above 0 and at most 1';

module.exports = {
  MIN_FLAGGED,
  FLAGGED_SHARE,
  BURST_SIZE,
  BURST_WINDOW_MINUTES,
  REASONS,
  validateMinFlagged,
  validateFlaggedShare,
  validateBurstSize,
  validateBurstWindow
};
