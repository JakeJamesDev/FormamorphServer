const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./paths');

// Only `init-db` may create a database. Anywhere else a missing file means a wrong path, and opening it
// would serve or write to an empty database in place of the real one.
const mayCreate = DB_PATH === ':memory:' || Boolean(process.env.DB_ALLOW_CREATE);

if (!mayCreate && !fs.existsSync(DB_PATH)) {
  throw new Error(`No database at ${DB_PATH}. Load .env, or run \`npm run init-db\` to create one.`);
}
if (mayCreate && DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH, {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null
});

db.pragma('foreign_keys = ON');

module.exports = db;
