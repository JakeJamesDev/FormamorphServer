/**
 * The username rule, apart from the check that applies it, so the schema step that flags old names can
 * read it without opening a model.
 */

// The feedback mention token's character set, so every name can be mentioned.
const USERNAME_CHARS = 'A-Za-z0-9_-';
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;

/** The rule before spaces: the `usernameRename` step and the re-flag pass read "passed the old rule" from it. */
const OLD_USERNAME_PATTERN = new RegExp(`^[${USERNAME_CHARS}]{${USERNAME_MIN},${USERNAME_MAX}}$`);

/** Words of the set joined by single spaces. Length is checked apart, on the collapsed name. */
const USERNAME_SHAPE = new RegExp(`^[${USERNAME_CHARS}]+(?: [${USERNAME_CHARS}]+)*$`);

/** Every character outside the set and the space, for the rename suggestion to drop. */
const OUTSIDE_USERNAME_CHARS = new RegExp(`[^ ${USERNAME_CHARS}]`, 'g');

const USERNAME_RULE = `${USERNAME_MIN}–${USERNAME_MAX} letters, numbers, spaces, _ or -`;

/**
 * Trims the ends and collapses each run of U+0020 into one. Other whitespace inside stays, so it fails the shape.
 *
 * @param {string} name - The typed name
 * @returns {string} The collapsed name
 */
const collapseUsername = (name) => name.trim().replace(/ {2,}/g, ' ');

/**
 * Whether a collapsed name passes the rule.
 *
 * @param {string} collapsed - A `collapseUsername` result
 * @returns {boolean}
 */
const isValidUsername = (collapsed) => collapsed.length >= USERNAME_MIN
  && collapsed.length <= USERNAME_MAX
  && USERNAME_SHAPE.test(collapsed);

/**
 * The SQL fold every name lookup compares: ASCII lowercase (SQLite's `lower` without ICU), a space as `_`.
 * The `username_key` column and each lookup's argument use this one expression.
 *
 * @param {string} expression - A SQL expression holding a name
 * @returns {string} The folded expression
 */
const foldedUsernameSql = (expression) => `replace(lower(${expression}), ' ', '_')`;

/**
 * The setting that turns the rename gate on. Ships off: the operator enables it after the client release
 * that answers the refusal. Admin-only, so one mod cannot switch it.
 */
const USERNAME_RENAME_GATE = 'username_rename_gate';

/** The 403 body for a flagged account's write while the gate is on. */
const RENAME_REFUSAL = Object.freeze({
  success: false,
  code: 'USERNAME_RENAME_REQUIRED',
  error: 'Update Formamorph to choose a new username.'
});

/**
 * Whether a value is one the gate setting can hold.
 *
 * @param {*} value - The body's `value`
 * @returns {string|null} Why it was refused, or null when it is fine
 */
const validateUsernameRenameGate = (value) => (typeof value === 'boolean' ? null : 'Must be true or false');

module.exports = {
  OLD_USERNAME_PATTERN,
  collapseUsername,
  isValidUsername,
  OUTSIDE_USERNAME_CHARS,
  USERNAME_MAX,
  USERNAME_RULE,
  foldedUsernameSql,
  USERNAME_RENAME_GATE,
  RENAME_REFUSAL,
  validateUsernameRenameGate
};
