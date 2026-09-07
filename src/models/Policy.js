const db = require('../config/db');
const {
  UPLOAD_GATE,
  TAG_NOTICE,
  PRIVACY_POLICY,
  AGE_GATE,
  POLICY_IDS,
  ANSWERED_POLICY_IDS
} = require('../config/policies');

/**
 * Normalize a tag for storage and comparison.
 *
 * Matching is exact but case- and space-insensitive, so `Mature ` and `mature` are the same tag. Both
 * ends go through this: a stored tag that skipped it would never match anything a client sent.
 *
 * @param {string} tag - A raw tag
 * @returns {string} The comparable form
 */
const normalizeTag = (tag) => String(tag).trim().toLowerCase();

/**
 * Authored policies and the fixed adult-content warning.
 */
const Policy = {
  UPLOAD_GATE,
  TAG_NOTICE,
  PRIVACY_POLICY,
  AGE_GATE,
  POLICY_IDS,
  ANSWERED_POLICY_IDS,
  normalizeTag,

  /**
   * Read one policy.
   * @param {string} id - Policy ID
   * @returns {Object|undefined} The row, or undefined when no admin has authored it
   */
  findById: (id) => {
    const row = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);
    if (!row) return undefined;

    return { ...row, enabled: Boolean(row.enabled), tags: JSON.parse(row.tags || '[]') };
  },

  /**
   * Whether a policy exists, is switched on, and has something to show. An enabled policy with no text
   * is a wall with nothing written on it, so it is treated as inactive.
   *
   * @param {string} id - Policy ID
   * @returns {boolean} True if it should be shown and (for the gate) enforced
   */
  isActive: (id) => {
    const policy = Policy.findById(id);
    return Boolean(policy && policy.enabled && policy.title && policy.body);
  },

  /**
   * Create or replace a policy's authored content.
   *
   * @param {string} id - Policy ID
   * @param {Object} fields - `{ enabled, title, body, tags }`
   * @param {boolean} [requireReaccept] - Bump the acceptance version, so everyone must accept again
   * @returns {Object} The saved policy
   */
  save: (id, fields, requireReaccept = false) => {
    const existing = db.prepare('SELECT acceptance_version FROM policies WHERE id = ?').get(id);
    const version = (existing ? existing.acceptance_version : 1) + (requireReaccept ? 1 : 0);

    db.prepare(`
      INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
      VALUES (@id, @enabled, @title, @body, @tags, @version, @now)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        title = excluded.title,
        body = excluded.body,
        tags = excluded.tags,
        acceptance_version = excluded.acceptance_version,
        updated_at = excluded.updated_at
    `).run({
      id,
      enabled: fields.enabled ? 1 : 0,
      title: fields.title,
      body: fields.body,
      tags: JSON.stringify((fields.tags || []).map(normalizeTag).filter(Boolean)),
      version,
      now: new Date().toISOString()
    });

    return Policy.findById(id);
  },

  /**
   * Whether a user's acceptance is current.
   *
   * An acceptance records the version it was given against, so bumping the policy's version invalidates
   * every acceptance at once without touching a single acceptance row.
   *
   * @param {string} id - Policy ID
   * @param {string} userId - User ID
   * @returns {boolean} True if this user has accepted the current version
   */
  hasAccepted: (id, userId) => {
    const row = db.prepare(`
      SELECT a.accepted_version, a.response, p.acceptance_version
      FROM policy_acceptances a
      JOIN policies p ON p.id = a.policy_id
      WHERE a.policy_id = ? AND a.user_id = ?
    `).get(id, userId);

    return Boolean(row && row.response === 'accepted' && row.accepted_version === row.acceptance_version);
  },

  /** Read the current acceptance state and the server-recorded time for one account. */
  acceptanceState: (id, userId) => {
    const row = db.prepare(`
      SELECT p.acceptance_version, a.accepted_version, a.accepted_at, a.response
      FROM policies p
      LEFT JOIN policy_acceptances a ON a.policy_id = p.id AND a.user_id = ?
      WHERE p.id = ?
    `).get(userId, id);
    if (!row) return undefined;

    const accepted = row.response === 'accepted' && row.accepted_version === row.acceptance_version;
    return {
      accepted,
      requiredVersion: row.acceptance_version,
      acceptedAt: accepted ? row.accepted_at : null
    };
  },

  /**
   * How each of the given users last answered the policy. One query for a whole page of the admin table,
   * rather than `hasAccepted` per row.
   *
   * Only answers given against the current version count: bumping the version puts everyone back to
   * having said nothing, which is exactly what the gate will treat them as.
   *
   * @param {string} id - Policy ID
   * @param {Array<string>} userIds - User IDs to check
   * @returns {Map<string, string>} User ID → `'accepted'` or `'declined'`; absent means unanswered
   */
  responsesBy: (id, userIds) => {
    if (!userIds || userIds.length === 0) return new Map();

    const placeholders = userIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT a.user_id, a.response
      FROM policy_acceptances a
      JOIN policies p ON p.id = a.policy_id
      WHERE a.policy_id = ?
        AND a.accepted_version = p.acceptance_version
        AND a.user_id IN (${placeholders})
    `).all(id, ...userIds);

    return new Map(rows.map((row) => [row.user_id, row.response]));
  },

  /**
   * Record a user's answer to the policy as it stands right now. One row per user either way, so
   * declining and later accepting replaces the answer rather than stacking up.
   *
   * @param {string} id - Policy ID
   * @param {string} userId - User ID
   * @param {string} [response] - `'accepted'` (default) or `'declined'`
   */
  accept: (id, userId, response = 'accepted') => {
    const policy = db.prepare('SELECT acceptance_version FROM policies WHERE id = ?').get(id);
    if (!policy) return;

    db.prepare(`
      INSERT INTO policy_acceptances (policy_id, user_id, accepted_version, accepted_at, response)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(policy_id, user_id) DO UPDATE SET
        accepted_version = excluded.accepted_version,
        accepted_at = excluded.accepted_at,
        response = excluded.response
    `).run(id, userId, policy.acceptance_version, new Date().toISOString(), response);
  },

  /**
   * Ask one user to accept again by dropping their acceptance row.
   * @param {string} id - Policy ID
   * @param {string} userId - User ID
   */
  resetForUser: (id, userId) => {
    db.prepare('DELETE FROM policy_acceptances WHERE policy_id = ? AND user_id = ?').run(id, userId);
  },

  /**
   * Ask everyone to accept again. Bumps the version rather than deleting rows, so one write invalidates
   * every acceptance however many accounts exist.
   *
   * @param {string} id - Policy ID
   * @returns {Object|undefined} The updated policy
   */
  resetForEveryone: (id) => {
    db.prepare('UPDATE policies SET acceptance_version = acceptance_version + 1 WHERE id = ?').run(id);
    return Policy.findById(id);
  },

  /**
   * Which of a publish's tags the tag notice covers.
   * @param {Array<string>} tags - Tags on the item being published
   * @returns {Array<string>} The matched tags, normalized; empty when the notice is inactive
   */
  matchingTags: (tags) => {
    if (!Policy.isActive(TAG_NOTICE)) return [];

    const notice = Policy.findById(TAG_NOTICE);
    const listed = new Set(notice.tags);

    return [...new Set((tags || []).map(normalizeTag))].filter((tag) => listed.has(tag));
  }
};

module.exports = Policy;
