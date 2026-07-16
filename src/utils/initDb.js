require('dotenv').config();
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Create tables
const createTables = () => {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      status TEXT DEFAULT 'normal',
      account_type TEXT DEFAULT 'normal',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Worlds table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      author_id TEXT NOT NULL,
      thumbnail_file TEXT NOT NULL,
      preview_data TEXT NOT NULL,
      content_file TEXT NOT NULL,
      downloads INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      tags TEXT,
      spoiler INTEGER DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'world',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users (id)
    )
  `);

  // Comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      world_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users (id)
    )
  `);

  console.log('Database tables created successfully');
};

// Create admin user
const createAdminUser = async () => {
  try {
    // Check if admin user already exists
    const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
    
    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', salt);
    
    // Generate UUID for user ID
    const userId = uuidv4();

    // Insert admin user
    db.prepare(`
      INSERT INTO users (id, username, password, email, account_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      process.env.ADMIN_USERNAME || 'admin',
      hashedPassword,
      process.env.ADMIN_EMAIL || 'admin@example.com',
      'admin'
    );

    console.log('Admin user created successfully');
  } catch (error) {
    console.error('Error creating admin user:', error);
  }
};

// Create indexes for search functionality
const createIndexes = () => {
  // Create indexes for worlds table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worlds_name ON worlds(name);
    CREATE INDEX IF NOT EXISTS idx_worlds_author ON worlds(author_id);
    CREATE INDEX IF NOT EXISTS idx_worlds_tags ON worlds(tags);
    CREATE INDEX IF NOT EXISTS idx_worlds_kind ON worlds(kind);
  `);

  // Create indexes for comments table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_world ON comments(world_id);
    CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
  `);

  console.log('Database indexes created successfully');
};

// Initialize database
const initDb = async () => {
  try {
    // Create tables
    createTables();

    // Create indexes
    createIndexes();

    // Create admin user
    await createAdminUser();

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    // Close the database connection
    db.close();
  }
};

// Only self-run as a script (`npm run init-db`). Importing this must not initialize or, worse, close the
// shared connection — tests build their schema by calling createTables/createIndexes directly.
if (require.main === module) {
  initDb();
}

module.exports = { createTables, createIndexes, createAdminUser, initDb };
