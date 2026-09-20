const World = require('../models/World');
const User = require('../models/User');
const { STAFF_PROTECTED, canModerate, isAdmin } = require('../config/roles');
const { validationResult } = require('express-validator');
const { saveWorldContent, saveThumbnail, deleteWorldContent, deleteThumbnail, getThumbnailBase64 } = require('../utils/fileStorage');
const { DEFAULT_KIND, rulesFor } = require('../config/kinds');
const { kindFromQuery } = require('../utils/kindQuery');
const { placeholderFor } = require('../config/placeholderThumbnails');
const { readVrmLicenseMeta, licenseGate, normalizeVrmLicense } = require('../utils/vrmLicenseGate');
const { v4: uuidv4 } = require('uuid');
const AuditLog = require('../models/AuditLog');
const { flagDeletedListing } = require('./reportController');
const Changelog = require('../models/Changelog');
const Event = require('../models/Event');
const { sweepQuarantine } = require('../utils/sweepQuarantine');
const { recordSignal, addressHash } = require('../utils/recordSignal');
const Signal = require('../models/Signal');
const Setting = require('../models/Setting');
const AnonymousLike = require('../models/AnonymousLike');
const {
  ANONYMOUS_LIKES, CODES, INSTALL_HEADER_NAME, installIdFrom
} = require('../config/anonymousLikes');
const { clientAddress } = require('../utils/clientAddress');
const { browserFamily } = require('../utils/browserFamily');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { modelList } = require('../utils/modelList');
const { appVersionOf } = require('../utils/appVersion');
const Dependency = require('../models/Dependency');
const Compatibility = require('../models/Compatibility');
const { judgingContest, contestLockedBody } = require('../utils/judgingContest');
const {
  idList, dependencyRefusal, compatibilityRefusal, visibilityError, attachRelationships
} = require('../utils/linkedContent');

/**
 * Whether this server lets a guest press the heart at all.
 *
 * Rides on the catalog and on a listing so a client knows before the press, rather than finding out by
 * being refused. It says what the server allows and never what this reader may do, so it is the same
 * value for everyone and adds nothing to a response's `Vary`.
 *
 * @returns {boolean} Whether the setting is on
 */
const anonymousLikesEnabled = () => Setting.get(ANONYMOUS_LIKES) === true;

/**
 * Fill in `liked` for a guest who named their Install.
 *
 * A signed-in reader's hearts are already filled from their account and are not touched here — the
 * account is the answer for somebody who has one, whatever Install they happen to be on. A guest who
 * sends no Install keeps the flag absent, exactly as they do today: having no account is not a decision
 * against liking anything.
 *
 * Reads the whole page in one query, so a catalog costs the same one look however many cards it holds.
 *
 * @param {Object} req - The Express request
 * @param {Array<Object>} worlds - The rows about to be sent, edited in place
 */
const markGuestLikes = (req, worlds) => {
  if (req.user || worlds.length === 0) return;

  const installId = installIdFrom(req);
  if (!installId) return;

  const liked = AnonymousLike.likedAmong(worlds.map((world) => world.id), installId);
  for (const world of worlds) world.liked = liked.has(world.id);
};

/** One account's like, as both like lists send it. Shared so the audit cannot drift from the plain list. */
const likerRow = (row) => ({
  id: row.id,
  username: row.username,
  avatarUrl: avatarUrlFor(row.avatar_file),
  status: row.status,
  createdAt: row.created_at,
  likedAt: row.liked_at,
  accountAgeAtLikeSeconds: row.account_age_seconds
});

/** How long a quarantine runs by default, and the bounds an admin may set instead. */
const DEFAULT_QUARANTINE_DAYS = 7;
const MIN_QUARANTINE_DAYS = 1;
const MAX_QUARANTINE_DAYS = 90;

/** How much the author's first update buys them. Deliberately the same as the default quarantine. */
const EXTENSION_DAYS = 7;

/**
 * The kind's content ceiling as an error string, or null when it fits.
 *
 * Shared by create and update so the cap is a property of the row rather than of whichever path wrote it:
 * enforcing it on create alone means a 1KB dictionary can be PUT up to the global 100MB a moment later.
 */
function contentSizeError(contentData, rules) {
  if (!contentData) return null;
  const bytes = Buffer.byteLength(JSON.stringify(contentData));
  if (bytes <= rules.maxContentBytes) return null;
  return `${rules.label} content exceeds the ${Math.round(rules.maxContentBytes / 1024 / 1024)}MB limit`;
}

