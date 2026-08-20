const Event = require('../models/Event');
const { isStaff } = require('../config/roles');
const { sweepEvents } = require('../utils/sweepEvents');

/**
 * An event as anyone may see it.
 *
 * The message ids ride along so the client can mark the notice it is showing as read — the banner and
 * the inbox badge would otherwise disagree about whether the reader has seen the same announcement.
 *
 * @param {Object} row - An event row with its derived `state`
 * @returns {Object} The public DTO
 */
const toDto = (row) => ({
  id: row.id,
  type: row.type,
  state: row.state,
  title: row.title,
  bannerText: row.banner_text,
  body: row.body,
  rulesText: row.rules_text || null,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  cancelledAt: row.cancelled_at || null,
  startMessageId: row.start_message_id || null,
  endMessageId: row.end_message_id || null,
  winnerMessageId: row.winner_message_id || null,
  winnerWorldId: row.winner_world_id || null,
  winnerName: row.winner_name || null,
  winnerAuthorName: row.winner_author_name || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/**
 * @desc    Events running right now
 * @route   GET /api/events/active
 * @access  Public
 */
exports.getActiveEvents = async (req, res, next) => {
  try {
    // Anything whose window opened or closed while the timer was between ticks moves first, so this
    // route can never answer with a banner that should be up or one that should be gone.
    await sweepEvents();

    const events = Event.getActive().map(toDto);

    res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Every event that has started, including those that have ended — the archive source
 * @route   GET /api/events
 * @access  Public (staff additionally see scheduled and cancelled events)
 */
exports.getEvents = async (req, res, next) => {
  try {
    await sweepEvents();

    const events = Event
      .getList({ includeUnannounced: isStaff(req.user) })
      .map(toDto);

    res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    next(error);
  }
};
