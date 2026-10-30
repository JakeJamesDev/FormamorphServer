const db = require('../config/db');

/**
 * The provider's own spend for the server key, one row per UTC day, beside the day's recorded usage sum.
 */
const HostedProviderSpend = {
  /**
   * Store one day, replacing an earlier reading of it.
   *
   * @param {Object} row - `{ day, providerMicros, recordedMicros, readAt }`; `day` is 'YYYY-MM-DD', UTC
   */
  record: (row) => {
    db.prepare(`
      INSERT INTO hosted_provider_spend (day, provider_micros, recorded_micros, read_at)
      VALUES (@day, @providerMicros, @recordedMicros, @readAt)
      ON CONFLICT(day) DO UPDATE SET provider_micros = excluded.provider_micros,
        recorded_micros = excluded.recorded_micros, read_at = excluded.read_at
    `).run(row);
  },

  /**
   * Stored days in a range, oldest first.
   *
   * @param {string} fromDay - 'YYYY-MM-DD', inclusive
   * @param {string} toDay - 'YYYY-MM-DD', inclusive
   * @returns {Array<{ day: string, provider_micros: number, recorded_micros: number, read_at: string }>}
   */
  between: (fromDay, toDay) => db
    .prepare('SELECT * FROM hosted_provider_spend WHERE day >= ? AND day <= ? ORDER BY day')
    .all(fromDay, toDay),

  /** The newest stored day, or null. */
  lastDay: () => db.prepare('SELECT MAX(day) AS day FROM hosted_provider_spend').get().day || null
};

module.exports = HostedProviderSpend;
