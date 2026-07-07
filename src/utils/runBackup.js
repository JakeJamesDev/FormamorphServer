#!/usr/bin/env node

require('dotenv').config();
const { createBackup } = require('./backupRestore');

const main = async () => {
  try {
    console.log('=== Exotic Dangerous World Workshop Server Backup ===\n');
    
    // Get custom backup name from command line arguments
    const customName = process.argv[2];
    
    if (customName) {
      console.log(`Creating backup with custom name: ${customName}`);
    } else {
      console.log('Creating backup with timestamp...');
    }
    
    const result = await createBackup(customName);
    
    if (result.success) {
      console.log('\n🎉 Backup completed successfully!');
      process.exit(0);
    } else {
      console.error('\n❌ Backup failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Backup failed with error:', error.message);
    process.exit(1);
  }
};

main();
