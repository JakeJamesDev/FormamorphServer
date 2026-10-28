const { KINDS, DEFAULT_KIND, ALL_KINDS, isValidKindQuery } = require('../config/kinds');

/**
 * Read `?kind` off a list request.
 *
 * Shared by every endpoint that lists rows, so they can't drift apart — the whole compatibility promise
 * rests on all of them defaulting to worlds when no kind is named, and one that forgot would quietly hand
 * characters to a client that has never heard of them.
 *
 * Returns `{ kind }`, where a comma list of kinds reads as an array, or `{ error }` when the value isn't one
 * the API accepts.
 */
function kindFromQuery(req) {
  const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : DEFAULT_KIND;

  if (kind.includes(',')) {
    const kinds = [...new Set(kind.split(','))];
    const unknown = kinds.find((each) => !KINDS.includes(each));
    if (unknown !== undefined) return { error: `Invalid kind '${unknown}' (allowed: ${KINDS.join(', ')})` };
    return { kind: kinds };
  }

  if (!isValidKindQuery(kind)) {
    return { error: `Invalid kind '${kind}' (allowed: ${[...KINDS, ALL_KINDS].join(', ')})` };
  }

  return { kind };
}

module.exports = { kindFromQuery };
