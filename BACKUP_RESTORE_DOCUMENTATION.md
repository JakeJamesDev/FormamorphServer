# Backup and Restore System Documentation

This document describes the comprehensive backup and restore system for the Exotic Dangerous World Workshop Server.

## Overview

The backup and restore system provides complete data protection for all server components:
- **SQLite Database** (users, worlds metadata, comments)
- **World Content Files** (large JSON files containing world data)
- **Thumbnail Files** (image files for world previews)

## Features

- **Complete Backup**: Backs up everything in one operation
- **Atomic Operations**: Backup/restore either succeeds completely or fails safely
- **Progress Reporting**: Shows progress for large file operations
- **Validation**: Verifies backup integrity before restore
- **Timestamped Backups**: Each backup has a unique timestamp
- **Backup Manifests**: Detailed metadata about each backup
- **Safety Measures**: Current data is backed up before restore
- **Cleanup Tools**: Remove old backups to save disk space

## Quick Start

### Create a Backup
```bash
# Create backup with timestamp (safe to run while server is running)
npm run backup

# Create backup with custom name
npm run backup my-backup-name
```

**✅ Safe to run while server is running** - Backup operations only read data and don't interfere with server operations.

### List Available Backups
```bash
npm run list-backups
```

### Restore from Backup
```bash
npm run restore backup-2025-02-08_17-10-48
```

### Cleanup Old Backups
```bash
# Keep 5 most recent backups (default)
npm run cleanup-backups

# Keep 10 most recent backups
npm run cleanup-backups 10
```

## Backup Structure

Each backup is stored in a timestamped directory under `backups/`:

```
backups/
├── backup-2025-02-08_17-10-48/
│   ├── manifest.json              # Backup metadata
│   ├── database/
│   │   └── exotic-dangerous.db    # SQLite database
│   ├── worlds/
│   │   ├── world1.json           # World content files
│   │   ├── world2.json
│   │   └── ...
│   └── thumbnails/
│       ├── thumb1.jpeg           # Thumbnail images
│       ├── thumb2.png
│       └── ...
```

## Backup Manifest

Each backup includes a `manifest.json` file with detailed information:

```json
{
  "timestamp": "2025-02-08T17:10:48.000Z",
  "version": "1.0.0",
  "description": "Complete backup of Exotic Dangerous World Workshop Server",
  "contents": {
    "database": {
      "file": "database/exotic-dangerous.db",
      "size": 1048576
    },
    "worlds": {
      "directory": "worlds/",
      "fileCount": 150,
      "totalSize": 104857600
    },
    "thumbnails": {
      "directory": "thumbnails/",
      "fileCount": 150,
      "totalSize": 52428800
    }
  }
}
```

## Commands Reference

### npm run backup [custom-name]

Creates a complete backup of all server data.

**Parameters:**
- `custom-name` (optional): Custom name for the backup instead of timestamp

**Examples:**
```bash
npm run backup                    # Creates backup-2025-02-08_17-10-48
npm run backup before-update      # Creates before-update
```

**Output:**
- Progress updates during backup
- Summary of backed up data
- Backup location and size information

### npm run restore <backup-name>

Restores all data from a specified backup.

**Parameters:**
- `backup-name` (required): Name of the backup to restore from

**Examples:**
```bash
npm run restore backup-2025-02-08_17-10-48
npm run restore before-update
```

**Safety Features:**
- Validates backup integrity before restore
- Backs up current database before overwriting
- Shows warning about data replacement
- Provides restart reminder

**Important:** Stop the server before running restore operations.

### npm run list-backups

Lists all available backups with detailed information.

**Output for each backup:**
- Backup name and creation timestamp
- Database size
- Number of world files and total size
- Number of thumbnail files and total size
- Total backup size
- Backup version

### npm run cleanup-backups [keep-count]

Removes old backups, keeping only the most recent ones.

**Parameters:**
- `keep-count` (optional): Number of backups to keep (default: 5)

**Examples:**
```bash
npm run cleanup-backups           # Keep 5 most recent
npm run cleanup-backups 10        # Keep 10 most recent
npm run cleanup-backups 1         # Keep only the newest
```

## Programmatic Usage

You can also use the backup system programmatically:

```javascript
const {
  createBackup,
  restoreFromBackup,
  listBackups,
  validateBackup,
  cleanupOldBackups
} = require('./src/utils/backupRestore');

// Create a backup
const result = await createBackup('my-backup');
if (result.success) {
  console.log('Backup created:', result.backupName);
}

// List backups
const backups = await listBackups();
console.log('Available backups:', backups.length);

// Restore from backup
const restoreResult = await restoreFromBackup('my-backup');
if (restoreResult.success) {
  console.log('Restore completed');
}

// Validate a backup
const validation = await validateBackup('/path/to/backup');
if (validation.valid) {
  console.log('Backup is valid');
}

// Cleanup old backups
const cleanup = await cleanupOldBackups(5);
console.log(`Removed ${cleanup.removed} old backups`);
```

## Best Practices

### Regular Backups
- Create backups before major updates or changes
- Set up automated backups using cron jobs or task scheduler
- Test restore procedures periodically

### Backup Storage
- Store backups on a separate drive or network location
- Consider compressing backups for long-term storage
- Keep multiple generations of backups

### Before Restore
- Always stop the server before restoring
- Verify backup integrity with `npm run list-backups`
- Ensure sufficient disk space for restore operation

### Monitoring
- Check backup sizes for unexpected changes
- Monitor backup creation times for performance issues
- Verify backup manifests for completeness

## Automation Examples

### Daily Backup Script (Linux/macOS)
```bash
#!/bin/bash
cd /path/to/server
npm run backup daily-$(date +%Y%m%d)
npm run cleanup-backups 7
```

### Windows Batch Script
```batch
@echo off
cd /d "C:\path\to\server"
npm run backup daily-%date:~-4,4%%date:~-10,2%%date:~-7,2%
npm run cleanup-backups 7
```

### Cron Job (Linux/macOS)
```bash
# Daily backup at 2 AM
0 2 * * * cd /path/to/server && npm run backup daily-$(date +\%Y\%m\%d) && npm run cleanup-backups 7
```

## Troubleshooting

### Backup Fails
- Check disk space in the backups directory
- Verify file permissions for source directories
- Ensure no files are locked by running processes

### Restore Fails
- Stop the server before restoring
- Check backup integrity with validation
- Verify sufficient disk space for restore
- Check file permissions in target directories

### Large Backup Times
- Monitor progress output for bottlenecks
- Consider backing up during low-usage periods
- Check disk I/O performance

### Corrupted Backups
- Use `npm run list-backups` to check backup status
- Validate specific backups before restore
- Remove corrupted backups manually from backups directory

## File Locations

- **Backup Scripts**: `src/utils/backupRestore.js`
- **CLI Scripts**: `src/utils/run*.js`
- **Backups Directory**: `backups/` (created automatically)
- **Source Database**: `data/exotic-dangerous.db`
- **Source Worlds**: `src/storage/worlds/`
- **Source Thumbnails**: `src/storage/thumbnails/`

## Security Considerations

- Backups contain sensitive user data and should be protected
- Consider encrypting backups for long-term storage
- Limit access to backup directories
- Regularly audit backup access logs

## Performance Notes

- Backup time scales with data size (hundreds of world files)
- Progress is reported every 10 files during large operations
- Memory usage is optimized for large file operations
- Network storage may significantly impact backup/restore times
