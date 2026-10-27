const User = require('../models/User');
const {
  collapseUsername, isValidUsername, OUTSIDE_USERNAME_CHARS, USERNAME_MAX, USERNAME_RULE
} = require('../config/username');

const USERNAME_TAKEN = { code: 'USERNAME_TAKEN', error: 'Username already exists' };

/**
 * The one username rule, for registration and for the rename route.
 *
 * Trims and collapses space runs first, then checks the shape and length, then checks every account
 * (flagged ones too) for the same folded key. The unique constraint still backstops a race, but it compares byte for byte.
 *
 * @param {*} name - The typed name
 * @param {Object} [options]
 * @param {string} [options.exceptUserId] - An account allowed to already hold the name (a rename)
 * @returns {{ok: true, name: string} | {ok: false, code: string, error: string}}
 */
const checkUsername = (name, { exceptUserId } = {}) => {
  const collapsed = typeof name === 'string' ? collapseUsername(name) : '';

  if (!isValidUsername(collapsed)) {
    return { ok: false, code: 'USERNAME_INVALID', error: USERNAME_RULE };
  }

  const holders = User.findAllByUsernameFolded(collapsed).filter((row) => row.id !== exceptUserId);
  if (holders.length) {
    return { ok: false, ...USERNAME_TAKEN };
  }

  return { ok: true, name: collapsed };
};

/**
 * The name a flagged account's rename field starts with, or null when the cleaned name would be refused.
 *
 * @param {Object} user - A users row with `id` and `username`
 * @returns {string|null}
 */
const renameSuggestion = (user) => {
  const cleaned = collapseUsername(user.username.replace(OUTSIDE_USERNAME_CHARS, ''))
    .slice(0, USERNAME_MAX)
    .trim();
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

/**
 * The 400 body for a refused name.
 *
 * @param {{ok: false, code: string, error: string}} verdict - A failed `checkUsername` result
 * @returns {{success: false, code: string, error: string}}
 */
const usernameRefusal = ({ code, error }) => ({ success: false, code, error });

module.exports = { checkUsername, usernameRename, usernameRefusal, USERNAME_TAKEN };
