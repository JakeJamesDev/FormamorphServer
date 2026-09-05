const express = require('express');
const {
  getUsers, getMe, getMyWorlds, getUserWorlds, updateUserStatus,
  setMyAvatar, removeMyAvatar, removeUserAvatar, getUserProfile, getUserProfileByUsername,
  followUser, unfollowUser, getFollowing, getNotifications, getNotificationCount,
  getUserLikes, clearUserLikes, getLinkedAccounts
} = require('../controllers/userController');
const { protect, admin, staff, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Parsed per route rather than for the whole group: an avatar arrives as a base64 image, which does not
// fit the cap the rest of this router's bodies are held to. Only routes taking a body get a parser.
const smallJson = express.json({ limit: '100kb' });
const avatarJson = express.json({ limit: '2mb' });

// Get all users (staff only)
router.get('/', protect, staff, getUsers);

// Get current user profile
router.get('/me', protect, getMe);

// Get worlds created by current user
router.get('/me/worlds', protect, getMyWorlds);

// Who the signed-in account follows, and what they have been up to. Ahead of the `/:id` routes below,
// or `me` is read as somebody's ID.
router.get('/me/following', protect, getFollowing);
router.get('/me/notifications', protect, getNotifications);
router.get('/me/notifications/unread-count', protect, getNotificationCount);

// Set or remove the current user's profile image. Ahead of the `/:id` routes below, or `me` is read as
// somebody's ID.
router.put('/me/avatar', avatarJson, protect, setMyAvatar);
router.delete('/me/avatar', protect, removeMyAvatar);

// The same profile, found by the name a shared `formamorph.ai/u/<username>` link carries. Grouped with
// the literal-prefix routes above so a later `/:id/by-username/...` cannot swallow it.
router.get('/by-username/:username/profile', optionalAuth, getUserProfileByUsername);

// A user's public face: what a stranger sees when they click a name in a thread or on a listing.
// `optionalAuth` so a signed-in reader also learns whether they already follow them.
router.get('/:id/profile', optionalAuth, getUserProfile);

// Follow an account, or stop
router.put('/:id/follow', protect, followUser);
router.delete('/:id/follow', protect, unfollowUser);

// What a specific user has published. `optionalAuth` so a quarantined listing still reaches its own
// author and the staff — the room never sees it either way.
router.get('/:id/worlds', optionalAuth, getUserWorlds);

// Remove a user's profile image (staff only)
router.delete('/:id/avatar', protect, staff, removeUserAvatar);

// What an account has liked, and clearing all of it (staff only). One account liking a whole cluster
// from one author is the shape a throwaway account leaves, and this is where it shows.
router.get('/:id/likes', protect, staff, getUserLikes);
router.delete('/:id/likes', protect, staff, clearUserLikes);

// Which other accounts share an address with this one (staff only). Every call is written to the audit
// log: linkage data is the one record that says where a person was, so reading it is accountable too.
router.get('/:id/linked', protect, staff, getLinkedAccounts);

// Suspend or reinstate an account (staff only). The same route also changes what somebody *is*, which
// is an administrator's alone — enforced in the controller, since one body can carry both.
router.put('/:id/status', smallJson, protect, staff, updateUserStatus);

module.exports = router;
