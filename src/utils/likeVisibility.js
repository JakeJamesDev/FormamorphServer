const db = require('../config/db');
const { isStaff } = require('../config/roles');

/**
 * Who may read a listing's like count. A contest entry's count is hidden until results are announced,
 * except from its author and staff, who get it as `private`.
 *
 * @param {Object} listing - `{ contestEventId, resultsAnnouncedAt, authorId }`
 * @param {Object} [reader] - The signed-in user, or null for a guest
 * @returns {'public'|'private'|'hidden'} What this reader gets
 */
const likeVisibility = ({ contestEventId, resultsAnnouncedAt, authorId }, reader = null) => {
  if (!contestEventId || resultsAnnouncedAt) return 'public';

  return reader && (reader.id === authorId || isStaff(reader)) ? 'private' : 'hidden';
};

/**
 * Shape a listing row's `likes` for this reader, in place. A hidden count is left out rather than zeroed,
 * so the server never sends a false number.
 *
 * @param {Object} listing - A worlds row carrying `likes`, `contest_event_id` and `author_id`
 * @param {string|null} resultsAnnouncedAt - Its contest's announcement instant
 * @param {Object} [reader] - The signed-in user, or null for a guest
 * @returns {Object} The same listing
 */
const shapeLikes = (listing, resultsAnnouncedAt, reader = null) => {
  const visibility = likeVisibility({
    contestEventId: listing.contest_event_id,
    resultsAnnouncedAt,
    authorId: listing.author_id
  }, reader);

  if (visibility === 'hidden') {
    delete listing.likes;
    listing.likesHidden = true;
  } else if (visibility === 'private') {
    listing.likesPrivate = true;
  }

  return listing;
};

// The rule as SQL calls it, so a sort or a sum reads the same answer instead of a second copy of the rule.
// Returns 1 or 0: SQLite has no boolean.
db.function(
  'likes_hidden',
  { deterministic: true },
  (contestEventId, resultsAnnouncedAt, authorId, readerId, readerRole) => (
    likeVisibility(
      { contestEventId, resultsAnnouncedAt, authorId },
      readerId ? { id: readerId, account_type: readerRole } : null
    ) === 'hidden' ? 1 : 0
  )
);

/**
 * The reader half of a `likes_hidden(contest, resultsAt, author, ?, ?)` call, in parameter order.
 *
 * @param {Object} [reader] - The signed-in user, or null for a guest
 * @returns {Array} `[readerId, readerRole]`
 */
const likesHiddenReaderParams = (reader = null) => [reader ? reader.id : null, reader ? reader.account_type : null];

module.exports = { likeVisibility, shapeLikes, likesHiddenReaderParams };
