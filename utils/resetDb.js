const mongoose = require('mongoose');
const seedAdminUser = require('./seedAdmin');
require('dotenv').config();

/**
 * Reset the database by dropping all collections and re-seeding the admin user
 */
const resetDb = async () => {
  try {
    // Connect to MongoDB
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/exotic-dangerous';
    console.log(`Connecting to MongoDB at ${uri}...`);
    
    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    // Get all collections
    const collections = await mongoose.connection.db.collections();
    
    // Drop each collection
    console.log('Dropping all collections...');
    for (const collection of collections) {
      await collection.drop();
      console.log(`Dropped collection: ${collection.collectionName}`);
    }
    
    console.log('All collections dropped successfully');
    
    // Re-seed admin user
    console.log('Re-seeding admin user...');
    await seedAdminUser({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123',
      email: process.env.ADMIN_EMAIL || 'admin@example.com'
    });
    
    console.log('Database reset completed successfully');
    
    // Close the connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    
    process.exit(0);
  } catch (error) {
    console.error('Error resetting database:', error);
    process.exit(1);
  }
};

// Run the reset function if this script is executed directly
if (require.main === module) {
  resetDb();
}

module.exports = resetDb;
