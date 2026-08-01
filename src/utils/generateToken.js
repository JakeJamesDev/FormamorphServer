const jwt = require('jsonwebtoken');

/**
 * Mint a session token for a user.
 *
 * The `tv` claim is the account's session generation at the moment of signing. `protect` compares it
 * against the row on every request, so bumping `token_version` retires every token already issued —
 * the only way to end a session that a stateless JWT otherwise leaves running until it expires.
 *
 * @param {Object|string} user - The user row, or a bare id for a caller that has nothing else
 * @returns {string} The JWT token
 */
const generateToken = (user) => {
  const id = typeof user === 'string' ? user : user.id;
  // A bare id signs at generation 0, which is what an un-bumped account is — and what a token predating
  // the claim is read as.
  const tokenVersion = typeof user === 'string' ? 0 : (user.token_version || 0);

  return jwt.sign(
    { id, tv: tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '24h' }
  );
};

module.exports = generateToken;
