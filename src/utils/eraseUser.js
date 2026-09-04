const db = require('../config/db');
const AuditLog = require('../models/AuditLog');
const { PLACEHOLDER_ID, PLACEHOLDER_USERNAME } = require('../config/accountDeletion');
const { deleteWorldContent, deleteThumbnail, deleteAvatar } = require('./fileStorage');

/**
 * Every row change, in one transaction, handing back the files the caller must remove afterwards.
 *
 * Nothing in here is async, which is what makes the transaction a transaction.
 */
const eraseRows = db.transaction((user, removeContent) => {
  const worlds = db
    .prepare('SELECT id, content_file, thumbnail_file FROM worlds WHERE author_id = ?')
    .all(user.id);
  const comments = db
    .prepare('SELECT COUNT(*) AS count FROM comments WHERE author_id = ?')
    .get(user.id).count;

  const contentFiles = [];
  const thumbnailFiles = [];

  if (removeContent) {
    for (const world of worlds) {
      if (world.content_file) contentFiles.push(world.content_file);
      if (world.thumbnail_file) thumbnailFiles.push(world.thumbnail_file);
    }

    // Their comments on listings that are staying: each of those listings has to lose the count with them,
    // since the total is stored on the row rather than counted at read time.
    db.prepare(`
      UPDATE worlds
      SET comment_count = MAX(0, comment_count - (
        SELECT COUNT(*) FROM comments c WHERE c.world_id = worlds.id AND c.author_id = @author
      ))
      WHERE id IN (SELECT world_id FROM comments WHERE author_id = @author)
    `).run({ author: user.id });

    db.prepare('DELETE FROM comments WHERE author_id = ?').run(user.id);
    // Their own listings, and with them the comments, likes and changelog entries that cascade.
    db.prepare('DELETE FROM worlds WHERE author_id = ?').run(user.id);
  } else {
    // The work stays where it is and only the name behind it changes. Both columns are NOT NULL, which is
    // why there is a reserved row to point them at rather than a null.
    db.prepare('UPDATE worlds SET author_id = ? WHERE author_id = ?').run(PLACEHOLDER_ID, user.id);
    db.prepare('UPDATE comments SET author_id = ? WHERE author_id = ?').run(PLACEHOLDER_ID, user.id);
  }

  // A podium stores the author's name rather than joining it, so that name outlives the account unless it
  // is replaced here. Both paths do it: a placement is an archive either way, and the point of erasing an
  // account is that its name is gone from everywhere the room can read.
  db.prepare('UPDATE event_placements SET author_name = ? WHERE author_name = ?')
    .run(PLACEHOLDER_USERNAME, user.username);

  // Last, so every reference to it has already gone or moved. Likes, follows, policy answers, Signals,
  // message state and votes cascade from here; feedback and reports are set null and stay readable.
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  return {
    worlds: worlds.length,
    comments,
    contentFiles,
    thumbnailFiles,
    avatarFile: user.avatar_file || null
  };
});

/**
 * Delete files, logging a failure instead of raising it.
 *
 * Every caller runs after the transaction has committed, so the account is already gone and there is
 * nothing left to retry. Raising here would only turn a finished erasure into a reported failure, and the
 * cost of carrying on is a file nothing points at.
 *
 * @param {Function} remove - The remover for this kind of file
 * @param {string[]} files - The stored filenames
 * @param {string} username - Whose erasure this was, for the log line
 */
const removeQuietly = async (remove, files, username) => {
  for (const file of files) {
    try {
      await remove(file);
    } catch (error) {
      console.error(`Erased ${username} but could not delete ${file}:`, error);
    }
  }
};

/**
 * Erase one account, either taking its published work with it or leaving that work behind a placeholder.
 *
 * The one erasure there is. The sweeper calls it when a grace period runs out and `deleteUser.js` calls it
 * from a shell, so an account ends the same way whoever ends it.
 *
 * Rows change in a single transaction and files are removed only after it commits. The order is the point:
 * the database is either wholly erased or untouched, and the worst a failed unlink leaves behind is a file
 * nothing points at.
 *
 * @param {Object} user - The whole user row; `id`, `username` and `avatar_file` are read
 * @param {Object} [options]
 *   `removeContent` — true to delete their listings and comments, false to reassign both to the placeholder
 * @returns {Promise<Object>} `{ username, removedContent, worlds, comments }`, counted before the erasure
 * @throws {Error} When asked to erase the reserved account, or when the row work fails
 */
const eraseUser = async (user, { removeContent = false } = {}) => {
  if (user.id === PLACEHOLDER_ID) {
    throw new Error('The reserved placeholder account cannot be erased');
  }

  const erased = eraseRows(user, removeContent);

  // The moment the transaction commits the account is gone, so the entry saying so is written before
  // anything that could fail. A trail that only records the erasures whose files happened to unlink is
  // worse than no trail, because it reads as complete.
  AuditLog.tryRecord({
    action: 'account_deleted',
    actor: null,
    targetUser: { id: user.id, username: user.username },
    targetKind: 'account',
    targetName: user.username,
    snippet: removeContent ? 'content deleted' : 'content kept'
  });

  // Past the commit, so nothing here can undo it.
  await removeQuietly(deleteWorldContent, erased.contentFiles, user.username);
  await removeQuietly(deleteThumbnail, erased.thumbnailFiles, user.username);
  await removeQuietly(deleteAvatar, erased.avatarFile ? [erased.avatarFile] : [], user.username);

  return {
    username: user.username,
    removedContent: removeContent,
    worlds: erased.worlds,
    comments: erased.comments
  };
};

module.exports = { eraseUser };
