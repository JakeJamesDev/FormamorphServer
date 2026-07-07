/**
 * Utility script to update world tags based on worldOverview.tags
 * 
 * This script addresses an issue where tags were previously obtained from worldOverview.tags,
 * but a recent update reversed that, causing new worlds to miss tags information.
 * 
 * This script:
 * 1. Fetches all worlds from the database
 * 2. For each world, reads its content file to extract worldOverview.tags
 * 3. Updates the world's tags in the database with the extracted tags
 */

const db = require('../config/db');
const { readWorldContent } = require('./fileStorage');
const path = require('path');
const fs = require('fs');

/**
 * Update tags for all worlds in the database
 */
async function updateWorldTags() {
  console.log('Starting world tags update process...');
  
  try {
    // Get all worlds from the database
    const worlds = db.prepare('SELECT id, content_file, tags FROM worlds').all();
    console.log(`Found ${worlds.length} worlds to process`);
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // Process each world
    for (const world of worlds) {
      try {
        console.log(`Processing world: ${world.id}`);
        
        // Skip if content_file is missing
        if (!world.content_file) {
          console.log(`Skipping world ${world.id}: No content file`);
          skippedCount++;
          continue;
        }
        
        // Read the world content file
        const contentData = await readWorldContent(world.content_file);
        
        // Skip if worldOverview or tags are missing
        if (!contentData || !contentData.worldOverview || !contentData.worldOverview.tags) {
          console.log(`Skipping world ${world.id}: No worldOverview.tags found`);
          skippedCount++;
          continue;
        }
        
        // Extract tags from worldOverview
        const tags = contentData.worldOverview.tags;
        
        // Ensure tags is an array
        const tagsArray = Array.isArray(tags) ? tags : (typeof tags === 'string' ? [tags] : []);
        
        // Convert to JSON string for storage
        const tagsString = JSON.stringify(tagsArray);
        
        // Get current tags from database
        const currentTagsString = world.tags;
        const currentTags = currentTagsString ? JSON.parse(currentTagsString) : [];
        
        // Skip if tags are already up to date
        if (JSON.stringify(currentTags) === tagsString) {
          console.log(`Skipping world ${world.id}: Tags already up to date`);
          skippedCount++;
          continue;
        }
        
        // Update tags in database
        db.prepare('UPDATE worlds SET tags = ? WHERE id = ?').run(tagsString, world.id);
        console.log(`Updated tags for world ${world.id}: ${tagsString}`);
        updatedCount++;
      } catch (error) {
        console.error(`Error processing world ${world.id}:`, error);
        errorCount++;
      }
    }
    
    console.log('\nWorld tags update completed:');
    console.log(`- Total worlds processed: ${worlds.length}`);
    console.log(`- Updated: ${updatedCount}`);
    console.log(`- Skipped: ${skippedCount}`);
    console.log(`- Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('Failed to update world tags:', error);
  }
}

// Run the update function if this script is executed directly
if (require.main === module) {
  updateWorldTags()
    .then(() => {
      console.log('World tags update script completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('World tags update script failed:', error);
      process.exit(1);
    });
} else {
  // Export the function for use in other modules
  module.exports = { updateWorldTags };
}
