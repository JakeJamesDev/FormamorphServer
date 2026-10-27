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

const USERNAME_RULE = '3–20 letters, numbers, _ or -';

module.exports = { USERNAME_PATTERN, OUTSIDE_USERNAME_CHARS, USERNAME_MAX, USERNAME_RULE };
