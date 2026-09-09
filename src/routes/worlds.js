const express = require('express');
const { check } = require('express-validator');
const { getWorlds, getWorld, getWorldContent, createWorld, updateWorld, deleteWorld, setSpoilerStatus, setLikeStatus, getLikers, getLikersAudit, removeLike, quarantineWorld, releaseWorld, withdrawEntry } = require('../controllers/worldController');
const { getComments, createComment } = require('../controllers/commentController');
const { createEntry, updateEntry, deleteEntry } = require('../controllers/changelogController');
const { getDependencies, getDependencyContent, setDependencies, setCompatibility, getAddons, setReviewState } = require('../controllers/relationshipController');
const { protect, staff, optionalAuth } = require('../middleware/auth');
const { requireUploadTerms } = require('../middleware/policy');
const { KINDS, DEFAULT_KIND, rulesFor } = require('../config/kinds');

const router = express.Router();

// World content can be large (up to 200MB); other bodies here stay tightly capped.
const largeJson = express.json({ limit: '200mb' });
const smallJson = express.json({ limit: '100kb' });

// Get all worlds
router.get('/', optionalAuth, getWorlds);

// Get single world
router.get('/:id', optionalAuth, getWorld);

// Get world content
router.get('/:id/content', optionalAuth, getWorldContent);

// Linked content. What a world requires, resolved for whoever can read the world — the one path by which
// an unlisted component reaches the room — and each required source's content through the same door.
router.get('/:id/dependencies', optionalAuth, getDependencies);
router.get('/:id/dependencies/:sourceId/content', optionalAuth, getDependencyContent);
router.put('/:id/dependencies', smallJson, protect, setDependencies);

// What a component is offered for (its author's declaration), what a world is offered (never an unlisted
// component), and the world author's answer to each offer.
router.put('/:id/compatibility', smallJson, protect, setCompatibility);
router.get('/:id/addons', optionalAuth, getAddons);
router.put('/:id/addons/:componentId/review', smallJson, protect, setReviewState);

// Create new world
router.post(
  '/',
  largeJson,
  [
    check('name', 'Name is required').not().isEmpty(),
    check('name', 'Name cannot exceed 100 characters').isLength({ max: 100 }),
    check('contentData', 'Content data is required').not().isEmpty(),
    check('kind', `Kind must be one of: ${KINDS.join(', ')}`).optional().isIn(KINDS),
    // Which contest this publish is entering, if any. Whether that contest will take it is the
    // controller's question; all this says is that an id arrived rather than an object.
    check('contestEventId', 'Contest event ID must be a string').optional().isString(),
    // Worlds must still supply a description and a thumbnail; characters and dictionaries have no such
    // fields to give, so the controller fills an empty description and placeholder art (see config/kinds).
    check('description').custom((value, { req }) => {
      if (rulesFor(req.body.kind || DEFAULT_KIND).requiresDescription && !value) {
        throw new Error('Description is required');
      }
      return true;
    }),
    check('thumbnail').custom((value, { req }) => {
      if (rulesFor(req.body.kind || DEFAULT_KIND).requiresThumbnail && !value) {
        throw new Error('Thumbnail is required');
      }
      return true;
    })
  ],
  protect,
  requireUploadTerms,
  createWorld
);

// Update world
router.put(
  '/:id',
  largeJson,
  [
    check('name', 'Name cannot exceed 100 characters').optional().isLength({ max: 100 })
  ],
  protect,
  requireUploadTerms,
  updateWorld
);

// Set world spoiler status
router.put(
  '/:id/spoiler',
  smallJson,
  [
    check('spoiler', 'Spoiler must be a boolean value').isBoolean()
  ],
  protect,
  setSpoilerStatus
);

// Like a listing, or take it back. Signed in only — a like is one account's, which is what makes it
// revocable and countable, unlike the anonymous download tally.
router.put('/:id/like', smallJson, protect, setLikeStatus);

// Who liked it, and taking one of those likes off (staff only). The public count is a count and nothing
// more; the names behind it are the team's, for telling a popular listing from an inflated one.
router.get('/:id/likes', protect, staff, getLikers);
router.delete('/:id/likes/:userId', protect, staff, removeLike);

// The same likes with the Signals behind them read across: who liked from the same address as whom, and
// who from the author's. Its own route because every call is written to the audit log, and counting the
// likes on a listing must not file a look at the people who gave them.
router.get('/:id/likes/audit', protect, staff, getLikersAudit);

// Delete world
// Quarantine a listing, or lift one (staff only). Out of the catalog for everyone but its author, and
// deleted when the deadline passes unless somebody releases it first.
router.put('/:id/quarantine', smallJson, protect, staff, quarantineWorld);
router.delete('/:id/quarantine', protect, staff, releaseWorld);

// Take a listing out of the contest it was entered in. Withdraw-only, and DELETE rather than a flag:
// there is no "enter this existing listing" to be the other half of, since entering happens at publish.
router.delete('/:id/contest', protect, withdrawEntry);

router.delete('/:id', protect, deleteWorld);

// Comment routes
// Get all comments for a world
router.get('/:worldId/comments', optionalAuth, getComments);

// Create new comment for a world
router.post(
  '/:worldId/comments',
  smallJson,
  [
    // Trimmed before it is checked and before it is stored: without this a body of spaces passes
    // `isEmpty` and blanks the comment.
    check('content', 'Content is required').trim().not().isEmpty(),
    check('content', 'Content cannot exceed 4000 characters').isLength({ max: 4000 })
  ],
  protect,
  createComment
);

// Listing Changelog routes. Sub-resources of the listing, because an entry has no meaning apart from the
// listing it describes — unlike a comment, which is addressed by its own id so a thread can be moderated
// without knowing where it sits.
//
// No GET: the changelog is read as part of the listing (`?includeChangelog=true`), so a viewer opening a
// details window fetches it in the same breath as everything else the window shows.
router.post('/:worldId/changelog', smallJson, protect, createEntry);
router.put('/:worldId/changelog/:entryId', smallJson, protect, updateEntry);
router.delete('/:worldId/changelog/:entryId', protect, deleteEntry);

module.exports = router;
