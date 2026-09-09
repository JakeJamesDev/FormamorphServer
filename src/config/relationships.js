/**
 * The vocabulary of linked content: how a listing is shown, and what a world author said about an add-on.
 *
 * Its own module rather than more constants in `kinds.js`, because none of this is about what a row *is*.
 * Visibility and review state are about how a row relates to the room and to another row.
 */

/**
 * The kinds a world can require, and the kinds that can be offered as an add-on. A world is never a
 * component of another world, and an Avatar is not content a world embeds.
 */
const COMPONENT_KINDS = ['entity', 'dictionary'];

const isComponentKind = (kind) => COMPONENT_KINDS.includes(kind);

/**
 * How a listing is shown. `public` is in the catalog. `unlisted` is hidden from discovery but not from
 * existence: its author and staff see it as normal, and everyone else reaches it only through a world
 * that requires it. Only a component may be unlisted.
 */
const PUBLIC = 'public';
const UNLISTED = 'unlisted';
const VISIBILITIES = [PUBLIC, UNLISTED];
const DEFAULT_VISIBILITY = PUBLIC;

const isValidVisibility = (visibility) => VISIBILITIES.includes(visibility);

/**
 * What a world author has said about a component offered for their world. `unreviewed` is the state an
 * association starts in and the one a world author has not answered. Only the world author writes it.
 */
const REVIEW_STATES = ['unreviewed', 'approved', 'declined'];
const DEFAULT_REVIEW_STATE = 'unreviewed';

const isValidReviewState = (state) => REVIEW_STATES.includes(state);

/**
 * How many listings one declaration may name. A ceiling against a body that names the whole catalog, not a
 * design limit: a world with a hundred required components is already something nobody downloads.
 */
const MAX_ASSOCIATIONS = 100;

module.exports = {
  COMPONENT_KINDS,
  isComponentKind,
  PUBLIC,
  UNLISTED,
  VISIBILITIES,
  DEFAULT_VISIBILITY,
  isValidVisibility,
  REVIEW_STATES,
  DEFAULT_REVIEW_STATE,
  isValidReviewState,
  MAX_ASSOCIATIONS
};
