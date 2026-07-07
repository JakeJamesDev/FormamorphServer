const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execSync } = require('child_process');

// Promisify fs functions for async/await
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

// Define paths
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATABASE_PATH = path.join(PROJECT_ROOT, 'data', 'exotic-dangerous.db');
const WORLDS_DIR = path.join(PROJECT_ROOT, 'src', 'storage', 'worlds');
const THUMBNAILS_DIR = path.join(PROJECT_ROOT, 'src', 'storage', 'thumbnails');
const BACKUPS_DIR = path.join(PROJECT_ROOT, 'backups');

// Utility function to ensure directory exists
const ensureDir = async (dirPath) => {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

// Utility function to copy file with retry logic for Windows
const copyFileWithRetry = async (src, dest, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await copyFile(src, dest);
      return;
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'ENOENT') {
        if (attempt === maxRetries) {
          // On final attempt, try alternative copy method
          try {
            const data = await readFile(src);
            await writeFile(dest, data);
            return;
          } catch (altError) {
            throw new Error(`Failed to copy ${path.basename(src)} after ${maxRetries} attempts. Last error: ${error.message}`);
          }
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 100));
      } else {
        throw error;
      }
    }
  }
};

// Utility function to copy directory recursively
const copyDirectory = async (src, dest, progressCallback = null) => {
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  let copiedCount = 0;
  let errors = [];
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      try {
        const subCount = await copyDirectory(srcPath, destPath, progressCallback);
        copiedCount += subCount;
      } catch (error) {
        errors.push(`Directory ${entry.name}: ${error.message}`);
      }
    } else if (entry.isFile() && entry.name !== '.gitkeep') {
      try {
        await copyFileWithRetry(srcPath, destPath);
        copiedCount++;
        if (progressCallback) {
          progressCallback(entry.name, copiedCount);
        }
      } catch (error) {
        errors.push(`File ${entry.name}: ${error.message}`);
        console.warn(`Warning: Failed to copy ${entry.name}: ${error.message}`);
      }
    }
  }
  
  if (errors.length > 0) {
    console.warn(`\nWarning: ${errors.length} files could not be copied:`);
    errors.slice(0, 5).forEach(error => console.warn(`  - ${error}`));
    if (errors.length > 5) {
      console.warn(`  ... and ${errors.length - 5} more errors`);
    }
  }
  
  return copiedCount;
};

// Utility function to get directory file count (excluding .gitkeep)
const getFileCount = async (dirPath) => {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name !== '.gitkeep').length;
  } catch (error) {
    return 0;
  }
};

// Generate backup timestamp
const generateBackupTimestamp = () => {
  const now = new Date();
  return now.toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '-')
    .replace('T', '_')
    .slice(0, 19);
};

// Create backup manifest
const createBackupManifest = async (backupDir) => {
  const manifest = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    description: 'Complete backup of Exotic Dangerous World Workshop Server',
    contents: {
      database: {
        file: 'database/exotic-dangerous.db',
        size: 0
      },
      worlds: {
        directory: 'worlds/',
        fileCount: 0,
        totalSize: 0
      },
      thumbnails: {
        directory: 'thumbnails/',
        fileCount: 0,
        totalSize: 0
      }
    }
  };

  // Get database size
  try {
    const dbStats = await stat(DATABASE_PATH);
    manifest.contents.database.size = dbStats.size;
  } catch (error) {
    console.warn('Warning: Could not get database size:', error.message);
  }

  // Get worlds info
  try {
    const worldsCount = await getFileCount(WORLDS_DIR);
    manifest.contents.worlds.fileCount = worldsCount;
    
    // Calculate total size of worlds
    const worldEntries = await readdir(WORLDS_DIR);
    let worldsSize = 0;
    for (const entry of worldEntries) {
      if (entry !== '.gitkeep') {
        const filePath = path.join(WORLDS_DIR, entry);
        const fileStats = await stat(filePath);
        worldsSize += fileStats.size;
      }
    }
    manifest.contents.worlds.totalSize = worldsSize;
  } catch (error) {
    console.warn('Warning: Could not get worlds info:', error.message);
  }

  // Get thumbnails info
  try {
    const thumbnailsCount = await getFileCount(THUMBNAILS_DIR);
    manifest.contents.thumbnails.fileCount = thumbnailsCount;
    
    // Calculate total size of thumbnails
    const thumbnailEntries = await readdir(THUMBNAILS_DIR);
    let thumbnailsSize = 0;
    for (const entry of thumbnailEntries) {
      if (entry !== '.gitkeep') {
        const filePath = path.join(THUMBNAILS_DIR, entry);
        const fileStats = await stat(filePath);
        thumbnailsSize += fileStats.size;
      }
    }
    manifest.contents.thumbnails.totalSize = thumbnailsSize;
  } catch (error) {
    console.warn('Warning: Could not get thumbnails info:', error.message);
  }

  // Write manifest
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  
  return manifest;
};

