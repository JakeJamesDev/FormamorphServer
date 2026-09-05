const User = require('../models/User');
const World = require('../models/World');
const Policy = require('../models/Policy');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const { kindFromQuery } = require('../utils/kindQuery');
const { saveAvatar, deleteAvatar } = require('../utils/fileStorage');
const { avatarUrlFor } = require('../utils/avatarUrl');
const Follow = require('../models/Follow');
const { recordSignal } = require('../utils/recordSignal');
const Signal = require('../models/Signal');
const { ASSIGNABLE_ROLES, STAFF_PROTECTED, canModerate, isAdmin, roleOf, badgeRole } = require('../config/roles');
const { PLACEHOLDER_ID } = require('../config/accountDeletion');

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
exports.getUsers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Clamped so a hand-rolled `limit=100000` can't turn the admin list into a full table dump.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const search = req.query.search || '';
    // An unknown sort field is ignored rather than rejected — it falls back to newest-first, which is
    // what an unsorted table has always shown.
    const sort = Object.prototype.hasOwnProperty.call(User.SORT_FIELDS, req.query.sort) ? req.query.sort : null;
    const order = req.query.order === 'desc' ? 'desc' : 'asc';

    const result = User.getAll({ page, limit, search, sort, order });

    // One query each for the page rather than a per-row lookup.
    const ids = result.users.map(user => user.id);
    const responses = Policy.responsesBy(Policy.UPLOAD_GATE, ids);
    const messageCounts = Message.countsByRecipient(ids);

    res.status(200).json({
      success: true,
      count: result.count,
      pagination: result.pagination,
      // `total` is what matched, `count` is what's in this response — they differ whenever paging bites.
      total: result.total,
      // camelCase to match every other user-shaped response (getMe, updateUserStatus).
      data: result.users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        avatarUrl: avatarUrlFor(user.avatar_file),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        // How they last answered the upload gate: 'accepted', 'declined', or 'unanswered' — which
        // covers never being asked and an answer a version bump has since invalidated.
        termsResponse: responses.get(user.id) || 'unanswered',
        // Direct messages sent to them, so the history button can say how much is behind it.
        messageCount: messageCounts.get(user.id) || 0
      }))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current user profile
 * @route   GET /api/users/me
 * @access  Private
 */
