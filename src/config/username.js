/**
 * The username rule, apart from the check that applies it, so the schema step that flags old names can
 * read it without opening a model.
 */

// The feedback mention token's character set, so every name can be mentioned.
const USERNAME_CHARS = 'A-Za-z0-9_-';
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;

const USERNAME_PATTERN = new RegExp(`^[${USERNAME_CHARS}]{${USERNAME_MIN},${USERNAME_MAX}}$`);

/** Every character outside the set, for the rename suggestion to drop. */
const OUTSIDE_USERNAME_CHARS = new RegExp(`[^${USERNAME_CHARS}]`, 'g');

const USERNAME_RULE = `${USERNAME_MIN}–${USERNAME_MAX} letters, numbers, _ or -`;

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
  USERNAME_PATTERN,
  OUTSIDE_USERNAME_CHARS,
  USERNAME_MAX,
  USERNAME_RULE,
  USERNAME_RENAME_GATE,
  RENAME_REFUSAL,
  validateUsernameRenameGate
};
