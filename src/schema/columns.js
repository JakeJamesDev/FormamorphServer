/**
 * Add the columns a table is missing.
 *
 * The shape of nearly every step: `CREATE TABLE IF NOT EXISTS` never touches a table that already exists,
 * so a column added after its table shipped has to be put there by hand. The table is checked by name,
 * because `PRAGMA table_info` on a missing table returns an empty list rather than throwing. That reads
 * like "table exists, column missing" and would run ALTER TABLE against nothing.
 *
 * @param {Object} database - The connection to migrate
 * @param {string} table - The table to extend
 * @param {Array<[string, string]>} columns - Each column's name and its type clause
 * @returns {string[]} The names of the columns added; empty when nothing was
 */
const addColumns = (database, table, columns) => {
  if (!tableExists(database, table)) return [];

  const existing = new Set(columnNames(database, table));
  const missing = columns.filter(([name]) => !existing.has(name));

  // One ALTER per column; SQLite takes them one at a time. NOT NULL is safe alongside a DEFAULT, which it
  // backfills existing rows with as the column is added.
  for (const [name, type] of missing) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  return missing.map(([name]) => name);
};

const tableExists = (database, table) => Boolean(
  database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table)
);

const columnNames = (database, table) => database
  .prepare(`PRAGMA table_info(${table})`)
  .all()
  .map((column) => column.name);

module.exports = { addColumns, tableExists, columnNames };
