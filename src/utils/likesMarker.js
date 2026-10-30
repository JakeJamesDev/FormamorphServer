const db = require('../config/db');
const Setting = require('../models/Setting');
const Signal = require('../models/Signal');
const {
  MIN_FLAGGED, FLAGGED_SHARE, BURST_SIZE, BURST_WINDOW_MINUTES, REASONS
} = require('../config/likesMarker');
const { MINUTE_MS } = require('../config/time');

/**
 * The **Likes Marker** of each listing, worked out on read from its likes of the last ninety days.
 *
 * On read rather than stored, so a marker clears on its own when the likes behind it age out or are
 * removed. Ninety days because that is how long a like keeps its Network Kind and its address hash:
 * past it, the server no longer knows enough to flag or to tell two likers apart.
 *
 * A liker is an account, or the address hash behind Anonymous Likes, so a household on one address is one
 * liker however many marks it leaves. A mark whose hash is blank names no address and joins no Burst.
 */

/**
 * Every like on the listings inside the window, oldest first, account and anonymous together.
 *
 * `liker` is null for a mark with a blank hash. Both tables store ISO strings, so the window is a string
 * comparison and the order is the order the hearts were pressed.
 */
const recentLikes = (worldIds, cutoff) => db.prepare(`
  SELECT world_id, 'account:' || user_id AS liker, created_at, network_kind
  FROM world_likes
  WHERE world_id IN (SELECT value FROM json_each(@ids)) AND created_at >= @cutoff
  UNION ALL
  SELECT world_id, CASE WHEN address_hash <> '' THEN 'address:' || address_hash END AS liker, created_at, network_kind
  FROM anonymous_likes
  WHERE world_id IN (SELECT value FROM json_each(@ids)) AND created_at >= @cutoff
  ORDER BY world_id, created_at
`).all({ ids: JSON.stringify(worldIds), cutoff });

/**
 * The Bursts in one listing's likes: runs where some window held at least `size` different likers.
 *
 * Every like starts a candidate window that reaches `windowMs` past it, inclusive. Qualifying windows that
 * share a like merge into one Burst, so twenty likers in ten minutes are one Burst of twenty rather than
 * thirteen overlapping ones. A Burst starts at its first like and its size counts each liker once.
 *
 * @param {Array<Object>} likes - `{ liker, at }` with a non-null liker, oldest first; `at` in ms
 * @param {number} size - Different likers a window needs
 * @param {number} windowMs - The window's length
 * @returns {Array<Object>} `{ startedAt, size }`, oldest first
 */
const findBursts = (likes, size, windowMs) => {
  const bursts = [];
  const inWindow = new Map();
  let end = -1;
  let run = null;

  const closeRun = () => {
    const likers = new Set(likes.slice(run.from, run.to + 1).map((like) => like.liker));
    bursts.push({ startedAt: new Date(likes[run.from].at).toISOString(), size: likers.size });
    run = null;
  };

  for (let start = 0; start < likes.length; start += 1) {
    while (end + 1 < likes.length && likes[end + 1].at - likes[start].at <= windowMs) {
      end += 1;
      inWindow.set(likes[end].liker, (inWindow.get(likes[end].liker) || 0) + 1);
    }

    if (inWindow.size >= size) {
      if (run && start > run.to) closeRun();
      if (run) run.to = end;
      else run = { from: start, to: end };
    }

    const leaving = likes[start].liker;
    if (inWindow.get(leaving) === 1) inWindow.delete(leaving);
    else inWindow.set(leaving, inWindow.get(leaving) - 1);
  }

  if (run) closeRun();

  return bursts;
};

/** The marker of one listing from its recent likes and the thresholds in force. */
const markerFor = (likes, thresholds) => {
  const total = likes.length;
  const flagged = likes.filter((like) => like.network_kind).length;
  const share = total > 0 ? flagged / total : null;
  const bursts = findBursts(
    likes.filter((like) => like.liker).map((like) => ({ liker: like.liker, at: Date.parse(like.created_at) })),
    thresholds.burstSize,
    thresholds.burstWindowMinutes * MINUTE_MS
  );

  const reasons = [];
  if (bursts.length > 0) reasons.push(REASONS.BURST);
  if (flagged >= thresholds.minFlagged && share >= thresholds.flaggedShare) reasons.push(REASONS.FLAGGED_SHARE);

  return { flagged, total, share, bursts, reasons };
};

/**
 * The Likes Marker of each listing asked about.
 *
 * One read of each like table for the whole set, so a page of cards costs two queries. The thresholds
 * are read on every call, so a changed setting applies on the next one.
 *
 * @param {Array<string>} worldIds - The listings
 * @returns {Map<string, Object>} Each id to `{ flagged, total, share, bursts, reasons }`; `share` is null
 *   with no likes in the window, and `reasons` is empty when the listing is not marked
 */
const likesMarkers = (worldIds) => {
  const thresholds = {
    minFlagged: Setting.get(MIN_FLAGGED),
    flaggedShare: Setting.get(FLAGGED_SHARE),
    burstSize: Setting.get(BURST_SIZE),
    burstWindowMinutes: Setting.get(BURST_WINDOW_MINUTES)
  };

  const byWorld = new Map(worldIds.map((id) => [id, []]));
  for (const like of recentLikes(worldIds, Signal.cutoff())) byWorld.get(like.world_id).push(like);

  return new Map([...byWorld].map(([id, likes]) => [id, markerFor(likes, thresholds)]));
};

module.exports = { likesMarkers };