/**
 * Read a prompt's models off a publish body, as an error string or the cleaned list.
 *
 * A kind that has no models ignores the field. On an update an absent field keeps the stored list, which
 * already holds at least one.
 *
 * @param {Object} body - The request body
 * @param {Object} rules - The kind's rules
 * @param {boolean} required - Whether the body must carry the field
 * @returns {{models?: string[], error?: string}} Undefined `models` when there is nothing to write
 */
function modelsField(body, rules, required) {
  if (!rules.requiresModels) return {};
  if (body.models === undefined && !required) return {};

  const { models, error } = modelList(body.models ?? []);
  if (error) return { error };
  if (models.length === 0) return { error: `A ${rules.label.toLowerCase()} must name at least one model it works with` };
  return { models };
}

/**
 * Read an Avatar publish's file once, for both the gate and the terms a reader is shown.
 *
 * This is the only kind whose content the server parses. `contentData.vrm` is a data URL of the file's own
 * bytes; the client-sent `contentData.license` is never read here — it is stored verbatim for readers of
 * the content, but both the verdict and the displayed terms are re-derived from the file itself, so a
 * client cannot claim a license the file does not carry.
 *
 * One parse rather than two: an Avatar's bytes run to tens of megabytes, and decoding them twice per
 * publish would be the most expensive thing the route does.
 *
 * @param {Object} contentData - The publish body's content
 * @returns {{error?: Object, license?: Object}} A refusal to return, or the license to store
 */
function readModelContent(contentData) {
  if (!contentData) return {};

  const dataUrl = contentData.vrm;
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:[^;,]*;base64,(.+)$/);
  if (!match) return { error: { error: 'Avatar content must include a vrm data URL' } };

  const meta = readVrmLicenseMeta(Buffer.from(match[1], 'base64'));
  const { allowed, failedRequirements } = licenseGate(meta);
  if (!allowed) {
    return { error: { error: 'That Avatar does not have a Permissive License', failedRequirements } };
  }

  return { license: normalizeVrmLicense(meta) };
}

/**
 * Decide whether a publish may carry the contest entry it asked for.
 *
 * The id is named explicitly rather than inferred, so a publish that started while one contest was
 * running and landed after another had taken over is refused outright instead of being quietly entered
 * in the wrong place. One entry per person per contest, and a second one refuses the whole publish —
 * a listing the author only wanted in the contest must not appear outside it as a consolation.
 *
 * @param {string} eventId - The contest named in the body
 * @param {Object} user - The publishing user
 * @returns {Object|null} `{ status, code, error }` on refusal, otherwise null
 */
const contestEntryRefusal = (eventId, user) => {
  const active = Event.activeContest();

  if (!active || active.id !== eventId) {
    return {
      status: 409,
      code: 'CONTEST_NOT_ACTIVE',
      error: 'That contest is not running. Refresh and try again.'
    };
  }

  const existing = World.contestEntryFor(user.id, active.id);
  if (!existing) return null;

  return {
    status: 409,
    code: 'CONTEST_ALREADY_ENTERED',
    error: `You have already entered "${existing.name}" in ${active.title}. Withdraw it first to enter something else.`
  };
};

/**
 * Read the linked-content fields off a publish body and check them against the row they are for.
 *
 * All three are optional and additive: a body that names none of them publishes exactly as before. Checked
 * before any file is written, so a refused id leaves nothing on disk. The kind is the stored row's on an
 * update and the body's on a create, which is why it is passed in rather than read here.
 *
 * @param {Object} body - The request body
 * @param {Object} row - `{ id, kind }` of the listing being written; `id` is null on a create
 * @param {Object} user - Who is publishing
 * @returns {Object} `{ refusal }` with `{ status, body }`, or `{ visibility, sourceIds, worldIds }`, each
 *   undefined when the body did not name it
 */
const linkedContentFields = (body, row, user) => {
  const out = {};

  if (body.visibility !== undefined) {
    const error = visibilityError(body.visibility, row.kind);
    if (error) return { refusal: { status: 400, body: { success: false, error } } };
    out.visibility = body.visibility;
  }

  if (body.requiredDependencies !== undefined) {
    const { ids, error } = idList(body.requiredDependencies, 'requiredDependencies');
    if (error) return { refusal: { status: 400, body: { success: false, error } } };
    const refusal = dependencyRefusal(row, ids, user);
    if (refusal) return { refusal };
    out.sourceIds = ids;
  }

  if (body.compatibleWorlds !== undefined) {
    const { ids, error } = idList(body.compatibleWorlds, 'compatibleWorlds');
    if (error) return { refusal: { status: 400, body: { success: false, error } } };
    const refusal = compatibilityRefusal(row, ids, user);
    if (refusal) return { refusal };
    out.worldIds = ids;
  }

  return out;
};

