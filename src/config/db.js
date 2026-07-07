const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database file path
const dbPath = path.join(dataDir, 'exotic-dangerous.db');

// Create and configure the database connection
const db = new Database(dbPath, { 
  verbose: process.env.NODE_ENV === 'development' ? console.log : null 
});

// Enable foreign keys
db.pragma('foreign_keys = ON');

module.exports = db;
