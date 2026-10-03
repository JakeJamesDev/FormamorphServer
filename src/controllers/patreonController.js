const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PatreonLink = require('../models/PatreonLink');
const PatreonPendingLink = require('../models/PatreonPendingLink');
const { sameGeneration } = require('../middleware/auth');
const { SITE_URL } = require('../config/mail');
const { patreonConfigured, tierStateOf, LINK_STATE_TTL_MS, LINK_RESULTS } = require('../config/patreon');
const { authorizeUrl, identifyMember, listMembers } = require('../utils/patreon');

const STATE_PURPOSE = 'patreon-link';

/**
 * The key the link `state` is signed with.
 *
 * Derived from the session secret rather than equal to it, so a `state` read from a URL can never pass
 * as a session token, and a session token can never pass as a `state`.
 */
const stateKey = () => crypto.createHmac('sha256', process.env.JWT_SECRET).update(STATE_PURPOSE).digest();

/**
 * A signed, short-lived `state` bound to the account and its session generation.
 *
 * @param {Object} user - The signed-in account
 * @returns {string} The state
 */
const signState = (user) => jwt.sign(
  { id: user.id, tv: user.token_version || 0 },
  stateKey(),
  { expiresIn: Math.floor(LINK_STATE_TTL_MS / 1000) }
);

/**
 * The account a `state` was signed for, while it may still link.
 *
 * @param {*} state - The `state` query value
 * @returns {Object|null} The account, or null for a forged, expired, or retired state
 */
const accountFromState = (state) => {
  if (typeof state !== 'string' || !state) return null;

  let decoded;
  try {
    decoded = jwt.verify(state, stateKey());
  } catch {
    return null;
  }

  const user = User.findById(decoded.id);
  if (!user || user.status === 'suspended' || !sameGeneration(decoded, user)) return null;

  return user;
};

/**
 * The tier and pledge start the member list gives a Patreon user, or a failed read.
 *
 * @param {string} patreonUserId - The member
 * @returns {Promise<{ tier: string|null, pledgeStart: string|null, checkedAt: string|null }>} No tier
 *   and a null `checkedAt` when the read failed
 */
const readTier = async (patreonUserId) => {
  try {
    const member = (await listMembers()).find((entry) => entry.patreonUserId === patreonUserId);
    return { ...tierStateOf(member), checkedAt: new Date().toISOString() };
  } catch (error) {
    console.error('Patreon member list read failed at link time:', error);
    return { tier: null, pledgeStart: null, checkedAt: null };
  }
};

/** What the status route answers for a link row, or for none. */
const statusOf = (link) => (link
  ? { linked: true, tier: link.tier, since: link.pledge_start, showFlair: Boolean(link.show_flair) }
  : { linked: false });

/**
 * @desc    Start a Patreon link: Patreon's approval URL with a signed state
 * @route   POST /api/users/me/patreon/link
 * @access  Private
 */
exports.startPatreonLink = async (req, res, next) => {
  try {
    if (!patreonConfigured()) {
      return res.status(503).json({ success: false, error: 'Patreon linking is not set up on this server' });
    }

    res.status(200).json({ success: true, data: { url: authorizeUrl(signState(req.user)) } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Park a Patreon approval and send the browser to the site's account page with the result
 * @route   GET /api/patreon/callback
 * @access  Public; the signed state names the account
 */
exports.patreonCallback = async (req, res) => {
  const finish = (result, token) => res.redirect(
    302, `${SITE_URL}/account?${new URLSearchParams(token ? { patreon: result, token } : { patreon: result })}`
  );

  // A browser is waiting on this redirect, so every failure still answers one.
  try {
    const user = accountFromState(req.query.state);
    if (!user) return finish(LINK_RESULTS.EXPIRED);

    // Patreon returns no code when the member refuses.
    const { code } = req.query;
    if (typeof code !== 'string' || !code) return finish(LINK_RESULTS.DENIED);

    const patreonUserId = await identifyMember(code);
    if (PatreonLink.isHeldElsewhere(patreonUserId, user.id)) return finish(LINK_RESULTS.TAKEN);

    // Whoever approved may not own the account the state names, so the link waits for that account.
    return finish(LINK_RESULTS.CONFIRM, PatreonPendingLink.create({ userId: user.id, patreonUserId }));
  } catch (error) {
    console.error('Patreon callback failed:', error);
    return finish(LINK_RESULTS.FAILED);
  }
};

/**
 * @desc    Confirm a pending Patreon link with the token the callback gave the approving browser
 * @route   POST /api/users/me/patreon/confirm
 * @access  Private; only the account the pending link names
 */
exports.confirmPatreonLink = async (req, res, next) => {
  try {
    const pending = PatreonPendingLink.take(req.body?.token);

    if (!pending || pending.userId !== req.user.id) {
      return res.status(400).json({
        success: false, code: 'PATREON_CONFIRM_REFUSED', error: 'This Patreon link has expired. Start it again.'
      });
    }

    const { tier, pledgeStart, checkedAt } = await readTier(pending.patreonUserId);

    try {
      PatreonLink.link({ userId: req.user.id, patreonUserId: pending.patreonUserId, tier, pledgeStart, checkedAt });
    } catch (error) {
      if (!(error instanceof PatreonLink.PatreonUserTaken)) throw error;
      return res.status(409).json({
        success: false, code: 'PATREON_TAKEN', error: 'This Patreon account is linked to another Formamorph account.'
      });
    }

    res.status(200).json({ success: true, data: statusOf(PatreonLink.findByUser(req.user.id)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    The caller's own Patreon link
 * @route   GET /api/users/me/patreon
 * @access  Private
 */
exports.getPatreonStatus = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: statusOf(PatreonLink.findByUser(req.user.id)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Set the caller's Show Supporter Flair toggle
 * @route   PATCH /api/users/me/patreon
 * @access  Private; only a linked account
 */
exports.setPatreonFlair = async (req, res, next) => {
  try {
    const showFlair = req.body?.showFlair;
    if (typeof showFlair !== 'boolean') {
      return res.status(400).json({ success: false, error: 'showFlair must be true or false' });
    }

    if (!PatreonLink.setShowFlair(req.user.id, showFlair)) {
      return res.status(409).json({
        success: false, code: 'PATREON_NOT_LINKED', error: 'Link a Patreon account first.'
      });
    }

    res.status(200).json({ success: true, data: statusOf(PatreonLink.findByUser(req.user.id)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Remove the caller's Patreon link
 * @route   DELETE /api/users/me/patreon
 * @access  Private
 */
exports.unlinkPatreon = async (req, res, next) => {
  try {
    PatreonLink.unlink(req.user.id);
    res.status(200).json({ success: true, data: statusOf(null) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    The Supporters wall: linked supporters in display order
 * @route   GET /api/patreon/supporters
 * @access  Public
 */
exports.getSupporters = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: PatreonLink.wall() });
  } catch (error) {
    next(error);
  }
};
