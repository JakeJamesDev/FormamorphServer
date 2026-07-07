/**
 * Script to run the updateWorldTags utility
 * 
 * This script is a simple wrapper around the updateWorldTags utility
 * that can be run from the command line.
 * 
 * Usage:
 * node src/utils/runUpdateWorldTags.js
 */

const { updateWorldTags } = require('./updateWorldTags');

// Run the update function
updateWorldTags()
  .then(() => {
    console.log('World tags update script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('World tags update script failed:', error);
    process.exit(1);
  });
