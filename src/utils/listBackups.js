#!/usr/bin/env node

require('dotenv').config();
const { listBackups, getBackupInfo } = require('./backupRestore');

const main = async () => {
  try {
    console.log('=== Exotic Dangerous World Workshop Server Backups ===\n');
    
    const backups = await listBackups();
    
    if (backups.length === 0) {
      console.log('No backups found.');
      console.log('\nTo create a backup, run: npm run backup');
      process.exit(0);
    }
    
    console.log(`Found ${backups.length} backup(s):\n`);
    
    for (let i = 0; i < backups.length; i++) {
      const backup = backups[i];
      const num = (i + 1).toString().padStart(2, ' ');
      
      console.log(`${num}. ${backup.name}`);
      
      if (backup.manifest) {
        const timestamp = new Date(backup.manifest.timestamp);
        const dbSize = (backup.manifest.contents.database.size / 1024 / 1024).toFixed(2);
        const worldsSize = (backup.manifest.contents.worlds.totalSize / 1024 / 1024).toFixed(2);
        const thumbnailsSize = (backup.manifest.contents.thumbnails.totalSize / 1024 / 1024).toFixed(2);
        const totalSize = (
          (backup.manifest.contents.database.size + 
           backup.manifest.contents.worlds.totalSize + 
           backup.manifest.contents.thumbnails.totalSize) / 1024 / 1024
        ).toFixed(2);
        
        console.log(`    Created: ${timestamp.toLocaleString()}`);
        console.log(`    Database: ${dbSize} MB`);
        console.log(`    Worlds: ${backup.manifest.contents.worlds.fileCount} files (${worldsSize} MB)`);
        console.log(`    Thumbnails: ${backup.manifest.contents.thumbnails.fileCount} files (${thumbnailsSize} MB)`);
        console.log(`    Total Size: ${totalSize} MB`);
        console.log(`    Version: ${backup.manifest.version}`);
      } else {
        console.log('    ⚠️  No manifest found (possibly corrupted backup)');
      }
      
      console.log('');
    }
    
    console.log('Commands:');
    console.log('  Create backup:     npm run backup [custom-name]');
    console.log('  Restore backup:    npm run restore <backup-name>');
    console.log('  Cleanup old:       npm run cleanup-backups [keep-count]');
    
  } catch (error) {
    console.error('❌ Error listing backups:', error.message);
    process.exit(1);
  }
};

main();
