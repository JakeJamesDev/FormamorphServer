const { addColumns } = require('../columns');

/**
 * Give every account a session generation.
 *
 * A JWT is stateless: once signed it is good until it expires, so a token lifted from a compromised
 * machine survived a password change and a suspension. A token carries the version it was minted under,
 * `protect` compares it against the row, and bumping the row invalidates every token out there in one
 * write. Existing rows start at 0, which is also what a token minted before this claim existed is read
 * as, so nobody is logged out on the way in.
 */
const apply = (database) => addColumns(database, 'users', [
  ['token_version', 'INTEGER NOT NULL DEFAULT 0']
]).length > 0;

module.exports = { name: 'tokenVersion', apply };
