const Database = require('better-sqlite3');
const fs = require('fs');
const { DATA_DIR, DB_PATH } = require('./paths');

// Ensure the data directory exists. An in-memory database has no directory to create.
if (DB_PATH !== ':memory:' && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create and configure the database connection
const db = new Database(DB_PATH, {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null
});

// Enable foreign keys
db.pragma('foreign_keys = ON');

module.exports = db;
