const db = require('../config/db');

/**
 * Whole-service sums over the Formamorph AI usage rows, for the admin report.
 *
 * Every read counts every row since an instant, so its cost matches the day's spend and the provider's bill.
 */
const HostedUsageReport = {
  days: (since) => db.prepare(`
    SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS calls, COUNT(DISTINCT turn_id) AS turns,
      COUNT(DISTINCT subject) AS accounts, SUM(cost_micros) AS costMicros
    FROM hosted_usage WHERE started_at >= ? GROUP BY day ORDER BY day
  `).all(since),

  totals: (since) => db.prepare(`
    SELECT COUNT(*) AS calls, COUNT(DISTINCT turn_id) AS turns, COUNT(DISTINCT subject) AS accounts,
      COALESCE(SUM(cost_micros), 0) AS costMicros, COALESCE(SUM(status = 'error'), 0) AS failed,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens, COALESCE(SUM(cached_tokens), 0) AS cachedTokens
    FROM hosted_usage WHERE started_at >= ?
  `).get(since),

  promptTypes: (since) => db.prepare(`
    SELECT prompt_type AS promptType, COUNT(*) AS calls, SUM(cost_micros) AS costMicros,
      AVG(prompt_tokens) AS avgPromptTokens, AVG(output_tokens) AS avgOutputTokens,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens, COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
      COALESCE(SUM(status = 'error'), 0) AS failed
    FROM hosted_usage WHERE started_at >= ? GROUP BY prompt_type ORDER BY costMicros DESC
  `).all(since),

  /** Every stream that produced output: the rows the speed figures come from. */
  timings: (since) => db.prepare(`
    SELECT prompt_type AS promptType, first_token_ms AS firstTokenMs, max_gap_ms AS maxGapMs,
      output_tokens AS outputTokens, duration_ms AS durationMs
    FROM hosted_usage WHERE started_at >= ? AND first_token_ms IS NOT NULL
  `).all(since),

  endings: (since) => db.prepare(`
    SELECT status, COUNT(*) AS calls FROM hosted_usage WHERE started_at >= ? GROUP BY status ORDER BY calls DESC
  `).all(since),

  failures: (since) => db.prepare(`
    SELECT failure, COUNT(*) AS calls FROM hosted_usage
    WHERE started_at >= ? AND failure IS NOT NULL GROUP BY failure ORDER BY calls DESC
  `).all(since),

  tiers: (since) => db.prepare(`
    SELECT tier, COUNT(DISTINCT subject) AS active, COUNT(DISTINCT turn_id) AS turns, SUM(cost_micros) AS costMicros
    FROM hosted_usage WHERE started_at >= ? GROUP BY tier
  `).all(since),

  /** One row per spend subject, costliest first. The caller keeps `subject` out of its reply. */
  subjects: (since) => db.prepare(`
    SELECT subject, tier, COUNT(DISTINCT turn_id) AS turns, SUM(cost_micros) AS costMicros
    FROM hosted_usage WHERE started_at >= ? GROUP BY subject ORDER BY costMicros DESC, subject
  `).all(since),

  /** What each subject spent against its allowance since an instant, stopped attempts left out. */
  allowanceSpend: (since) => db.prepare(`
    SELECT subject, tier, SUM(cost_micros) AS costMicros
    FROM hosted_usage WHERE started_at >= ? AND stopped = 0 GROUP BY subject
  `).all(since),

  slowest: (since, limit) => db.prepare(`
    SELECT started_at AS startedAt, prompt_type AS promptType, first_token_ms AS firstTokenMs, max_gap_ms AS maxGapMs,
      output_tokens AS outputTokens, duration_ms AS durationMs, status, failure
    FROM hosted_usage WHERE started_at >= ? AND (first_token_ms IS NOT NULL OR max_gap_ms IS NOT NULL)
    ORDER BY MAX(COALESCE(first_token_ms, 0), COALESCE(max_gap_ms, 0)) DESC, id DESC LIMIT ?
  `).all(since, limit),

  /**
   * Reservation against settled cost per prompt type. Only rows the provider priced and that kept their reply,
   * since a swept or estimated cost is the reservation itself.
   */
  reservations: (since) => db.prepare(`
    SELECT prompt_type AS promptType, COUNT(*) AS calls, SUM(reserve_micros) AS reserveMicros, SUM(cost_micros) AS costMicros
    FROM hosted_usage
    WHERE started_at >= ? AND status = 'ok' AND cost_source = 'upstream' AND stopped = 0 AND reserve_micros IS NOT NULL
    GROUP BY prompt_type ORDER BY reserveMicros DESC
  `).all(since),

  clients: (since) => db.prepare(`
    SELECT client_version AS clientVersion, COUNT(*) AS calls, COUNT(DISTINCT turn_id) AS turns, SUM(cost_micros) AS costMicros
    FROM hosted_usage WHERE started_at >= ? GROUP BY client_version ORDER BY calls DESC
  `).all(since),

  /**
   * Closed turns with no narration call, under the version of each turn's first row. A turn is judged on all
   * its rows and counts only when its first row is in range, so the range edge never changes the verdict.
   */
  turnsWithoutNarration: (since) => db.prepare(`
    WITH turns AS (
      SELECT MIN(id) AS firstId FROM hosted_usage GROUP BY subject, turn_id
      HAVING SUM(status = 'open') = 0 AND SUM(prompt_type IS 'narration') = 0
    )
    SELECT first.client_version AS clientVersion, COUNT(*) AS turns
    FROM turns JOIN hosted_usage AS first ON first.id = turns.firstId
    WHERE first.started_at >= ? GROUP BY first.client_version
  `).all(since),

  /** Accounts holding a Patreon tier or a live grant, for the entitlement count. */
  entitledCandidates: (now) => db.prepare(`
    SELECT user_id AS userId FROM patreon_links WHERE tier IS NOT NULL
    UNION SELECT user_id FROM hosted_grants WHERE revoked_at IS NULL AND ends_at > ?
  `).all(now).map((row) => row.userId)
};

module.exports = HostedUsageReport;
