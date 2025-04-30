const User = require('../models/User');
const bcrypt = require('bcryptjs');

/**
 * Creates an admin user if one doesn't already exist
 * @param {Object} options - Admin user options
 * @param {string} options.username - Admin username
 * @param {string} options.password - Admin password
 * @param {string} options.email - Admin email (optional)
 */
const seedAdminUser = async (options = {}) => {
  try {
    const {
      username = 'admin',
      password = 'admin123',
      email = 'admin@example.com'
    } = options;

    // Check if an admin user already exists
    const adminExists = await User.findOne({ accountType: 'admin' });
    console.log(adminExists)
    if (adminExists) {
      console.log('Admin user already exists, skipping seed');
      return;
    }

    // Create admin user
    const adminUser = await User.create({
      username,
      password, // Let the User model's pre-save hook handle password hashing
      email,
      accountType: 'admin',
      status: 'normal'
    });

    console.log(`Admin user created: ${adminUser.username}`);
  } catch (error) {
    console.error('Error seeding admin user:', error);
  }
};

module.exports = seedAdminUser;
