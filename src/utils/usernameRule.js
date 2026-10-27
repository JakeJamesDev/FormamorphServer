const User = require('../models/User');
const { USERNAME_PATTERN, OUTSIDE_USERNAME_CHARS, USERNAME_MAX, USERNAME_RULE } = require('../config/username');

const USERNAME_TAKEN = { code: 'USERNAME_TAKEN', error: 'Username already exists' };

/**
 * The one username rule, for registration and for the rename route.
 *
 * Trims first, then checks the pattern, then checks every account (flagged ones too) for the same name
 * ignoring case. The unique constraint still backstops a race, but it compares byte for byte.
 *
 * @param {*} name - The typed name
 * @param {Object} [options]
 * @param {string} [options.exceptUserId] - An account allowed to already hold the name (a rename)
 * @returns {{ok: true, name: string} | {ok: false, code: string, error: string}}
 */
const checkUsername = (name, { exceptUserId } = {}) => {
  const trimmed = typeof name === 'string' ? name.trim() : '';

  if (!USERNAME_PATTERN.test(trimmed)) {
    return { ok: false, code: 'USERNAME_INVALID', error: USERNAME_RULE };
  }

  const holders = User.findAllByUsernameFolded(trimmed).filter((row) => row.id !== exceptUserId);
  if (holders.length) {
    return { ok: false, ...USERNAME_TAKEN };
  }

  return { ok: true, name: trimmed };
};

/**
 * The name a flagged account's rename field starts with, or null when the cleaned name would be refused.
 *
 * @param {Object} user - A users row with `id` and `username`
 * @returns {string|null}
 */
const renameSuggestion = (user) => {
  const cleaned = user.username
    .trim()
    .replace(/\s+/g, '_')
    .replace(OUTSIDE_USERNAME_CHARS, '')
    .slice(0, USERNAME_MAX);
  const verdict = checkUsername(cleaned, { exceptUserId: user.id });

  return verdict.ok ? verdict.name : null;
};

/**
 * The account payload's rename state.
 *
 * @param {Object} user - A users row with `username_rename_required`
 * @returns {{required: true, suggestion: string|null} | null}
 */
const usernameRename = (user) => (user.username_rename_required
  ? { required: true, suggestion: renameSuggestion(user) }
  : null);

module.exports = { checkUsername, usernameRename, USERNAME_RULE, USERNAME_TAKEN };
