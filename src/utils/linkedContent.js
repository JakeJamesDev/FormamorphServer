const World = require('../models/World');
const Dependency = require('../models/Dependency');
const Compatibility = require('../models/Compatibility');
const { isStaff } = require('../config/roles');
const {
  isComponentKind, isValidVisibility, UNLISTED, MAX_ASSOCIATIONS
} = require('../config/relationships');

/** What every hidden-or-missing listing answers with. One wording, so a probe cannot tell the cases apart. */
const NOT_FOUND = { success: false, error: 'World not found' };

/**
 * Read a list of listing ids off a request body.
 *
 * @param {*} value - The body field
 * @param {string} field - Its name, for the error
 * @returns {{ids?: string[], error?: string}} The deduplicated ids, or why they were refused
 */
const idList = (value, field) => {
  if (!Array.isArray(value)) return { error: `${field} must be an array of listing ids` };
  if (value.length > MAX_ASSOCIATIONS) return { error: `${field} cannot name more than ${MAX_ASSOCIATIONS} listings` };
  if (value.some((id) => typeof id !== 'string' || !id)) return { error: `${field} must be an array of listing ids` };

  return { ids: [...new Set(value)] };
};

/**
 * Decide whether a world may require these sources.
 *
 * A source must be a component, and it must be one the declarer could open themselves. That second rule
 * is what keeps unlisted meaning something: without it, anyone holding an unlisted id could publish a
 * world that requires it and hand the room a listing its author hid. The refusal names the ids as not
 * found rather than as hidden, for the same reason every other hidden listing does. Checked at
 * declaration only: a source unlisted afterwards stays required by the worlds that already name it.
 *
 * @param {Object} world - The world row declaring; `id` is null on a create
 * @param {string[]} sourceIds - The ids it wants to require
 * @param {Object} declarer - Who is declaring
 * @returns {Object|null} `{ status, body }` on refusal, otherwise null
 */
const dependencyRefusal = (world, sourceIds, declarer) => {
  if (world.kind !== 'world') {
    return { status: 400, body: { success: false, error: 'Only a world can require dependencies' } };
  }

  const missing = [];
  const wrongKind = [];
  for (const id of sourceIds) {
    const source = World.findById(id);
    if (!source || id === world.id || !World.isVisibleTo(source, declarer)) {
      missing.push(id);
    } else if (!isComponentKind(source.kind)) {
      wrongKind.push(id);
    }
  }

  if (missing.length > 0) {
    return { status: 404, body: { ...NOT_FOUND, code: 'SOURCE_NOT_FOUND', sourceIds: missing } };
  }
  if (wrongKind.length > 0) {
    return {
      status: 400,
      body: {
        success: false,
        code: 'SOURCE_NOT_COMPONENT',
        error: 'A required dependency must be a character or a dictionary',
        sourceIds: wrongKind
      }
    };
  }

  return null;
};

/**
 * Decide whether a component may be offered for these worlds. A world the declarer cannot open is refused
 * as not found, so a quarantined world's existence is no more visible here than anywhere else.
 *
 * @param {Object} component - The component row declaring
 * @param {string[]} worldIds - The worlds it wants to be offered for
 * @param {Object} declarer - Who is declaring
 * @returns {Object|null} `{ status, body }` on refusal, otherwise null
 */
const compatibilityRefusal = (component, worldIds, declarer) => {
  if (!isComponentKind(component.kind)) {
    return { status: 400, body: { success: false, error: 'Only a character or a dictionary can declare compatibility' } };
  }

  const missing = worldIds.filter((id) => {
    const world = World.findById(id);
    return !world || world.kind !== 'world' || !World.isVisibleTo(world, declarer);
  });

  if (missing.length > 0) {
    return { status: 404, body: { ...NOT_FOUND, code: 'WORLD_NOT_FOUND', worldIds: missing } };
  }

  return null;
};

/**
 * Whether a visibility may be set on this kind of row, as an error string or null.
 *
 * @param {*} visibility - The body field
 * @param {string} kind - The row's kind
 * @returns {string|null} Why it was refused
 */
const visibilityError = (visibility, kind) => {
  if (!isValidVisibility(visibility)) return "Visibility must be 'public' or 'unlisted'";
  if (visibility === UNLISTED && !isComponentKind(kind)) return 'Only a character or a dictionary can be unlisted';

  return null;
};

/**
 * The review columns of a compatibility row, as every response spells them.
 *
 * @param {Object} row - A `listing_compatibility` row
 * @param {number} componentRevision - The component's current revision
 * @returns {Object} `{ reviewState, reviewedRevision, reviewedAt, updatedSinceReview }`
 */
const reviewFields = (row, componentRevision) => ({
  reviewState: row.review_state,
  reviewedRevision: row.reviewed_revision,
  reviewedAt: row.reviewed_at,
  // Never reviewed is never "updated since": there is no review for it to be updated since.
  updatedSinceReview: row.reviewed_revision !== null && componentRevision > row.reviewed_revision
});

/**
 * Whether this viewer is shown declined offers. A decline is the world author's private answer: the
 * account that owns the listing being read sees it, because their own screen has to show it, and staff
 * see everything; the room sees the approved and the unanswered.
 *
 * @param {Object} [viewer] - The signed-in user, or null
 * @param {string} ownerId - The author of the listing whose offers are being read
 * @returns {boolean} True when declined rows may be shown
 */
const seesDeclined = (viewer, ownerId) => Boolean(viewer && (isStaff(viewer) || viewer.id === ownerId));

/**
 * The worlds a component is offered for, as this viewer may see them. A world the viewer cannot open is
 * left out.
 *
 * @param {Object} component - The component row
 * @param {Object} [viewer] - The signed-in user, or null
 * @returns {Array<Object>} `{ id, name, author, reviewState, reviewedRevision, reviewedAt, updatedSinceReview }`
 */
const compatibleWorldsFor = (component, viewer = null) => {
  const showDeclined = seesDeclined(viewer, component.author_id);

  return Compatibility.worldsFor(component.id)
    .filter((row) => World.isVisibleTo({ ...row, id: row.world_id }, viewer))
    .filter((row) => showDeclined || row.review_state !== 'declined')
    .map((row) => ({
      id: row.world_id,
      name: row.name,
      author: { id: row.author_id, username: row.author_username },
      ...reviewFields(row, component.revision)
    }));
};

/**
 * Attach a listing's relationships to a read of it: what a world requires, or what a component is offered
 * for. Absent rather than empty on the kinds that have neither, so a reader has nothing to render.
 *
 * @param {Object} listing - A listing as `findByIdWithAuthor` shapes it
 * @param {Object} [viewer] - The signed-in user, or null
 * @returns {Object} The same listing
 */
const attachRelationships = (listing, viewer = null) => {
  if (listing.kind === 'world') {
    listing.requiredDependencies = Dependency.resolveFor(listing.id, viewer);
  } else if (isComponentKind(listing.kind)) {
    listing.compatibleWorlds = compatibleWorldsFor(listing, viewer);
  }

  return listing;
};

module.exports = {
  NOT_FOUND,
  idList,
  dependencyRefusal,
  compatibilityRefusal,
  visibilityError,
  reviewFields,
  seesDeclined,
  compatibleWorldsFor,
  attachRelationships
};
