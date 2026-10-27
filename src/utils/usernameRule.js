const User = require('../models/User');

// The feedback mention token's character set, so every name can be mentioned.
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

const USERNAME_RULE = '3–20 letters, numbers, _ or -';

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

module.exports = { checkUsername, USERNAME_RULE, USERNAME_TAKEN };
