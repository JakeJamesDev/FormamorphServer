const db = require('../config/db');
const { isSetting, defaultFor } = require('../config/settings');

/**
 * The settings table: one JSON value per declared key.
 *
 * A key nobody has written has no row, and reads as its declared default. That is what makes a setting
 * empty by default without a seeded row to keep in step with the code.
 */
const Setting = {
  /**
   * Read a setting.
   *
   * An undeclared key reads as undefined. Everything else that can go wrong — a row that will not parse,
   * a table a failed migration never created — reads as the default, because a setting that decides who
   * may reach a route must fail toward letting everyone through. `server.js` deliberately starts after a
   * failed migration so an operator has a running server to diagnose from, and this is read on every
   * request: throwing here would turn that into a total outage.
   *
   * @param {string} key - A declared setting
   * @returns {*} Its value, or undefined for a key this server does not have
   */
  get: (key) => {
    if (!isSetting(key)) return undefined;

    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);

      return row ? JSON.parse(row.value) : defaultFor(key);
    } catch {
      return defaultFor(key);
    }
  },

  /**
   * Write a setting. The caller validates first — `config/settings` says how.
   *
   * @param {string} key - A declared setting
   * @param {*} value - Anything JSON can hold
   * @returns {*} The value as stored
   */
  set: (key, value) => {
    if (!isSetting(key)) throw new Error(`No such setting: ${key}`);

    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, @value, @now)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run({ key, value: JSON.stringify(value), now: new Date().toISOString() });

    return Setting.get(key);
  },

  /**
   * When a setting was last written, or null while it is still the default.
   *
   * @param {string} key - A declared setting
   * @returns {string|null} An ISO stamp, or null
   */
  updatedAt: (key) => {
    if (!isSetting(key)) return null;

    const row = db.prepare('SELECT updated_at FROM settings WHERE key = ?').get(key);

    return row ? row.updated_at : null;
  }
};

module.exports = Setting;
