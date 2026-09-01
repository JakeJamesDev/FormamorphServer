require('dotenv').config();
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { migrate } = require('../schema');

/** The value this seeder once defaulted to, and that older setup docs prescribed. Refused on sight. */
const FORBIDDEN_ADMIN_PASSWORD = 'admin123';

/**
 * Seed the first administrator from the environment.
 *
 * There is no default password. A missing or well-known `ADMIN_PASSWORD` aborts the seed rather than
 * quietly creating the one account that can delete the site behind a credential anyone can guess —
 * a silent fallback is indistinguishable from a correct setup until somebody logs in as you.
 *
 * @throws {Error} When `ADMIN_PASSWORD` is unset, too short, or the known-bad value
 */
const createAdminUser = async () => {
  try {
    // Existence first, validation second: on a database that already has its administrator the password
    // is never used, and a deploy that reruns this routinely must not start failing over an env var
    // nothing reads. The rules below guard creation only.
    const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');

    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      throw new Error('ADMIN_PASSWORD is not set — refusing to seed an admin account with a default password');
    }

    if (password === FORBIDDEN_ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD is the well-known setup default — choose a real password');
    }

    if (password.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    db.prepare(`
      INSERT INTO users (id, username, password, email, account_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      process.env.ADMIN_USERNAME || 'admin',
      hashedPassword,
      process.env.ADMIN_EMAIL || 'admin@example.com',
      'admin'
    );

    console.log('Admin user created successfully');
  } catch (error) {
    // Rethrown, not logged and shrugged off: a swallowed failure here leaves a database that looks
    // seeded and has no owner, or worse, hides the refusal above.
    console.error('Error creating admin user:', error.message);
    throw error;
  }
};

/**
 * `npm run init-db`: the schema step the server runs at boot, then the administrator the server never
 * seeds on its own.
 */
const initDb = async () => {
  try {
    migrate(db);
    await createAdminUser();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error.message);
    // Nonzero, so a failed seed stops a deploy script instead of reading as success.
    process.exitCode = 1;
  } finally {
    db.close();
  }
};

// Only self-run as a script. Importing this must not initialize or, worse, close the shared connection.
if (require.main === module) {
  initDb();
}

module.exports = { createAdminUser, initDb };
