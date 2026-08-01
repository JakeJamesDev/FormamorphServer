const AuditLog = require('../models/AuditLog');

/**
 * An entry as an admin reads it. Names are what was stored at the time, so a row about a deleted account
 * still names them.
 */
const toEntryDto = (row) => ({
  id: row.id,
  action: row.action,
  actor: {
    id: row.actor_id,
    username: row.actor_username,
    // Whether they were an admin *then* — an account demoted since did not act as an ordinary user.
    wasAdmin: Boolean(row.actor_was_admin),
    // What they were, which `wasAdmin` cannot say for a mod or a dev. Null on a row written before the
    // column existed, and on an ordinary account: an unknown role and no role read the same to a client.
    role: row.actor_role || null
  },
  targetUser: row.target_user_id || row.target_username
    ? { id: row.target_user_id, username: row.target_username }
    : null,
  target: row.target_kind || row.target_name
    ? { kind: row.target_kind, name: row.target_name }
    : null,
  snippet: row.snippet,
  createdAt: row.created_at
});

/**
 * @desc    Read the audit log
 * @route   GET /api/audit
 * @access  Private/Admin
 */
exports.getEntries = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    // An unknown action is ignored rather than rejected — it falls back to every entry, which is what an
    // unfiltered log already shows.
    const action = AuditLog.ACTIONS.includes(req.query.action) ? req.query.action : null;
    const search = req.query.search || '';

    const result = AuditLog.getAll({ page, limit, action, search });

    res.status(200).json({
      success: true,
      count: result.count,
      total: result.total,
      data: result.entries.map(toEntryDto)
    });
  } catch (error) {
    next(error);
  }
};

/** Exposed so the client's filter dropdown is filled from the server's own list. */
exports.getMeta = async (_req, res) => {
  res.status(200).json({ success: true, actions: AuditLog.ACTIONS });
};
