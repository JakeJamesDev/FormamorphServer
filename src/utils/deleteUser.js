const db = require('../config/db');
const fs = require('fs').promises;
const path = require('path');
const { WORLDS_DIR, THUMBNAILS_DIR } = require('../config/paths');

/**
 * Delete a user and all their associated data
 * @param {string} username - Username to delete
 * @returns {Object} Result of the deletion operation
 */
async function deleteUser(username) {
  try {
    console.log(`Starting deletion process for user: ${username}`);
    
    // Find the user
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user) {
      return {
        success: false,
        error: `User '${username}' not found`
      };
    }
    
    console.log(`Found user: ${user.id} (${user.username})`);
    
    // Start transaction
    db.prepare('BEGIN TRANSACTION').run();
    
    try {
      // Get all worlds created by this user
      const userWorlds = db.prepare('SELECT * FROM worlds WHERE author_id = ?').all(user.id);
      console.log(`Found ${userWorlds.length} worlds created by user`);
      
      // Delete world files and database records
      for (const world of userWorlds) {
        console.log(`Deleting world: ${world.name} (${world.id})`);
        
        // Delete world content file
        if (world.content_file) {
          try {
            const contentPath = path.join(WORLDS_DIR, world.content_file);
            await fs.unlink(contentPath);
            console.log(`  - Deleted content file: ${world.content_file}`);
          } catch (err) {
            console.log(`  - Content file not found or already deleted: ${world.content_file}`);
          }
        }
        
        // Delete thumbnail file
        if (world.thumbnail_file) {
          try {
            const thumbnailPath = path.join(THUMBNAILS_DIR, world.thumbnail_file);
            await fs.unlink(thumbnailPath);
            console.log(`  - Deleted thumbnail file: ${world.thumbnail_file}`);
          } catch (err) {
            console.log(`  - Thumbnail file not found or already deleted: ${world.thumbnail_file}`);
          }
        }
        
        // Delete comments on this world (from all users)
        const worldComments = db.prepare('SELECT COUNT(*) as count FROM comments WHERE world_id = ?').get(world.id);
        if (worldComments.count > 0) {
          db.prepare('DELETE FROM comments WHERE world_id = ?').run(world.id);
          console.log(`  - Deleted ${worldComments.count} comments on this world`);
        }
        
        // Delete the world record
        db.prepare('DELETE FROM worlds WHERE id = ?').run(world.id);
        console.log(`  - Deleted world database record`);
      }
      
      // Delete all comments made by this user on other worlds
      const userComments = db.prepare('SELECT * FROM comments WHERE author_id = ?').all(user.id);
      console.log(`Found ${userComments.length} comments made by user`);
      
      for (const comment of userComments) {
        // Decrement comment count on the world
        db.prepare(`
          UPDATE worlds
          SET comment_count = MAX(0, comment_count - 1)
          WHERE id = ?
        `).run(comment.world_id);
        
        // Delete the comment
        db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
        console.log(`  - Deleted comment: ${comment.id}`);
      }
      
      // Finally, delete the user
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      console.log(`Deleted user: ${user.username}`);
      
      // Commit transaction
      db.prepare('COMMIT').run();
      
      console.log(`Successfully deleted user '${username}' and all associated data`);
      
      return {
        success: true,
        message: `Successfully deleted user '${username}' and all associated data`,
        deletedData: {
          user: user.username,
          worlds: userWorlds.length,
          comments: userComments.length
        }
      };
      
    } catch (error) {
      // Rollback transaction on error
      db.prepare('ROLLBACK').run();
      throw error;
    }
    
  } catch (error) {
    console.error('Error deleting user:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// If this script is run directly
if (require.main === module) {
  const username = process.argv[2];
  
  if (!username) {
    console.error('Usage: node deleteUser.js <username>');
    process.exit(1);
  }
  
  deleteUser(username)
    .then(result => {
      if (result.success) {
        console.log('\n✅ SUCCESS:', result.message);
        if (result.deletedData) {
          console.log('Deleted data summary:');
          console.log(`  - User: ${result.deletedData.user}`);
          console.log(`  - Worlds: ${result.deletedData.worlds}`);
          console.log(`  - Comments: ${result.deletedData.comments}`);
        }
      } else {
        console.error('\n❌ ERROR:', result.error);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n❌ FATAL ERROR:', error.message);
      process.exit(1);
    });
}

module.exports = deleteUser;
