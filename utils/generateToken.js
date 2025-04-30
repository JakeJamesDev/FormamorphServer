const jwt = require('jsonwebtoken');

/**
 * Generate a JWT token for a user
 * @param {string} id - User ID to include in the token
 * @returns {string} JWT token
 */
const generateToken = (id) => {
  return jwt.sign(
    { id },
    process.env.JWT_SECRET || 'your_jwt_secret_key',
    {
      expiresIn: process.env.JWT_EXPIRE || '24h'
    }
  );
};

module.exports = generateToken;
