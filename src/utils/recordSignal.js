const crypto = require('crypto');
const Signal = require('../models/Signal');
const { clientAddress } = require('./clientAddress');
const { browserFamily } = require('./browserFamily');

/**
 * The salted hash of a client address.
 *
 * SHA-256 over the salt and the address, hex-encoded. The salt is read at call time rather than captured at
 * load, so rotating it takes effect on the next restart without this module caring how it got there. The
 * server refuses to boot without one, so an unsalted hash cannot be written — see `server.js`.
 *
 * @param {string} address - The client address
 * @returns {string} The hex digest
 */
const addressHash = (address) =>
  crypto.createHash('sha256').update(`${process.env.SIGNAL_SALT}${address}`).digest('hex');

/**
 * Record a Signal for something an account just did.
 *
 * Called after the action has succeeded, and never fails it: the like, the comment or the account already
 * exists by the time this runs, so a write error here must not turn a completed action into a 500 the
 * caller retries. It fails loudly to the console so the gap is visible to whoever runs the server. Same
 * bargain the audit log's `tryRecord` makes, for the same reason.
 *
 * @param {Object} req - The Express request the action arrived on
 * @param {string} userId - The account that acted
 * @param {string} event - One of `Signal.EVENTS`
 * @returns {Object|null} The stored row, or null when it could not be written
 */
const recordSignal = (req, userId, event) => {
  try {
    return Signal.create({
      userId,
      event,
      addressHash: addressHash(clientAddress(req)),
      browserFamily: browserFamily(req.headers['user-agent'])
    });
  } catch (error) {
    console.error('Failed to record a signal:', event, error);
    return null;
  }
};

module.exports = { recordSignal, addressHash };