/**
 * @desc    Get all worlds
 * @route   GET /api/worlds
 * @access  Public
 */
exports.getWorlds = async (req, res, next) => {
  try {
    // Extract query parameters
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const model = typeof req.query.model === 'string' ? req.query.model : '';
    const tags = req.query.tags || '';
    const searchByAuthor = req.query.searchByAuthor === 'true';
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'desc';
    // Absent `kind` means a client that predates the column — it must keep seeing worlds only.
    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    // Anything whose deadline passed is deleted before the catalog is read, so a missed timer tick can
    // never show a listing that should be gone. Cheap when there is nothing due.
    await sweepQuarantine();

    // Get worlds
    const result = World.getAll({
      page,
      limit,
      search,
      tags,
      searchByAuthor,
      sort,
      order,
      kind,
      model,
      viewer: req.user || null
    });

    markGuestLikes(req, result.worlds);

    // The catalog reads differently for every reader — liked marks, and an author's own quarantined
    // listings — so it is one reader's to hold, and it is only ever held against a revalidation. A guest's
    // marks come from the Install header, so a cache keyed on the token alone would hand one guest's
    // hearts to another.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.vary('Authorization');
    res.vary(INSTALL_HEADER_NAME);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      pagination: result.pagination,
      total: result.total,
      anonymousLikes: anonymousLikesEnabled(),
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single world
 * @route   GET /api/worlds/:id
 * @access  Public
 */
exports.getWorld = async (req, res, next) => {
  try {
    // Extract query parameters for comments
    const page = parseInt(req.query.commentsPage, 10) || 1;
    const limit = parseInt(req.query.commentsLimit, 10) || 5;
    const includeComments = req.query.includeComments === 'true';
    
    // Get world with or without comments based on query parameter
    const world = includeComments 
      ? World.findByIdWithAuthorAndComments(req.params.id, { page, limit }, req.user)
      : World.findByIdWithAuthor(req.params.id, req.user);

    // A quarantined listing is as absent as a deleted one to everyone but its author and the admins —
    // same 404, so its existence is not something the room can probe for.
    if (!world || !World.isVisibleTo(world, req.user)) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Opt-in like the comments embed, and for the same reason: this row is what the catalog serves for
    // every card on a page, and a changelog only an open listing ever reads would ride along with all of
    // them. Attached here rather than as a `findByIdWith…` variant so it composes with the comments flag
    // instead of needing a method per combination.
    if (req.query.includeChangelog === 'true') {
      world.changelog = Changelog.getByWorldId(world.id);
    }

    // Always, not opt-in: what a world requires is part of what the world is, and the client that opens
    // one needs it to know what a download will install.
    attachRelationships(world, req.user);

    // Get thumbnail as base64
    world.thumbnail = await getThumbnailBase64(world.thumbnail_file);
    delete world.thumbnail_file;

    markGuestLikes(req, [world]);
    res.vary(INSTALL_HEADER_NAME);

    res.status(200).json({
      success: true,
      anonymousLikes: anonymousLikesEnabled(),
      data: world
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get world content
 * @route   GET /api/worlds/:id/content
 * @access  Public
 */
exports.getWorldContent = async (req, res, next) => {
  try {
    // Checked before the download is counted: a quarantined listing is out of circulation, and a refused
    // download that still bumped the counter would be a lie in the other direction.
    const row = World.findById(req.params.id);
    if (row && !World.isVisibleTo(row, req.user)) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Increment download count
    World.incrementDownloads(req.params.id);

    // Get world with content
    const world = await World.getContent(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    res.status(200).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create new world
 * @route   POST /api/worlds
 * @access  Private
 */
exports.createWorld = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Check if user is suspended
    if (req.user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot upload worlds'
      });
    }

    // Extract data from request body. `contestEventId` rides top level rather than inside `contentData`:
    // entering is what the publisher is doing, not part of the world they are publishing, and putting it
    // in the content would change the shape of every exported file for a flag the game never reads.
    const { name, description, thumbnail, contentData, contestEventId } = req.body;

    const kind = req.body.kind || DEFAULT_KIND;
    const rules = rulesFor(kind);

    if (contestEventId && !rules.canEnterContest) {
      return res.status(400).json({
        success: false,
        code: 'CONTEST_KIND_REFUSED',
        error: `A ${rules.label.toLowerCase()} cannot be entered in a contest`
      });
    }

    if (contestEventId) {
      const refusal = contestEntryRefusal(contestEventId, req.user);
      if (refusal) {
        return res.status(refusal.status).json({ success: false, code: refusal.code, error: refusal.error });
      }
    }

    // Extract tags from contentData.worldOverview (preferred), then worldOverview, then a direct tags field
    let tags;
    if (contentData && contentData.worldOverview && contentData.worldOverview.tags !== undefined) {
      tags = contentData.worldOverview.tags;
    } else if (req.body.worldOverview && req.body.worldOverview.tags !== undefined) {
      tags = req.body.worldOverview.tags;
    } else if (req.body.tags !== undefined) {
      tags = req.body.tags;
    }

    // Validate required fields
    if (!name || !contentData) {
      return res.status(400).json({ success: false, message: 'Name and content data are required' });
    }

    // Size is capped per kind: a world may legitimately carry 100MB of base64 art, a lorebook may not.
    const tooLarge = contentSizeError(contentData, rules);
    if (tooLarge) {
      return res.status(400).json({ success: false, error: tooLarge });
    }

    const { models, error: modelsError } = modelsField(req.body, rules, true);
    if (modelsError) {
      return res.status(400).json({ success: false, error: modelsError });
    }

    // Held from the gate's own parse, so the terms a reader is shown are stored without decoding the
    // file a second time.
    let modelLicense = null;
    if (kind === 'model') {
      const { error: gateError, license } = readModelContent(contentData);
      if (gateError) {
        return res.status(400).json({ success: false, ...gateError });
      }
      modelLicense = license;
    }

    const linked = linkedContentFields(req.body, { id: null, kind }, req.user);
    if (linked.refusal) {
      return res.status(linked.refusal.status).json(linked.refusal.body);
    }

    // Generate UUID for the world
    const worldId = uuidv4();

    try {
      // A kind that can't promise an image falls back to its stand-in art, routed through the same save
      // path so the row owns its own copy and per-row deletion still applies.
      const thumbnailSource = thumbnail || placeholderFor(kind);
      const thumbnailFile = await saveThumbnail(thumbnailSource);

      // Save content to file
      const contentFile = await saveWorldContent(worldId, contentData);

      // Create world in database
      const world = World.create(
        {
          id: worldId,
          name,
          // `description` is NOT NULL; an empty string satisfies it for the kinds that have none to give,
          // which avoids a table rebuild on a live database just to relax the constraint.
          description: description || '',
          author_id: req.user.id,
          tags,
          kind,
          model_license: modelLicense ? JSON.stringify(modelLicense) : null,
          contest_event_id: contestEventId || null,
          visibility: linked.visibility,
          models,
          app_version: rules.stampsAppVersion ? appVersionOf(contentData) : null
        },
        contentFile,
        thumbnailFile
      );

      // Declared in the same publish, so a world and what it requires appear together rather than a world
      // appearing first with nothing behind it.
      if (linked.sourceIds) Dependency.replaceFor(worldId, linked.sourceIds);
      if (linked.worldIds) Compatibility.replaceFor(worldId, linked.worldIds);

      recordSignal(req, req.user.id, 'publish');

      // Get full world data for response
      const fullWorld = attachRelationships(await World.getContent(worldId), req.user);

      res.status(201).json({
        success: true,
        data: fullWorld
      });
    } catch (error) {
      // If the error is related to content size, return a 400 error
      if (error.message && error.message.includes('exceeds maximum size')) {
        return res.status(400).json({
          success: false,
          error: error.message
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update world
 * @route   PUT /api/worlds/:id
 * @access  Private
 */
exports.updateWorld = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Get world
    let world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is suspended and not an admin
    if (req.user.status === 'suspended' && !isAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot update worlds'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this world'
      });
    }

    // An entry stops being editable when its contest stops taking entries, and starts again the moment the
    // results are announced. Judging something that can be rewritten underneath the judges is not judging it.
    //
    // Staff go through, as they do everywhere: moderation always wins, and the audit trail is what
    // accounts for it. Only the content is held — the spoiler flag, comments, likes and deleting the
    // whole thing all stay open, because none of them change the work being judged.
    const judging = judgingContest(world);
    if (judging && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(409).json(contestLockedBody(judging));
    }

    // Held from before the write: `World.update` returns the new row, and the extension has to know
    // whether this episode had already used its grace.
    const quarantinedBefore = world.quarantined_at ? world : null;

    // Extract data from request body
    const { name, description, thumbnail, contentData } = req.body;

    // The stored row's kind is authoritative and immutable — a listing cannot turn from a world into a
    // character. Without this, a PUT naming someone's world writes character content into it while the row
    // still reads `kind='world'`: the catalog lists it as a world and the client migrates a character as
    // one. The client only ever offers same-kind targets, but that's a UI convention, not a rule.
    const kind = world.kind || DEFAULT_KIND;
    if (req.body.kind && req.body.kind !== kind) {
      return res.status(400).json({
        success: false,
        error: `Cannot change a ${kind} listing into a ${req.body.kind}`
      });
    }

    // Same ceiling as create: the cap belongs to the row, not to the path that wrote it.
    const tooLarge = contentSizeError(contentData, rulesFor(kind));
    if (tooLarge) {
      return res.status(400).json({ success: false, error: tooLarge });
    }

    const { models, error: modelsError } = modelsField(req.body, rulesFor(kind), false);
    if (modelsError) {
      return res.status(400).json({ success: false, error: modelsError });
    }

    let modelLicense = null;
    if (kind === 'model' && contentData) {
      const { error: gateError, license } = readModelContent(contentData);
      if (gateError) {
        return res.status(400).json({ success: false, ...gateError });
      }
      modelLicense = license;
    }

    const linked = linkedContentFields(req.body, world, req.user);
    if (linked.refusal) {
      return res.status(linked.refusal.status).json(linked.refusal.body);
    }

    // Extract tags from contentData.worldOverview (preferred), then worldOverview, then a direct tags field
    let tags;
    if (req.body.contentData && req.body.contentData.worldOverview && req.body.contentData.worldOverview.tags !== undefined) {
      tags = req.body.contentData.worldOverview.tags;
    } else if (req.body.worldOverview && req.body.worldOverview.tags !== undefined) {
      tags = req.body.worldOverview.tags;
    } else if (req.body.tags !== undefined) {
      tags = req.body.tags;
    }

    // Prepare update data
    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (tags !== undefined) updateData.tags = tags; // Include tags if provided
    // Re-derived from the replacement file, so a re-export's terms replace the ones on screen. An update
    // that sends no content leaves the stored terms alone, because the file behind them has not changed.
    if (modelLicense) updateData.model_license = JSON.stringify(modelLicense);
    if (models) updateData.models = JSON.stringify(models);
    if (rulesFor(kind).stampsAppVersion && contentData) updateData.app_version = appVersionOf(contentData);

    try {
      // If thumbnail is provided, update it
      if (thumbnail) {
        // Delete old thumbnail
        if (world.thumbnail_file) {
          await deleteThumbnail(world.thumbnail_file);
        }
        
        // Save new thumbnail
        const thumbnailFile = await saveThumbnail(thumbnail);
        updateData.thumbnail_file = thumbnailFile;
      }

      // If content data is provided, update it
      if (contentData) {
        // Save new content
        await saveWorldContent(world.id, contentData);
      }

      // Neither declaration touches the row: visibility changes nothing a downloader receives, and a
      // compatibility offer is about somebody else's world. A changed dependency set does, so it counts
      // toward the revision bump below.
      if (linked.visibility) World.setVisibility(world.id, linked.visibility);
      if (linked.worldIds) Compatibility.replaceFor(world.id, linked.worldIds);
      const dependenciesChanged = linked.sourceIds ? Dependency.replaceFor(world.id, linked.sourceIds) : false;

      // Update world in database. New content alone is an update too — it is the whole of what a
      // downloader receives — so the row's date and revision move with it even when no field changed.
      if (contentData || dependenciesChanged || Object.keys(updateData).length > 0) {
        world = World.update(req.params.id, updateData);
      }

      // An update to a quarantined listing is the author answering the notice, so it goes in the log —
      // and the first one buys them more time, counted from the deadline they already had. Only the
      // first: the point is that somebody who fixes it on day six is not deleted on day seven, not that
      // editing repeatedly buys forever. An admin's own edit is not the author answering, so it neither
      // logs nor extends.
      if (quarantinedBefore && req.user.id === quarantinedBefore.author_id) {
        const extended = World.extendQuarantine(req.params.id, EXTENSION_DAYS);
        const grantedNow = Boolean(extended && extended.quarantine_extended && !quarantinedBefore.quarantine_extended);

        AuditLog.tryRecord({
          action: 'quarantine_updated',
          actor: req.user,
          targetKind: quarantinedBefore.kind || 'world',
          targetName: quarantinedBefore.name,
          snippet: grantedNow
            ? `Deadline extended by ${EXTENSION_DAYS} days to ${extended.quarantine_expires_at}`
            : 'Updated again; the deadline had already been extended'
        });
      }

      // An edit is filed under `publish` rather than an event of its own: both are the author putting work
      // in front of the room, and a vocabulary that splits them buys nothing a ring could be caught by.
      recordSignal(req, req.user.id, 'publish');

      // Get full world data for response
      const fullWorld = attachRelationships(await World.getContent(req.params.id), req.user);

      res.status(200).json({
        success: true,
        data: fullWorld
      });
    } catch (error) {
      // If the error is related to content size, return a 400 error
      if (error.message && error.message.includes('exceeds maximum size')) {
        return res.status(400).json({
          success: false,
          error: error.message
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Set world spoiler status
 * @route   PUT /api/worlds/:id/spoiler
 * @access  Private (world owner or admin only)
 */
/**
 * Like a listing, or take the like back.
 *
 * A like says somebody was glad they downloaded something, which is the thing the download counter cannot
 * tell you — plenty of people try a world and never finish it. So it is per account and revocable, where
 * a download is an anonymous tally that only ever goes up.
 *
 * Answers with the state and the new count together, the way following does, so the heart and the number
 * beside it can never disagree about what just happened.
 *
 * @desc    Set whether the signed-in account likes a listing
 * @route   PUT /api/worlds/:id/like
 * @access  Private
 */
exports.setLikeStatus = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);

    // A quarantined listing is as absent as a deleted one to everyone but its author and the staff — and
    // nobody can like what they cannot see.
    if (!world || !World.isVisibleTo(world, req.user)) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    // Liking your own work would make the count say something about how many listings somebody has rather
    // than how many people liked them, the same reason following yourself is refused.
    if (world.author_id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot like your own listing' });
    }

    const { liked } = req.body;
    if (typeof liked !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Liked must be a boolean value' });
    }

    World.setLike(world.id, req.user.id, liked);

    // Recorded whichever way the heart went. The Signal is about the account acting from an address, and a
    // ring that could clear its trail by unliking would be a ring this table could not see.
    recordSignal(req, req.user.id, 'like');

    res.status(200).json({
      success: true,
      data: { liked, likes: World.likeCount(world.id) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Set or clear an Anonymous Like, for somebody who has not signed in.
 *
 * The heart used to send a guest to sign-in, and most of them stopped there — so a listing somebody was
 * glad they downloaded looked unloved. This is the same press with somewhere to land: a mark against the
 * Install, added into the same number an account Like is added into.
 *
 * Takes no token at all. A token that arrives anyway changes nothing, because the mark belongs to the
 * Install and the account route is what a signed-in client uses.
 *
 * Every refusal carries a code as well as its wording. The client picks a different message for each —
 * a switched-off server sends the guest to sign-in as it always did, and a listing that has gone quiet
 * needs no message — and a code lets the wording change without changing what the client does.
 *
 * The cap on how many Anonymous Likes one address may give a listing, and the guards that follow an
 * Install's linked account, are separate work. This route is the press and nothing more.
 *
 * @desc    Set whether this Install likes a listing
 * @route   PUT /api/worlds/:id/anonymous-like
 * @access  Public
 */
exports.setAnonymousLikeStatus = async (req, res, next) => {
  try {
    // First, and before anything else is read: the switch is the operator's emergency stop, and what
    // else might be wrong with a request is not something a switched-off server should answer.
    if (Setting.get(ANONYMOUS_LIKES) !== true) {
      return res.status(403).json({
        success: false,
        code: CODES.OFF,
        error: 'Liking without an account is switched off on this server'
      });
    }

    // As the room sees it, with no viewer: this route has no account behind it, so a quarantined or
    // unlisted listing is as absent here as a deleted one.
    const world = World.findById(req.params.id);
    if (!World.isVisibleTo(world, null)) {
      return res.status(404).json({ success: false, code: CODES.NOT_VISIBLE, error: 'World not found' });
    }

    const installId = installIdFrom(req);
    if (!installId) {
      return res.status(400).json({
        success: false,
        code: CODES.BAD_INSTALL,
        error: 'This request carried no usable install id'
      });
    }

    const { liked } = req.body;
    if (typeof liked !== 'boolean') {
      return res.status(400).json({
        success: false,
        code: CODES.BAD_LIKED,
        error: 'Liked must be a boolean value'
      });
    }

    // Where the mark came from, in the form a Signal holds it: the address is hashed with the same salt
    // and never stored, and the browser family is the same coarse tiebreaker. Both are for the cap and
    // the staff audit; the like itself needs neither.
    AnonymousLike.set(world.id, installId, liked, {
      addressHash: addressHash(clientAddress(req)),
      browserFamily: browserFamily(req.headers['user-agent'])
    });

    res.status(200).json({
      success: true,
      data: { liked, likes: World.likeCount(world.id) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Who liked a listing, newest like first, with how old each account was when it did.
 *
 * Staff only, and refused to the listing's own author: their count stays a count and nothing more. The
 * age is here so a fresh account that liked the day it was made stands out without date math.
 *
 * @desc    List the accounts that liked a listing
 * @route   GET /api/worlds/:id/likes
 * @access  Private/Staff
 */
exports.getLikers = async (req, res, next) => {
  try {
    // As stored, not as the room sees it: a quarantined listing still answers, since hiding a listing
    // must not hide the evidence of how it was liked.
    const world = World.findById(req.params.id);
    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    const { total, rows } = World.likers(world.id);

    res.status(200).json({ success: true, data: { total, rows: rows.map(likerRow) } });
  } catch (error) {
    next(error);
  }
};

/**
 * The likes on a listing with the Signals behind them read across.
 *
 * The plain list already says how old each account was when it liked, which is half of what tells a
 * popular listing from an inflated one. This is the other half: which of these accounts acted from the
 * same address as each other, and which acted from the author's. Four accounts made minutes apart from
 * one place, all liking one contest entry, is the shape this is for.
 *
 * A separate route rather than a field on the list, so the plain list stays cheap and staff-only data
 * stays off it. Reading it is routine staff work and writes no audit entry. `models/Signal.sharedAddressGroups`
 * explains what a group means. Nothing here acts — the removal route beside it is what staff act with.
 *
 * @desc    List the accounts that liked a listing, grouped by shared network address
 * @route   GET /api/worlds/:id/likes/audit
 * @access  Private/Staff
 */
exports.getLikersAudit = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);
    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    const { total, rows } = World.likers(world.id);
    const { groupOf, linkedToTarget } = Signal.sharedAddressGroups(
      rows.map((row) => row.id),
      world.author_id
    );

    res.status(200).json({
      success: true,
      data: {
        total,
        rows: rows.map((row) => ({
          ...likerRow(row),
          groupId: groupOf.get(row.id) ?? null,
          linkedToAuthor: linkedToTarget.has(row.id)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Take one account's like off a listing. The public count drops on the next read: it is counted per
 * query, so there is no cache to clear.
 *
 * @desc    Remove one account's like from a listing
 * @route   DELETE /api/worlds/:id/likes/:userId
 * @access  Private/Staff
 */
exports.removeLike = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);
    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    const liker = User.findById(req.params.userId);
    if (!liker) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Checked before the "nothing to remove" answer: whether a staff account liked something is not a
    // moderator's to learn by probing.
    if (!canModerate(req.user, liker)) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    // Logged only when a row went: the log records corrections, not attempts.
    if (World.removeLike(world.id, liker.id)) {
      AuditLog.tryRecord({
        action: 'like_removed',
        actor: req.user,
        targetUser: liker.id === req.user.id ? null : liker,
        targetKind: world.kind || 'world',
        targetName: world.name
      });
    }

    res.status(200).json({ success: true, data: { likes: World.likeCount(world.id) } });
  } catch (error) {
    next(error);
  }
};

exports.setSpoilerStatus = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Get world
    let world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this world'
      });
    }

    // Extract spoiler status from request body
    const { spoiler } = req.body;

    // Validate spoiler is a boolean
    if (typeof spoiler !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Spoiler must be a boolean value'
      });
    }

    // Update world spoiler status without updating the updated_at timestamp
    world = World.updateSpoilerStatus(req.params.id, spoiler);

    // Convert spoiler back to boolean for response
    world.spoiler = world.spoiler === 1;

    res.status(200).json({
      success: true,
      data: {
        id: world.id,
        name: world.name,
        spoiler: world.spoiler
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Put a listing into quarantine: out of the catalog, and deleted when the deadline passes
 * @route   PUT /api/worlds/:id/quarantine
 * @access  Private/Admin
 */
exports.quarantineWorld = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);
    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    // Staff moderate the room, not each other. Checked here rather than left to the route's `staff` gate:
    // a quarantine deletes the listing when its deadline passes, so without this a moderator could
    // destroy another moderator's — or an administrator's — work on a timer.
    if (!canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    const requested = req.body.days === undefined ? DEFAULT_QUARANTINE_DAYS : Number(req.body.days);
    if (!Number.isInteger(requested) || requested < MIN_QUARANTINE_DAYS || requested > MAX_QUARANTINE_DAYS) {
      return res.status(400).json({
        success: false,
        error: `Quarantine must be between ${MIN_QUARANTINE_DAYS} and ${MAX_QUARANTINE_DAYS} whole days`
      });
    }

    const quarantined = World.quarantine(world.id, requested);
    const author = world.author_id === req.user.id ? null : User.findById(world.author_id);

    AuditLog.tryRecord({
      action: 'listing_quarantined',
      actor: req.user,
      targetUser: author,
      targetKind: world.kind || 'world',
      targetName: world.name,
      snippet: `Deleted on ${quarantined.quarantine_expires_at} unless released`
    });

    res.status(200).json({
      success: true,
      data: {
        id: quarantined.id,
        quarantinedAt: quarantined.quarantined_at,
        quarantineExpiresAt: quarantined.quarantine_expires_at,
        quarantineExtended: Boolean(quarantined.quarantine_extended)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Lift a quarantine, returning the listing to the catalog
 * @route   DELETE /api/worlds/:id/quarantine
 * @access  Private/Admin
 */
exports.releaseWorld = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);
    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }
    if (!canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    if (!world.quarantined_at) {
      return res.status(400).json({ success: false, error: 'This is not quarantined' });
    }

    World.release(world.id);
    const author = world.author_id === req.user.id ? null : User.findById(world.author_id);

    AuditLog.tryRecord({
      action: 'quarantine_released',
      actor: req.user,
      targetUser: author,
      targetKind: world.kind || 'world',
      targetName: world.name
    });

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

/**
 * Take a listing out of the contest it was entered in.
 *
 * Owner-or-moderator, which is where entry moderation comes from: staff pulling an entry that should not
 * be in the running is the same act as its author changing their mind, and both are worth a log line.
 * Always audited, because the schema keeps no record of a withdrawal — the flag simply goes.
 *
 * The one refusal is a listing that placed. The announcement has gone out and the archive names it; taking
 * it back would leave a hole in the podium. Deleting the listing is still the author's.
 *
 * @desc    Withdraw a listing from its contest
 * @route   DELETE /api/worlds/:id/contest
 * @access  Private (owner or staff)
 */
exports.withdrawEntry = async (req, res, next) => {
  try {
    const world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({ success: false, error: 'World not found' });
    }

    if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({ success: false, error: 'Not authorized to update this world' });
    }

    if (!world.contest_event_id) {
      return res.status(400).json({ success: false, error: 'That listing is not entered in a contest' });
    }

    const event = Event.findById(world.contest_event_id);
    const placed = Event.placements(world.contest_event_id)
      .some((placement) => placement.world_id === world.id);
    if (placed) {
      return res.status(409).json({
        success: false,
        code: 'CONTEST_PLACED',
        error: 'A world that placed cannot be withdrawn. Delete the listing if you want it gone.'
      });
    }

    World.withdrawFromContest(world.id);

    // Logged whoever did it, and self-withdrawal names no target — the delete precedent. There is nothing
    // else anywhere that says this listing was ever entered.
    AuditLog.tryRecord({
      action: 'entry_withdrawn',
      actor: req.user,
      targetUser: world.author_id === req.user.id ? null : User.findById(world.author_id),
      targetKind: world.kind || 'world',
      targetName: world.name,
      snippet: event ? event.title : world.contest_event_id
    });

    res.status(200).json({ success: true, data: { id: world.id, contestEventId: null } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete world
 * @route   DELETE /api/worlds/:id
 * @access  Private
 */
exports.deleteWorld = async (req, res, next) => {
  try {
    // Get world
    const world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this world'
      });
    }

    // Delete content file
    if (world.content_file) {
      await deleteWorldContent(world.content_file);
    }

    // Delete thumbnail file
    if (world.thumbnail_file) {
      await deleteThumbnail(world.thumbnail_file);
    }

    // Delete world from database
    World.delete(req.params.id);

    // An author taking their own listing down neither punishes nor absolves them: any open report on it
    // stays open, flagged, leaning on the snapshot to say what was there. A staff takedown is a
    // moderation act they will resolve, so only the author's own removal needs saying.
    //
    // Reports on its *comments* are flagged too: the thread cascaded away with the listing, so without
    // this they would sit in the queue looking live and pointing at a listing that is gone.
    if (world.author_id === req.user.id) flagDeletedListing(world.id);

    // Logged whoever did it: an author tidying up and an admin taking something down are the same
    // disappearance to anyone asking where it went, and the entry says which it was.
    AuditLog.tryRecord({
      action: 'listing_deleted',
      actor: req.user,
      targetUser: world.author_id === req.user.id ? null : User.findById(world.author_id),
      targetKind: world.kind || 'world',
      targetName: world.name,
      snippet: world.description
    });

    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (error) {
    next(error);
  }
};
