const { addColumns } = require('../columns');

/**
 * The column that says a Like came from a Claim.
 *
 * Null on a like given as an account, and the instant of the Claim on one moved off an Install. The
 * Like's own `created_at` is left at the instant the heart was first pressed, so what a Claim changes is
 * who the like belongs to and nothing about when it happened.
 *
 * The `install_claims` table it works with ships through the tables step, which creates a table an
 * existing database lacks. Only a column on a table that already exists needs a step of its own.
 */
const apply = (database) =>
  addColumns(database, 'world_likes', [['claimed_at', 'TEXT']]).length > 0;

module.exports = { name: 'likeClaims', apply };
