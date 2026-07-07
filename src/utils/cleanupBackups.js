#!/usr/bin/env node

require('dotenv').config();
const { cleanupOldBackups } = require('./backupRestore');

const main = async () => {
  try {
    console.log('=== Exotic Dangerous World Workshop Server Backup Cleanup ===\n');
    
    // Get keep count from command line arguments (default: 5)
    const keepCount = parseInt(process.argv[2]) || 5;
    
    if (keepCount < 1) {
      console.log('❌ Error: Keep count must be at least 1');
      process.exit(1);
    }
    
    console.log(`Cleaning up old backups, keeping the ${keepCount} most recent...\n`);
    
    const result = await cleanupOldBackups(keepCount);
    
    if (result.error) {
      console.error('\n❌ Cleanup failed:', result.error);
      process.exit(1);
    } else {
      console.log('\n🎉 Cleanup completed successfully!');
      console.log(`Removed: ${result.removed} backups`);
      console.log(`Kept: ${result.kept} backups`);
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Cleanup failed with error:', error.message);
    process.exit(1);
  }
};

main();
