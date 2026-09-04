const { hourly } = require('./hourly');
const Event = require('../models/Event');
const Message = require('../models/Message');
const { startBroadcast, endBroadcast, cancelBroadcast, podiumBroadcast } = require('./eventBroadcasts');

/**
 * Post one of an event's notices as the event's creator, from the team.
 *
 * The creator is the sender so the message shows up in the sent list under a real account and can be
 * edited and recalled through the ordinary routes; `sender_as: 'team'` is what readers see, so nobody's
 * name is attached to something the server wrote.
 *
 * @param {Object} event - The event row
 * @param {Object} fields - Composer fields from the templates
 * @returns {Object} The created message row
 */
const post = (event, fields) => Message.create({
  ...fields,
  senderId: event.created_by || null,
  recipientId: null
});

/**
 * Open an event: post its pinned notice and remember which message it is.
 *
 * @param {Object} event - The event row, due to start
 * @returns {Object|undefined} The updated event row
 */
const startEvent = (event) => {
  const message = post(event, startBroadcast(event));
  return Event.setMessageId(event.id, 'start_message_id', message.id);
};

/**
 * Close an event: take the pin down, and for a contest say that judging has begun.
 *
 * The recall is generic because the pin is — an undismissable banner for something that is over is worse
 * than no banner at all. The second notice is contest-only: an announcement whose window closed has
 * nothing further to say.
 *
 * Each half is guarded by its own record, so this is safe to run again on a row that got half way.
 *
 * @param {Object} event - The event row, due to end
 * @returns {Object|undefined} The updated event row
 */
const endEvent = (event) => {
  if (event.start_message_id) Message.recall(event.start_message_id);

  if (event.type === 'contest' && !event.end_message_id) {
    const message = post(event, endBroadcast(event));
    return Event.setMessageId(event.id, 'end_message_id', message.id);
  }

  return Event.findById(event.id);
};

/**
 * Call an event off.
 *
 * An event nobody was ever told about is simply removed from the lists — posting "the thing you never
 * heard of is cancelled" would be the first anyone knew of it. One that had started gets its pin taken
 * down and a notice saying so, filed as the event's closing message because that is now what it is: an
 * event called off after its window closed replaces "judging has begun" with the truth.
 *
 * The stamp is what makes this happen once, so the row is read here rather than trusted from the caller
 * — a route holding an event it fetched a moment ago must not be able to post a second notice.
 *
 * @param {Object} event - The event row to cancel
 * @param {string} [at] - The cancellation instant, for tests
 * @returns {Object|undefined} The cancelled event row
 */
const cancelEvent = (event, at = undefined) => {
  const current = Event.findById(event.id);
  if (!current || current.cancelled_at) return current;

  const cancelled = Event.cancel(current.id, at);
  if (!current.start_message_id) return cancelled;

  Message.recall(current.start_message_id);

  const message = post(current, cancelBroadcast(current));
  return Event.setMessageId(current.id, 'end_message_id', message.id);
};

/**
 * Announce a contest's results.
 *
 * Lives here beside the other transitions rather than in the route, because it is one: a stamp on the
 * event and the notice that goes with it, posted the same way and by the same hand. Unlike the others it
 * has no deadline to be due at — somebody decides — so nothing sweeps for it.
 *
 * @param {Object} event - The event row, with the podium already stored
 * @param {Array<Object>} placements - The stored placement rows, gold first
 * @returns {Object|undefined} The updated event row
 */
const announceResults = (event, placements) => {
  const message = post(event, podiumBroadcast(event, placements));

  return Event.setMessageId(event.id, 'results_message_id', message.id);
};

/**
 * Run every transition whose moment has passed.
 *
 * Run from three places, all cheap when there is nothing due: at boot, on an hourly timer, and lazily in
 * front of the events routes. The timer alone would be wrong — a server that was down over a deadline
 * would serve a stale banner on the next boot, and one that has been up for weeks would be relying on a
 * single interval never having drifted. Reading the events is exactly when the state matters, so that
 * path checks too.
 *
 * Never throws. This runs on a timer nobody is watching and in front of a request that is about
 * something else; one event failing to open must take down neither.
 *
 * Starts run before ends, so an event whose whole window passed while the server was down still posts
 * and then recalls its notice rather than skipping straight to a close nobody saw open.
 *
 * @param {string} [now] - The instant to compare deadlines against, for tests
 * @returns {Promise<{started: number, ended: number}>} How many events each transition moved
 */
const sweepEvents = async (now = undefined) => {
  const moved = { started: 0, ended: 0 };

  try {
    for (const event of Event.dueToStart(now)) {
      try {
        startEvent(event);
        moved.started += 1;
      } catch (error) {
        console.error(`Failed to start event ${event.id}:`, error);
      }
    }

    for (const event of Event.dueToEnd(now)) {
      try {
        endEvent(event);
        moved.ended += 1;
      } catch (error) {
        console.error(`Failed to end event ${event.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Event sweep failed:', error);
  }

  return moved;
};

const startEventSweeper = () => hourly(sweepEvents);

module.exports = { sweepEvents, startEventSweeper, startEvent, endEvent, cancelEvent, announceResults };
