const User = require('../models/User');
const HostedGrant = require('../models/HostedGrant');
const HostedUsage = require('../models/HostedUsage');
const { TIER_KEYS } = require('../config/hostedAi');
const { weekStart, resetAt } = require('../utils/hostedMeter');
const { breakdownOf } = require('../utils/hostedState');
const { buildUsageReport } = require('../utils/hostedUsageReport');
const { DAY_MS } = require('../config/time');

/** The staff and admin routes of Formamorph AI: grants, a subject's week and the spend report. */

const grantBody = (grant) => ({
  id: grant.id,
  userId: grant.user_id,
  username: grant.username,
  tier: grant.tier,
  endsAt: grant.ends_at,
  createdAt: grant.created_at,
  revokedAt: grant.revoked_at,
  subject: HostedGrant.subjectOf(grant.id)
});

const bad = (res, error) => res.status(400).json({ success: false, error });

/**
 * @desc    Grant a tier to an account until an end date
 * @route   POST /api/hosted-ai/admin/grants
 * @access  Private/Staff
 */
exports.createGrant = (req, res, next) => {
  try {
    const { userId, tier, endsAt } = req.body || {};
    if (typeof userId !== 'string' || !User.findById(userId)) return bad(res, 'userId must name an account');
    if (!TIER_KEYS.includes(tier)) return bad(res, `tier must be one of ${TIER_KEYS.join(', ')}`);
    const end = typeof endsAt === 'string' ? new Date(endsAt) : null;
    if (!end || Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) return bad(res, 'endsAt must be a future date');

    const grant = HostedGrant.create({ userId, tier, endsAt: end.toISOString(), createdBy: req.user.id });
    return res.status(201).json({ success: true, data: grantBody(grant) });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Every grant, newest first. Spend is admin-only and not listed here.
 * @route   GET /api/hosted-ai/admin/grants
 * @access  Private/Staff
 */
exports.listGrants = (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: HostedGrant.list().map(grantBody) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Revoke a grant now
 * @route   DELETE /api/hosted-ai/admin/grants/:id
 * @access  Private/Staff
 */
exports.revokeGrant = (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !HostedGrant.find(id)) return res.status(404).json({ success: false, error: 'No such grant' });

    const grant = HostedGrant.revoke(id);
    return res.status(200).json({ success: true, data: grantBody(grant) });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    A spend subject's calls, turns and cost this UTC week (Monday 00:00 to Monday 00:00)
 * @route   GET /api/hosted-ai/admin/spend/:subject
 * @access  Private/Admin
 */
exports.getSpend = (req, res, next) => {
  try {
    const now = new Date();
    const since = weekStart(now);

    res.status(200).json({
      success: true,
      data: {
        subject: req.params.subject,
        since,
        resetAt: resetAt(now),
        ...HostedUsage.summarySince(req.params.subject, since),
        breakdown: breakdownOf(req.params.subject, now, true)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Sums and call timings for the last N UTC days. Names no account.
 * @route   GET /api/hosted-ai/admin/usage-report?days=N
 * @access  Private/Admin
 */
exports.getUsageReport = (req, res, next) => {
  try {
    const days = req.query.days === undefined ? 14 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) return bad(res, 'days must be a whole number from 1 to 366');

    return res.status(200).json({ success: true, data: buildUsageReport(days) });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc    Recorded spend per UTC day, to compare with the provider's own figure
 * @route   GET /api/hosted-ai/admin/spend-report?days=N
 * @access  Private/Admin
 */
exports.getSpendReport = (req, res, next) => {
  try {
    const days = req.query.days === undefined ? 31 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) return bad(res, 'days must be a whole number from 1 to 366');

    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(today - (days - 1) * DAY_MS).toISOString();

    // Every day with either figure, so a day the provider billed and nothing recorded still shows.
    const byDay = new Map();
    for (const row of HostedUsage.daySums(since)) byDay.set(row.day, { ...row, providerMicros: null });
    for (const row of HostedUsage.providerDaysSince(since.slice(0, 10))) {
      byDay.set(row.day, { day: row.day, calls: 0, costMicros: 0, ...byDay.get(row.day), providerMicros: row.providerMicros });
    }

    res.status(200).json({
      success: true,
      data: { since, days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) }
    });
  } catch (error) {
    next(error);
  }
};
