require('dotenv').config();
const db = require('../config/db');

// Add comment_count column to worlds table
const addCommentCountColumn = () => {
  try {
    // Check if column already exists
    const tableInfo = db.prepare("PRAGMA table_info(worlds)").all();
    const columnExists = tableInfo.some(column => column.name === 'comment_count');
    
    if (!columnExists) {
      // Add comment_count column with default value 0
      db.exec(`
        ALTER TABLE worlds
        ADD COLUMN comment_count INTEGER DEFAULT 0
      `);
      console.log('Added comment_count column to worlds table');
      
      // Update existing worlds with correct comment counts
      const worlds = db.prepare('SELECT id FROM worlds').all();
      
      for (const world of worlds) {
        const commentCount = db.prepare('SELECT COUNT(*) as count FROM comments WHERE world_id = ?').get(world.id);
        db.prepare('UPDATE worlds SET comment_count = ? WHERE id = ?').run(commentCount.count, world.id);
      }
      
      console.log('Updated comment counts for existing worlds');
    } else {
      console.log('comment_count column already exists');
    }
  } catch (error) {
    console.error('Error adding comment_count column:', error);
  } finally {
    // Close the database connection
    db.close();
  }
};

// Run the migration
addCommentCountColumn();
