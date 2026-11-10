const db = require('../config/db');

/** The `storage_days` table: what the hourly storage check measured, one row per name per UTC day. */
const StorageDay = {
  /**
   * Replace the rows of `day` for the given names. A name not listed keeps its row.
   *
   * @param {string} day - A UTC `YYYY-MM-DD`
   * @param {{ name: string, bytes: number, files: (number|null) }[]} rows - What the run measured
   * @param {string} measuredAt - ISO time of the run
   */
  replace: (day, rows, measuredAt) => {
    const write = db.prepare(`
      INSERT INTO storage_days (day, name, bytes, files, measured_at)
      VALUES (@day, @name, @bytes, @files, @measuredAt)
      ON CONFLICT(day, name) DO UPDATE SET bytes = excluded.bytes, files = excluded.files, measured_at = excluded.measured_at
    `);

    db.transaction(() => {
      for (const row of rows) write.run({ day, name: row.name, bytes: row.bytes, files: row.files, measuredAt });
    })();
  },

  /**
   * Every row from `firstDay` on.
   *
   * @param {string} firstDay - A UTC `YYYY-MM-DD`
   * @returns {{ day: string, name: string, bytes: number, files: (number|null) }[]} The rows
   */
  since: (firstDay) => db.prepare('SELECT day, name, bytes, files FROM storage_days WHERE day >= ?').all(firstDay),

  /**
   * The newest row of each name, from any day.
   *
   * @returns {Map<string, { bytes: number, files: (number|null), measuredAt: string }>} By name
   */
  latestByName: () => {
    const rows = db.prepare(`
      SELECT name, bytes, files, measured_at AS measuredAt
      FROM storage_days AS row
      WHERE day = (SELECT MAX(day) FROM storage_days WHERE name = row.name)
    `).all();

    return new Map(rows.map(({ name, ...rest }) => [name, rest]));
  }
};

module.exports = StorageDay;