exports.getMe = async (req, res, next) => {
  try {
    const user = User.findById(req.user.id);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        avatarUrl: avatarUrlFor(user.avatar_file),
        createdAt: user.created_at
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get worlds created by current user
 * @route   GET /api/users/me/worlds
 * @access  Private
 */
exports.getMyWorlds = async (req, res, next) => {
  try {
    // Same default as every other list endpoint: no `kind` means worlds only, so a client that predates
    // the column never sees a character among its own published worlds.
    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const result = World.getByAuthor(req.user.id, kind);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      // `total` is what matched, `count` is what's in this response — they differ only if the row ceiling
      // cut something off, which a caller offering each row as a target needs to be able to notice.
      total: result.total,
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};


/**
 * The public face of an account, as a stranger sees it.
 *
 * Built here rather than inline so the id route and the username route answer with one shape. A second
 * copy would drift, and the site and the in-app dialog would slowly stop showing the same profile.
 *
 * @param {Object} user - The account being read
 * @param {Object} [viewer] - Who is asking, when a token said so
 * @returns {Object} The profile DTO
 */
const publicProfile = (user, viewer) => ({
  id: user.id,
  username: user.username,
  avatarUrl: avatarUrlFor(user.avatar_file),
  createdAt: user.created_at,
  // Public on purpose: being on the team is not a private fact, and a reader who can see the badge
  // on a comment should see the same badge on the profile that comment links to.
  role: badgeRole(roleOf(user)),
  // Public: how many, never who. Whether *you* follow them needs a token, and is absent without
  // one rather than false — a signed-out visitor is not somebody who has decided not to.
  followers: Follow.followerCount(user.id),
  following: viewer ? Follow.isFollowing(viewer.id, user.id) : undefined,
  // What their published work has earned, counted over the catalog rather than over what this
  // reader may see — see `World.authorTotals`.
  ...World.authorTotals(user.id)
});

/**
 * The public face of an account.
 *
 * Deliberately a separate route rather than a wider author DTO: every listing, comment and reply already
 * carries a name and a picture, and hanging a signup date off each of them would send the same few fields
 * a hundred times over to fill one popup nobody may open.
 *
 * Public, because the catalog and its comments are. Never carries the email, the status or the account
 * type — those are the admin table's, and this is what a stranger may see.
 *
 * @desc    A user's public profile
 * @route   GET /api/users/:id/profile
 * @access  Public
 */
exports.getUserProfile = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.status(200).json({ success: true, data: publicProfile(user, req.user) });
  } catch (error) {
    next(error);
  }
};

/**
 * Whether a name may lead a stranger to this account at all.
 *
 * Only the by-username route asks. `/:id/profile` shows a suspended account to anyone holding the id,
 * and this does not change that — a UUID is not something a visitor types, while a name is, and a name
 * is also the thing somebody guesses to find out what happened to a creator.
 *
 * @param {Object} user - A candidate the name matched
 * @returns {boolean} Whether the profile is shown
 */
const shownByName = (user) => user.status !== 'suspended' && user.id !== PLACEHOLDER_ID;

/**
 * The same profile, found by the name in a shared link.
 *
 * `formamorph.ai/u/<username>` is what a creator hands somebody, so the site holds a name where every
 * other profile route holds an id. Separate from `/:id/profile` rather than folded into it: an id and a
 * name are looked up differently and refuse differently, and the in-app dialog already has an id and
 * must not change. The id rides along in the answer, which is what the caller reads creations with.
 *
 * Two accounts can hold one name in different capitals, so the pick is in two parts. Asked for a name
 * byte for byte, that account answers, shown or refused on its own status — a suspended account is not
 * reachable by spelling it differently. Asked for a spelling nobody holds, the oldest account still
 * shown answers, so a live creator's link keeps working even when a suspended namesake is older.
 *
 * One refusal covers three cases — a name nobody has, a suspended account, and the reserved
 * `[deleted user]` row — and reads identically, so the 404 cannot be used to ask which names were acted
 * on.
 *
 * @desc    A user's public profile, by username
 * @route   GET /api/users/by-username/:username/profile
 * @access  Public
 */
exports.getUserProfileByUsername = async (req, res, next) => {
  try {
    const named = req.params.username;
    const candidates = User.findAllByUsernameFolded(named);
    const user = candidates.find((row) => row.username === named) || candidates.find(shownByName);

    if (!user || !shownByName(user)) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.status(200).json({ success: true, data: publicProfile(user, req.user) });
  } catch (error) {
    next(error);
  }
};

/**
 * What somebody has published, as whoever is asking may see it.
 *
 * Read with `optionalAuth` rather than left anonymous: a quarantined listing is hidden from the room, but
 * hiding it from its own author on their own profile told them their work had vanished, with nothing to
 * say why. The viewer goes through so the author and the staff still see it, badged.
 *
 * @desc    Get worlds created by a specific user
 * @route   GET /api/users/:id/worlds
 * @access  Public
 */
exports.getUserWorlds = async (req, res, next) => {
  try {
    // Check if user exists
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const result = World.getByAuthor(req.params.id, kind, undefined, req.user);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      // `total` is what matched, `count` is what's in this response — they differ only if the row ceiling
      // cut something off, which a caller offering each row as a target needs to be able to notice.
      total: result.total,
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update user status and account type
 * @route   PUT /api/users/:id/status
 * @access  Private/Admin
 */
exports.updateUserStatus = async (req, res, next) => {
  try {
    const { status, accountType } = req.body;

    // Check if user exists
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // The reserved `[deleted user]` row is not an account and is not moderated like one. Its status is the
    // whole of what keeps a login off it, so nothing may set that status to an ordinary one.
    if (user.id === PLACEHOLDER_ID) {
      return res.status(403).json({
        success: false,
        error: 'The reserved account cannot be changed'
      });
    }

    // Validate status
    if (status && !['normal', 'flagged', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status value'
      });
    }

    // Staff moderate the room, not each other: a dev or a mod reaches ordinary accounts only, an admin
    // also reaches dev and mod, and nobody reaches an admin.
    if (!canModerate(req.user, user)) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    // Changing what somebody *is* belongs to an administrator, whatever else the same body carries.
    if (accountType) {
      if (!isAdmin(req.user)) {
        return res.status(403).json({
          success: false,
          error: 'Only an administrator can change what an account is'
        });
      }

      // `admin` is absent from the assignable list on purpose: administrators are made by hand on the
      // server and nowhere else, so a compromised account cannot promote its way to the top.
      if (!ASSIGNABLE_ROLES.includes(accountType)) {
        return res.status(400).json({
          success: false,
          error: `Account type must be one of: ${ASSIGNABLE_ROLES.join(', ')}`
        });
      }

      if (isAdmin(user)) {
        return res.status(403).json({
          success: false,
          error: 'An administrator can only be changed on the server'
        });
      }
    }

    // Update user
    const updateData = {};
    if (status) updateData.status = status;
    if (accountType) updateData.account_type = accountType;

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No update data provided'
      });
    }

    const previousRole = roleOf(user);
    const updatedUser = User.update(req.params.id, updateData);

    // A moderation action has to reach the sessions the account already has open. Without this, a
    // suspension only took hold once the offender's token expired, and a demoted moderator kept the
    // powers they were demoted for — for up to a day, from a tab nobody can see.
    const suspending = status === 'suspended' && user.status !== 'suspended';
    const roleChanged = Boolean(accountType) && accountType !== previousRole;
    if (suspending || roleChanged) {
      User.revokeSessions(req.params.id);
    }

    // Only a real change to the status is worth an entry — re-saving the same one is not an event, and
    // an account type change is left out until the log is meant to cover it.
    if (status && status !== user.status) {
      const action = status === 'suspended'
        ? 'user_suspended'
        : (user.status === 'suspended' ? 'user_unsuspended' : null);

      if (action) {
        AuditLog.tryRecord({
          action,
          actor: req.user,
          targetUser: updatedUser,
          targetKind: 'account',
          targetName: updatedUser.username
        });
      }
    }

    // Only a real change is an event; re-saving the role somebody already has is not.
    if (accountType && accountType !== previousRole) {
      AuditLog.tryRecord({
        action: 'role_changed',
        actor: req.user,
        targetUser: updatedUser,
        targetKind: 'account',
        targetName: updatedUser.username,
        // Both ends, because "made a mod" reads differently depending on what they were before.
        snippet: `${previousRole} to ${accountType}`
      });
    }

    res.status(200).json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        status: updatedUser.status,
        accountType: updatedUser.account_type,
        avatarUrl: avatarUrlFor(updatedUser.avatar_file),
        createdAt: updatedUser.created_at,
        updatedAt: updatedUser.updated_at
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Replace the caller's own profile image with a new one, deleting whatever it replaced.
 *
 * @desc    Set the signed-in account's profile image
 * @route   PUT /api/users/me/avatar
 * @access  Private
 */
exports.setMyAvatar = async (req, res, next) => {
  try {
    const { image } = req.body || {};

    if (!image) {
      return res.status(400).json({ success: false, error: 'An image is required' });
    }

    // Written before the row is pointed at it: a failed write must leave the old avatar in place rather
    // than clearing the account's to a file that was never stored.
    const filename = await saveAvatar(image);
    const previous = User.setAvatar(req.user.id, filename);

    // Best-effort, and after the row already points elsewhere — a file that outlives its row is litter,
    // while a row pointing at a deleted file is a broken image on every comment the account has left.
    await deleteAvatar(previous);

    res.status(200).json({
      success: true,
      data: { avatarUrl: avatarUrlFor(filename) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Remove the signed-in account's profile image
 * @route   DELETE /api/users/me/avatar
 * @access  Private
 */
exports.removeMyAvatar = async (req, res, next) => {
  try {
    const previous = User.setAvatar(req.user.id, null);
    await deleteAvatar(previous);

    res.status(200).json({ success: true, data: { avatarUrl: null } });
  } catch (error) {
    next(error);
  }
};

/**
 * Clear somebody else's profile image.
 *
 * The moderation lever for an avatar that shouldn't be on the site. Recorded in the audit log the same
 * way a takedown is, since it is one — an image removed with no record is indistinguishable from an
 * account that never set one.
 *
 * @desc    Remove a user's profile image
 * @route   DELETE /api/users/:id/avatar
 * @access  Private/Admin
 */
exports.removeUserAvatar = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Checked before the "nothing to remove" answer: whether a staff account has a picture is not
    // something a moderator who may not touch them gets to learn.
    if (!canModerate(req.user, user)) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    if (!user.avatar_file) {
      return res.status(400).json({ success: false, error: 'This account has no profile image' });
    }

    const previous = User.setAvatar(user.id, null);
    await deleteAvatar(previous);

    AuditLog.tryRecord({
      action: 'avatar_removed',
      actor: req.user,
      // Their own is not somebody else's to be told about, and the actor already reads as the person.
      targetUser: user.id === req.user.id ? null : user,
      targetKind: 'account',
      targetName: user.username
    });

    res.status(200).json({ success: true, data: { avatarUrl: null } });
  } catch (error) {
    next(error);
  }
};

/**
 * Every listing an account has liked, newest first, each with its author.
 *
 * Staff only, and refused to the account itself: a like is a private choice, and this list exists to
 * judge whether one account's likes are real, not to show anybody their own history.
 *
 * @desc    What an account has liked
 * @route   GET /api/users/:id/likes
 * @access  Private/Staff
 */
exports.getUserLikes = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { total, rows } = World.likesGiven(user.id);

    res.status(200).json({
      success: true,
      data: {
        total,
        rows: rows.map((row) => ({
          id: row.id,
          name: row.name,
          authorId: row.author_id,
          authorUsername: row.author_username,
          // Flagged rather than dropped: a like on a hidden listing is still a like somebody gave.
          quarantined: Boolean(row.quarantined_at),
          likedAt: row.liked_at
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Every other account that has acted from one of this account's addresses.
 *
 * The moderation surface the Signal record exists for; `models/Signal.linkedAccounts` explains what the
 * answer means and why both sides of a link come back. Nothing here acts — this is evidence for the
 * suspension and like-removal tools that already exist.
 *
 * @desc    Accounts linked to this one by a shared address
 * @route   GET /api/users/:id/linked
 * @access  Private/Staff
 */
exports.getLinkedAccounts = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const accounts = Signal.linkedAccounts(user.id);

    // Every call, not the first. The log answers "who looked at whom, and when", and a row written once
    // per account would make the second look — the one somebody went back for — the unrecorded one.
    AuditLog.tryRecord({
      action: 'signals_viewed',
      actor: req.user,
      targetUser: user.id === req.user.id ? null : user,
      targetKind: 'account',
      targetName: user.username
    });

    res.status(200).json({ success: true, data: { accounts } });
  } catch (error) {
    next(error);
  }
};

/**
 * Remove every like an account has given, in one action.
 *
 * @desc    Clear an account's likes
 * @route   DELETE /api/users/:id/likes
 * @access  Private/Staff
 */
exports.clearUserLikes = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!canModerate(req.user, user)) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    const removed = World.clearLikes(user.id);

    // One entry for the whole clear, and none when there was nothing to clear: the log records
    // corrections, not attempts.
    if (removed > 0) {
      AuditLog.tryRecord({
        action: 'likes_cleared',
        actor: req.user,
        targetUser: user.id === req.user.id ? null : user,
        targetKind: 'account',
        targetName: user.username,
        snippet: `Removed ${removed} ${removed === 1 ? 'like' : 'likes'}`
      });
    }

    res.status(200).json({ success: true, data: { removed } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Follow an account, so their new and updated listings reach you
 * @route   PUT /api/users/:id/follow
 * @access  Private
 */
exports.followUser = async (req, res, next) => {
  try {
    const target = User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Following yourself would put your own work in your own news, which is not news.
    if (target.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot follow yourself' });
    }

    Follow.follow(req.user.id, target.id);

    recordSignal(req, req.user.id, 'follow');

    res.status(200).json({
      success: true,
      data: { following: true, followers: Follow.followerCount(target.id) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Stop following an account
 * @route   DELETE /api/users/:id/follow
 * @access  Private
 */
exports.unfollowUser = async (req, res, next) => {
  try {
    const target = User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    Follow.unfollow(req.user.id, target.id);

    res.status(200).json({
      success: true,
      data: { following: false, followers: Follow.followerCount(target.id) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Who the signed-in account follows
 * @route   GET /api/users/me/following
 * @access  Private
 */
exports.getFollowing = async (req, res, next) => {
  try {
    const following = Follow.following(req.user.id);

    res.status(200).json({ success: true, count: following.length, data: following });
  } catch (error) {
    next(error);
  }
};

/**
 * The notification feed: what the accounts you follow have published or updated since you followed them.
 *
 * Reading it marks it read, the same way opening a feedback thread does — the feed is the notification,
 * so there is nothing else that could clear it.
 *
 * @desc    The signed-in account's notification feed
 * @route   GET /api/users/me/notifications
 * @access  Private
 */
exports.getNotifications = async (req, res, next) => {
  try {
    const user = User.findById(req.user.id);
    // Read before the stamp moves, or everything would arrive already read.
    const unread = Follow.unreadCount(req.user.id, user.feed_seen_at);
    const items = Follow.feed(req.user.id);

    Follow.markSeen(req.user.id);

    res.status(200).json({ success: true, count: items.length, unread, data: items });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How much of the feed is new, for the badge
 * @route   GET /api/users/me/notifications/unread-count
 * @access  Private
 */
exports.getNotificationCount = async (req, res, next) => {
  try {
    const user = User.findById(req.user.id);

    res.status(200).json({ success: true, unread: Follow.unreadCount(req.user.id, user.feed_seen_at) });
  } catch (error) {
    next(error);
  }
};
