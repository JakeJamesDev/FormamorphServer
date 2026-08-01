/**
 * Who is allowed to do what.
 *
 * One module rather than `account_type === 'admin'` scattered across eleven files: the checks were
 * identical everywhere, so widening them to a team meant finding all of them, and the next widening
 * would mean finding them again.
 */

/** Every account type, weakest first. Not a rank — `dev` and `mod` are peers with different names. */
const ROLES = ['normal', 'mod', 'dev', 'admin'];

/** The roles that carry moderation powers. */
const STAFF_ROLES = ['mod', 'dev', 'admin'];

/**
 * What an administrator may set somebody to.
 *
 * `admin` is deliberately absent: an admin is made by hand on the server and nowhere else, so no
 * compromised account can promote its way to the top of the tree.
 */
const ASSIGNABLE_ROLES = ['normal', 'mod', 'dev'];

/** The role of a user row, defaulting to `normal` for a row that somehow has none. */
const roleOf = (user) => (user && user.account_type) || 'normal';

/** Whether this account carries moderation powers of any kind. */
const isStaff = (user) => STAFF_ROLES.includes(roleOf(user));

/** Whether this account is an administrator specifically. */
const isAdmin = (user) => roleOf(user) === 'admin';

/**
 * Whether `actor` may act on `target` as a moderator.
 *
 * The rule in one line: staff moderate the room, not each other. A dev or a mod reaches ordinary
 * accounts only; an admin also reaches dev and mod; nobody reaches an admin. Without this, one
 * compromised moderator account could suspend the entire team before anybody noticed.
 *
 * Your own things are always yours — an admin clearing their own avatar is not moderating an admin.
 *
 * @param {Object} actor - The signed-in user
 * @param {Object|null} [target] - The account being acted on, or null when the action has no owner
 * @returns {boolean} Whether the action is allowed
 */
const canModerate = (actor, target = null) => {
  if (!isStaff(actor)) return false;
  if (!target) return true;
  if (actor.id === target.id) return true;
  if (!isStaff(target)) return true;

  return isAdmin(actor) && !isAdmin(target);
};

/**
 * The role to badge somebody with, or null for an ordinary account.
 *
 * `normal` becomes null so a caller checking for a badge does not have to know the word, and so an
 * absent role and an ordinary one are indistinguishable to a client — which is what they should be.
 *
 * @param {string|null|undefined} role - An account type
 * @returns {string|null} The staff role, or null
 */
const badgeRole = (role) => (role && role !== 'normal' ? role : null);

/** What a refusal by `canModerate` says. One wording, so a probe cannot tell the cases apart. */
const STAFF_PROTECTED = 'You cannot moderate another staff account';

module.exports = {
  ROLES,
  STAFF_ROLES,
  ASSIGNABLE_ROLES,
  STAFF_PROTECTED,
  roleOf,
  badgeRole,
  isStaff,
  isAdmin,
  canModerate,
};
