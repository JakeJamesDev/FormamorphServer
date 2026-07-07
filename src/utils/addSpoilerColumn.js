require('dotenv').config();
const db = require('../config/db');

// Add spoiler column to worlds table
const addSpoilerColumn = () => {
  try {
    // Check if column already exists
    const tableInfo = db.prepare("PRAGMA table_info(worlds)").all();
    const columnExists = tableInfo.some(column => column.name === 'spoiler');
    
    if (!columnExists) {
      // Add spoiler column with default value 0 (false)
      db.exec(`
        ALTER TABLE worlds
        ADD COLUMN spoiler INTEGER DEFAULT 0
      `);
      console.log('Added spoiler column to worlds table');
      
      // All existing worlds will have spoiler set to 0 (false) by default
      console.log('All existing worlds have spoiler set to false by default');
    } else {
      console.log('spoiler column already exists');
    }
  } catch (error) {
    console.error('Error adding spoiler column:', error);
  } finally {
    // Close the database connection
    db.close();
  }
};

// Run the migration
addSpoilerColumn();
