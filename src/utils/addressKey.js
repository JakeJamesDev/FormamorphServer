const crypto = require('crypto');

/**
 * The name a staff member presses a removal button with, for one address on one listing.
 *
 * The audit groups Anonymous Likes by the address they came from, and staff need to say "that one" when
 * they remove a group. The stored hash would say it, and the stored hash is the one thing that must not
 * leave: no staff response carries one today, and a salted hash handed out per listing would let anybody
 * holding two screens tell that the same address was behind both.
 *
 * So the key is a digest of the hash and the listing together. It names an address inside one listing and
 * nothing outside it, the same address on another listing gets a different key, and it cannot be turned
 * back into the hash. Nothing is stored: the removal route digests the listing's own hashes again and
 * takes the one that matches.
 *
 * @param {string} worldId - The listing the key is read on
 * @param {string} addressHash - The stored hash, empty once the retention sweep has taken it
 * @returns {string|null} The hex digest, or null when there is no address left to name
 */
const addressKeyFor = (worldId, addressHash) => (addressHash
  ? crypto.createHash('sha256').update(`${worldId}:${addressHash}`).digest('hex')
  : null);

module.exports = { addressKeyFor };