// Backup database
const backupDatabase = async (backupDir) => {
  console.log('Backing up database...');
  const dbBackupDir = path.join(backupDir, 'database');
  await ensureDir(dbBackupDir);
  
  if (fs.existsSync(DATABASE_PATH)) {
    const destPath = path.join(dbBackupDir, 'exotic-dangerous.db');
    await copyFile(DATABASE_PATH, destPath);
    console.log('✓ Database backed up successfully');
  } else {
    console.warn('Warning: Database file not found, skipping database backup');
  }
};

// Backup world files
const backupWorldFiles = async (backupDir) => {
  console.log('Backing up world files...');
  const worldsBackupDir = path.join(backupDir, 'worlds');
  
  let copiedCount = 0;
  const totalFiles = await getFileCount(WORLDS_DIR);
  
  const progressCallback = (fileName, count) => {
    copiedCount = count;
    if (count % 10 === 0 || count === totalFiles) {
      console.log(`  Progress: ${count}/${totalFiles} world files copied`);
    }
  };
  
  const finalCount = await copyDirectory(WORLDS_DIR, worldsBackupDir, progressCallback);
  console.log(`✓ ${finalCount} world files backed up successfully`);
};

// Backup thumbnail files
const backupThumbnails = async (backupDir) => {
  console.log('Backing up thumbnail files...');
  const thumbnailsBackupDir = path.join(backupDir, 'thumbnails');
  
  let copiedCount = 0;
  const totalFiles = await getFileCount(THUMBNAILS_DIR);
  
  const progressCallback = (fileName, count) => {
    copiedCount = count;
    if (count % 10 === 0 || count === totalFiles) {
      console.log(`  Progress: ${count}/${totalFiles} thumbnail files copied`);
    }
  };
  
  const finalCount = await copyDirectory(THUMBNAILS_DIR, thumbnailsBackupDir, progressCallback);
  console.log(`✓ ${finalCount} thumbnail files backed up successfully`);
};

