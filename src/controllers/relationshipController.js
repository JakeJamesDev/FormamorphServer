const World = require('../models/World');
const User = require('../models/User');
const Dependency = require('../models/Dependency');
const Compatibility = require('../models/Compatibility');
const { canModerate } = require('../config/roles');
const { isValidReviewState, REVIEW_STATES, PUBLIC } = require('../config/relationships');
const { judgingContest, contestLockedBody } = require('../utils/judgingContest');
const {
  NOT_FOUND, idList, dependencyRefusal, compatibilityRefusal, reviewFields, seesDeclined, compatibleWorldsFor
} = require('../utils/linkedContent');

/** The listing a route is about, or a 404 answer. Hidden listings answer exactly as missing ones do. */
const readableWorld = (req, res) => {
  const world = World.findById(req.params.id);
  if (!world || !World.isVisibleTo(world, req.user)) {
    res.status(404).json(NOT_FOUND);
    return null;
  }

  return world;
};

/**
 * The listing a write is about, or a 404 / 403 answer. Owner or moderator, as every listing edit is: a
 * declaration that points somewhere it should not is something staff take down like any other edit.
 */
const ownedWorld = (req, res) => {
  const world = World.findById(req.params.id);
  if (!world) {
    res.status(404).json(NOT_FOUND);
    return null;
  }

  if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
    res.status(403).json({ success: false, error: 'Not authorized to update this world' });
    return null;
  }

  return world;
};

/**
 * @desc    Resolve a world's required dependencies
 * @route   GET /api/worlds/:id/dependencies
 * @access  Public (anyone who can read the world)
 */
exports.getDependencies = async (req, res, next) => {
  try {
    const world = readableWorld(req, res);
    if (!world) return;

    res.setHeader('Cache-Control', 'private, no-cache');
    res.vary('Authorization');

    res.status(200).json({
      success: true,
      data: {
        id: world.id,
        revision: world.revision,
        dependencies: Dependency.resolveFor(world.id, req.user)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The one door an unlisted listing's content has for the room: as a required dependency of a world the
 * caller can read. The world and the declaration are checked before the source is, so an id that is not
 * one of this world's dependencies answers not found whatever it is.
 *
 * @desc    Download one required dependency's content
 * @route   GET /api/worlds/:id/dependencies/:sourceId/content
 * @access  Public (anyone who can read the world)
 */
exports.getDependencyContent = async (req, res, next) => {
  try {
    const world = readableWorld(req, res);
    if (!world) return;

    const { sourceId } = req.params;
    const source = Dependency.has(world.id, sourceId) ? World.findById(sourceId) : null;
    if (!World.isDependencyVisibleTo(source, req.user)) {
      return res.status(404).json(NOT_FOUND);
    }

    // Counted on the source, as a standalone download is: the tally says how often a listing reached a
    // machine, and reaching one inside a world download is reaching one.
    World.incrementDownloads(sourceId);

    res.status(200).json({ success: true, data: await World.getContent(sourceId) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Replace what a world requires
 * @route   PUT /api/worlds/:id/dependencies
 * @access  Private (world owner or staff)
 */
exports.setDependencies = async (req, res, next) => {
  try {
    const world = ownedWorld(req, res);
    if (!world) return;

    // What a world requires is part of what a judge downloads, so the entry lock covers it as it covers
    // the content. Staff go through, as on every listing edit.
    const judging = judgingContest(world);
    if (judging && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(409).json(contestLockedBody(judging));
    }

    const { ids, error } = idList(req.body.sourceIds, 'sourceIds');
    if (error) return res.status(400).json({ success: false, error });

    const refusal = dependencyRefusal(world, ids, req.user);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    // A changed set changes what downloading the world installs, which is what the revision is for.
    const changed = Dependency.replaceFor(world.id, ids);
    const current = changed ? World.touch(world.id) : world;

    res.status(200).json({
      success: true,
      data: {
        id: world.id,
        revision: current.revision,
        requiredDependencies: Dependency.resolveFor(world.id, req.user)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Replace the worlds a component is offered for
 * @route   PUT /api/worlds/:id/compatibility
 * @access  Private (component owner or staff)
 */
exports.setCompatibility = async (req, res, next) => {
  try {
    const component = ownedWorld(req, res);
    if (!component) return;

    const { ids, error } = idList(req.body.worldIds, 'worldIds');
    if (error) return res.status(400).json({ success: false, error });

    const refusal = compatibilityRefusal(component, ids, req.user);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    Compatibility.replaceFor(component.id, ids);

    res.status(200).json({
      success: true,
      data: { id: component.id, compatibleWorlds: compatibleWorldsFor(component, req.user) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The components offered for a world, as the caller may take them.
 *
 * Never an unlisted one, whoever asks: unlisted can be required, never offered. Never one the caller
 * could not open on its own. The world's author and staff also see the declined, because the author's
 * review list is this list; the room is shown only what the author has not turned away.
 *
 * @desc    List a world's add-on offerings
 * @route   GET /api/worlds/:id/addons
 * @access  Public (anyone who can read the world)
 */
exports.getAddons = async (req, res, next) => {
  try {
    const world = readableWorld(req, res);
    if (!world) return;

    const showDeclined = seesDeclined(req.user, world.author_id);

    const addons = [];
    for (const row of Compatibility.componentsFor(world.id)) {
      if (row.review_state === 'declined' && !showDeclined) continue;

      const component = World.findById(row.component_id);
      if (component.visibility !== PUBLIC || !World.isVisibleTo(component, req.user)) continue;

      const listing = World.findByIdWithAuthor(component.id, req.user);
      delete listing.content_file;
      addons.push({ ...listing, ...reviewFields(row, row.component_revision) });
    }

    res.setHeader('Cache-Control', 'private, no-cache');
    res.vary('Authorization');

    res.status(200).json({ success: true, count: addons.length, data: addons });
  } catch (error) {
    next(error);
  }
};

/**
 * The world author's answer to an offer. The author alone: a review is a recommendation about their own
 * world, not a moderation act, so staff do not write it for them.
 *
 * @desc    Set the review state of a component offered for a world
 * @route   PUT /api/worlds/:id/addons/:componentId/review
 * @access  Private (world owner only)
 */
exports.setReviewState = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);
    if (!world) return res.status(404).json(NOT_FOUND);

    if (world.author_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Only the world author can review an add-on' });
    }

    const { reviewState } = req.body;
    if (!isValidReviewState(reviewState)) {
      return res.status(400).json({ success: false, error: `Review state must be one of: ${REVIEW_STATES.join(', ')}` });
    }

    const association = Compatibility.find(req.params.componentId, world.id);
    if (!association) return res.status(404).json(NOT_FOUND);

    const component = World.findById(association.component_id);
    const reviewed = Compatibility.review(component.id, world.id, reviewState, component.revision);

    res.status(200).json({
      success: true,
      data: { worldId: world.id, componentId: component.id, ...reviewFields(reviewed, component.revision) }
    });
  } catch (error) {
    next(error);
  }
};
