const { avatarUrlFor } = require('./avatarUrl');
const { badgeRole } = require('../config/roles');
const PatreonLink = require('../models/PatreonLink');

/**
 * The Supporter Flair an author shows: `{ tier, since }`, or null.
 *
 * The membership is read live, so a lapsed or hidden supporter loses it on old records too. A name never
 * carries a staff badge and a Supporter badge together, so the payload's own role decides: a feedback
 * snapshot there, the live role everywhere else.
 *
 * @param {string} id - The account id
 * @param {string|null} badge - The role the payload badges
 * @returns {{ tier: string, since: string|null }|null}
 */
const supporterOf = (id, badge) => {
  if (badge) return null;

  const link = PatreonLink.flairOf(id);
  if (!link || !link.tier || !link.show_flair) return null;

  return { tier: link.tier, since: link.pledge_start };
};

/**
 * The author object every payload carries: `{ id, username, avatarUrl, role, supporter }`.
 *
 * One builder so a field added to an author lands on every surface at once. `role` is whatever the caller
 * resolved: the live account type, or a snapshot with the live type as the fallback. `normal` and absent
 * both become null.
 *
 * @param {Object} fields
 * @param {string} fields.id - The account id
 * @param {string|null} fields.username - The account name
 * @param {string|null|undefined} fields.avatarFile - The `avatar_file` column
 * @param {string|null|undefined} fields.role - The account type to badge
 * @returns {{ id: string, username: string|null, avatarUrl: string|null, role: string|null, supporter: Object|null }}
 */
const authorPayload = ({ id, username, avatarFile, role }) => {
  const badge = badgeRole(role);

  return {
    id,
    username,
    avatarUrl: avatarUrlFor(avatarFile),
    role: badge,
    supporter: supporterOf(id, badge)
  };
};

module.exports = { authorPayload };