// Create complete backup
const createBackup = async (customBackupName = null) => {
  try {
    const timestamp = generateBackupTimestamp();
    const backupName = customBackupName || `backup-${timestamp}`;
    const backupDir = path.join(BACKUPS_DIR, backupName);
    
    console.log(`Creating backup: ${backupName}`);
    console.log(`Backup location: ${backupDir}`);
    
    // Ensure backups directory exists
    await ensureDir(BACKUPS_DIR);
    await ensureDir(backupDir);
    
    // Perform backups
    await backupDatabase(backupDir);
    await backupWorldFiles(backupDir);
    await backupThumbnails(backupDir);
    
    // Create manifest
    console.log('Creating backup manifest...');
    const manifest = await createBackupManifest(backupDir);
    console.log('✓ Backup manifest created');
    
    console.log('\n=== Backup Complete ===');
    console.log(`Backup name: ${backupName}`);
    console.log(`Database size: ${(manifest.contents.database.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`World files: ${manifest.contents.worlds.fileCount} files (${(manifest.contents.worlds.totalSize / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Thumbnails: ${manifest.contents.thumbnails.fileCount} files (${(manifest.contents.thumbnails.totalSize / 1024 / 1024).toFixed(2)} MB)`);
    
    return { success: true, backupName, backupDir, manifest };
  } catch (error) {
    console.error('Backup failed:', error);
    return { success: false, error: error.message };
  }
};

// Validate backup integrity
const validateBackup = async (backupPath) => {
  try {
    console.log(`Validating backup: ${backupPath}`);
    
    // Check if backup directory exists
    if (!fs.existsSync(backupPath)) {
      throw new Error('Backup directory does not exist');
    }
    
    // Check manifest
    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Backup manifest not found');
    }
    
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    
    // Validate database
    const dbPath = path.join(backupPath, 'database', 'exotic-dangerous.db');
    if (!fs.existsSync(dbPath)) {
      console.warn('Warning: Database backup not found');
    }
    
    // Validate worlds directory
    const worldsDir = path.join(backupPath, 'worlds');
    if (!fs.existsSync(worldsDir)) {
      throw new Error('Worlds backup directory not found');
    }
    
    // Validate thumbnails directory
    const thumbnailsDir = path.join(backupPath, 'thumbnails');
    if (!fs.existsSync(thumbnailsDir)) {
      throw new Error('Thumbnails backup directory not found');
    }
    
    console.log('✓ Backup validation passed');
    return { valid: true, manifest };
  } catch (error) {
    console.error('Backup validation failed:', error);
    return { valid: false, error: error.message };
  }
};

// Restore database
const restoreDatabase = async (backupDir) => {
  console.log('Restoring database...');
  const dbBackupPath = path.join(backupDir, 'database', 'exotic-dangerous.db');
  
  if (fs.existsSync(dbBackupPath)) {
    // Ensure data directory exists
    const dataDir = path.dirname(DATABASE_PATH);
    await ensureDir(dataDir);
    
    // Backup current database if it exists
    if (fs.existsSync(DATABASE_PATH)) {
      const backupDbPath = `${DATABASE_PATH}.backup-${Date.now()}`;
      await copyFile(DATABASE_PATH, backupDbPath);
      console.log(`  Current database backed up to: ${path.basename(backupDbPath)}`);
    }
    
    await copyFile(dbBackupPath, DATABASE_PATH);
    console.log('✓ Database restored successfully');
  } else {
    console.warn('Warning: No database backup found, skipping database restore');
  }
};

// Restore world files
const restoreWorldFiles = async (backupDir) => {
  console.log('Restoring world files...');
  const worldsBackupDir = path.join(backupDir, 'worlds');
  
  if (fs.existsSync(worldsBackupDir)) {
    // Ensure worlds directory exists
    await ensureDir(WORLDS_DIR);
    
    const totalFiles = await getFileCount(worldsBackupDir);
    let copiedCount = 0;
    
    const progressCallback = (fileName, count) => {
      copiedCount = count;
      if (count % 10 === 0 || count === totalFiles) {
        console.log(`  Progress: ${count}/${totalFiles} world files restored`);
      }
    };
    
    const finalCount = await copyDirectory(worldsBackupDir, WORLDS_DIR, progressCallback);
    console.log(`✓ ${finalCount} world files restored successfully`);
  } else {
    console.warn('Warning: No worlds backup found, skipping worlds restore');
  }
};

// Restore thumbnail files
const restoreThumbnails = async (backupDir) => {
  console.log('Restoring thumbnail files...');
  const thumbnailsBackupDir = path.join(backupDir, 'thumbnails');
  
  if (fs.existsSync(thumbnailsBackupDir)) {
    // Ensure thumbnails directory exists
    await ensureDir(THUMBNAILS_DIR);
    
    const totalFiles = await getFileCount(thumbnailsBackupDir);
    let copiedCount = 0;
    
    const progressCallback = (fileName, count) => {
      copiedCount = count;
      if (count % 10 === 0 || count === totalFiles) {
        console.log(`  Progress: ${count}/${totalFiles} thumbnail files restored`);
      }
    };
    
    const finalCount = await copyDirectory(thumbnailsBackupDir, THUMBNAILS_DIR, progressCallback);
    console.log(`✓ ${finalCount} thumbnail files restored successfully`);
  } else {
    console.warn('Warning: No thumbnails backup found, skipping thumbnails restore');
  }
};

// Restore from backup
const restoreFromBackup = async (backupName) => {
  try {
    const backupPath = path.join(BACKUPS_DIR, backupName);
    
    console.log(`Restoring from backup: ${backupName}`);
    console.log(`Backup location: ${backupPath}`);
    
    // Validate backup first
    const validation = await validateBackup(backupPath);
    if (!validation.valid) {
      throw new Error(`Backup validation failed: ${validation.error}`);
    }
    
    console.log('Backup validation passed, proceeding with restore...');
    
    // Perform restore
    await restoreDatabase(backupPath);
    await restoreWorldFiles(backupPath);
    await restoreThumbnails(backupPath);
    
    console.log('\n=== Restore Complete ===');
    console.log('All data has been restored from backup');
    console.log('You may need to restart the server for changes to take effect');
    
    return { success: true, backupName };
  } catch (error) {
    console.error('Restore failed:', error);
    return { success: false, error: error.message };
  }
};

// List available backups
const listBackups = async () => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) {
      console.log('No backups directory found');
      return [];
    }
    
    const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
    const backups = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const backupPath = path.join(BACKUPS_DIR, entry.name);
        const manifestPath = path.join(backupPath, 'manifest.json');
        
        let manifest = null;
        if (fs.existsSync(manifestPath)) {
          try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          } catch (error) {
            console.warn(`Warning: Could not read manifest for ${entry.name}`);
          }
        }
        
        backups.push({
          name: entry.name,
          path: backupPath,
          manifest
        });
      }
    }
    
    // Sort by timestamp (newest first)
    backups.sort((a, b) => {
      const timeA = a.manifest ? new Date(a.manifest.timestamp) : new Date(0);
      const timeB = b.manifest ? new Date(b.manifest.timestamp) : new Date(0);
      return timeB - timeA;
    });
    
    return backups;
  } catch (error) {
    console.error('Error listing backups:', error);
    return [];
  }
};

// Get backup information
const getBackupInfo = async (backupName) => {
  try {
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const validation = await validateBackup(backupPath);
    
    if (!validation.valid) {
      return { error: validation.error };
    }
    
    return {
      name: backupName,
      path: backupPath,
      manifest: validation.manifest,
      valid: true
    };
  } catch (error) {
    return { error: error.message };
  }
};

// Clean up old backups
const cleanupOldBackups = async (keepCount = 5) => {
  try {
    const backups = await listBackups();
    
    if (backups.length <= keepCount) {
      console.log(`Found ${backups.length} backups, keeping all (limit: ${keepCount})`);
      return { removed: 0, kept: backups.length };
    }
    
    const toRemove = backups.slice(keepCount);
    let removedCount = 0;
    
    for (const backup of toRemove) {
      try {
        // Remove backup directory recursively
        await fs.promises.rm(backup.path, { recursive: true, force: true });
        console.log(`Removed old backup: ${backup.name}`);
        removedCount++;
      } catch (error) {
        console.warn(`Warning: Could not remove backup ${backup.name}:`, error.message);
      }
    }
    
    console.log(`Cleanup complete: removed ${removedCount} old backups, kept ${backups.length - removedCount}`);
    return { removed: removedCount, kept: backups.length - removedCount };
  } catch (error) {
    console.error('Cleanup failed:', error);
    return { error: error.message };
  }
};

module.exports = {
  createBackup,
  restoreFromBackup,
  validateBackup,
  listBackups,
  getBackupInfo,
  cleanupOldBackups,
  backupDatabase,
  backupWorldFiles,
  backupThumbnails,
  restoreDatabase,
  restoreWorldFiles,
  restoreThumbnails
};
