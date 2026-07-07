#!/usr/bin/env node

require('dotenv').config();
const { restoreFromBackup, listBackups } = require('./backupRestore');

const main = async () => {
  try {
    console.log('=== Exotic Dangerous World Workshop Server Restore ===\n');
    
    // Get backup name from command line arguments
    const backupName = process.argv[2];
    
    if (!backupName) {
      console.log('❌ Error: Please specify a backup name to restore from');
      console.log('\nUsage: npm run restore <backup-name>');
      console.log('\nAvailable backups:');
      
      const backups = await listBackups();
      if (backups.length === 0) {
        console.log('  No backups found');
      } else {
        backups.forEach((backup, index) => {
          const timestamp = backup.manifest ? new Date(backup.manifest.timestamp).toLocaleString() : 'Unknown';
          const dbSize = backup.manifest ? (backup.manifest.contents.database.size / 1024 / 1024).toFixed(2) : '?';
          const worldCount = backup.manifest ? backup.manifest.contents.worlds.fileCount : '?';
          const thumbnailCount = backup.manifest ? backup.manifest.contents.thumbnails.fileCount : '?';
          
          console.log(`  ${index + 1}. ${backup.name}`);
          console.log(`     Created: ${timestamp}`);
          console.log(`     Database: ${dbSize} MB, Worlds: ${worldCount}, Thumbnails: ${thumbnailCount}`);
          console.log('');
        });
      }
      process.exit(1);
    }
    
    console.log(`⚠️  WARNING: This will overwrite all current data!`);
    console.log(`Restoring from backup: ${backupName}`);
    console.log('\nThis operation will:');
    console.log('- Replace the current database');
    console.log('- Replace all world files');
    console.log('- Replace all thumbnail files');
    console.log('\nCurrent data will be backed up before restore.');
    
    // In a real CLI, you might want to add a confirmation prompt here
    // For now, we'll proceed directly
    console.log('\nProceeding with restore...\n');
    
    const result = await restoreFromBackup(backupName);
    
    if (result.success) {
      console.log('\n🎉 Restore completed successfully!');
      console.log('\n⚠️  Important: Please restart the server for changes to take effect.');
      process.exit(0);
    } else {
      console.error('\n❌ Restore failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Restore failed with error:', error.message);
    process.exit(1);
  }
};

main();
