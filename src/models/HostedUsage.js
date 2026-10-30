const db = require('../config/db');

/**
 * Formamorph AI usage rows. `schema/tables` says what a row holds.
 *
 * Sums include `open` rows, whose cost is the call's worst-case reservation until it settles.
 */
const HostedUsage = {
  /**
   * A spend subject's cost since an instant, open rows included.
   *
   * @param {string} subject - The spend subject
   * @param {string} since - ISO instant
   * @returns {number} Micro-dollars
   */
  spendSince: (subject, since) => db
    .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS total FROM hosted_usage WHERE subject = ? AND started_at >= ?')
    .get(subject, since).total,

  /**
   * One of the subject's turns, or null when the subject has no such turn.
   *
   * @param {string} subject - The spend subject
   * @param {string} turnId - The turn
   * @returns {{ calls: number, first: string }|null} Its call count and its first call's start
   */
  turn: (subject, turnId) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS calls, MIN(started_at) AS first FROM hosted_usage WHERE subject = ? AND turn_id = ?
    `).get(subject, turnId);

    return row.calls > 0 ? row : null;
  },

  /**
   * Record an admitted call as `open` with its reservation.
   *
   * @param {Object} row - `{ subject, userId, turnId, tier, estimatedPromptTokens, costMicros, startedAt }`
   * @returns {number} The row id
   */
  open: (row) => Number(db.prepare(`
    INSERT INTO hosted_usage
      (subject, user_id, turn_id, tier, estimated_prompt_tokens, cost_micros, started_at, status)
    VALUES (@subject, @userId, @turnId, @tier, @estimatedPromptTokens, @costMicros, @startedAt, 'open')
  `).run(row).lastInsertRowid),

  /**
   * Settle an open row. A row the sweep settled first stays as the sweep left it.
   *
   * @param {number} id - The row
   * @param {Object} result - `{ status, costSource, costMicros, promptTokens, cachedTokens, outputTokens, durationMs }`
   */
  settle: (id, result) => {
    db.prepare(`
      UPDATE hosted_usage
      SET status = @status, cost_source = @costSource, cost_micros = @costMicros, prompt_tokens = @promptTokens,
        cached_tokens = @cachedTokens, output_tokens = @outputTokens, duration_ms = @durationMs
      WHERE id = @id AND status = 'open'
    `).run({ id, ...result });
  },

  /**
   * Settle every row still open that started before an instant, at its reservation.
   *
   * @param {string} before - ISO instant
   * @returns {number} Rows settled
   */
  sweepOpen: (before) => db.prepare(`
    UPDATE hosted_usage SET status = 'swept', cost_source = 'estimated'
    WHERE status = 'open' AND started_at < ?
  `).run(before).changes,

  /**
   * Delete rows that started before an instant.
   *
   * @param {string} before - ISO instant
   * @returns {number} Rows deleted
   */
  deleteBefore: (before) => db.prepare('DELETE FROM hosted_usage WHERE started_at < ?').run(before).changes,

  /**
   * Detach an erased account from its rows, which stay with their subject.
   *
   * @param {string} userId - The account being erased
   */
  forgetUser: (userId) => {
    db.prepare('UPDATE hosted_usage SET user_id = NULL WHERE user_id = ?').run(userId);
  }
};

module.exports = HostedUsage;
