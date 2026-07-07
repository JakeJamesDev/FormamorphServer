require('dotenv').config();
const db = require('../config/db');

/**
 * Reset all worlds' updated_at fields to match their created_at fields
 * This is a one-time operation to fix worlds that had their updated_at
 * incorrectly set due to downloads
 */
const resetWorldsUpdatedDates = () => {
  try {
    console.log('Starting to reset worlds updated_at dates...');
    
    // Get all worlds
    const worlds = db.prepare('SELECT id, created_at FROM worlds').all();
    console.log(`Found ${worlds.length} worlds to update`);
    
    // Update each world's updated_at to match its created_at
    const updateStmt = db.prepare('UPDATE worlds SET updated_at = ? WHERE id = ?');
    
    // Start a transaction for better performance
    const updateTransaction = db.transaction((worlds) => {
      let updatedCount = 0;
      
      for (const world of worlds) {
        const result = updateStmt.run(world.created_at, world.id);
        if (result.changes > 0) {
          updatedCount++;
        }
      }
      
      return updatedCount;
    });
    
    // Execute the transaction
    const updatedCount = updateTransaction(worlds);
    
    console.log(`Successfully updated ${updatedCount} worlds`);
    console.log('Operation completed successfully');
    
    return updatedCount;
  } catch (error) {
    console.error('Error resetting worlds updated_at dates:', error);
    throw error;
  } finally {
    // Close the database connection
    db.close();
  }
};

// Run the function if this script is executed directly
if (require.main === module) {
  resetWorldsUpdatedDates();
}

module.exports = resetWorldsUpdatedDates;
