const { KINDS, DEFAULT_KIND, ALL_KINDS, isValidKindQuery } = require('../config/kinds');

/**
 * Read `?kind` off a list request.
 *
 * Shared by every endpoint that lists rows, so they can't drift apart — the whole compatibility promise
 * rests on all of them defaulting to worlds when no kind is named, and one that forgot would quietly hand
 * characters to a client that has never heard of them.
 *
 * Returns `{ kind }`, or `{ error }` when the value isn't one the API accepts.
 */
function kindFromQuery(req) {
  const kind = req.query.kind || DEFAULT_KIND;

  if (!isValidKindQuery(kind)) {
    return { error: `Invalid kind '${kind}' (allowed: ${[...KINDS, ALL_KINDS].join(', ')})` };
  }

  return { kind };
}

module.exports = { kindFromQuery };
