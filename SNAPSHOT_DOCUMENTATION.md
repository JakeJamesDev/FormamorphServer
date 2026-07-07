# World Snapshot Documentation

This document explains the world snapshot feature for the Exotic Dangerous World Workshop Server.

## Overview

The snapshot feature creates a complete, portable archive of all worlds in the database. Unlike backups which store raw database and file data, snapshots export worlds in a structured, human-readable format suitable for:

- **Sharing collections** of worlds with others
- **Archiving** world content for long-term preservation
- **Migrating** worlds between servers
- **Offline browsing** of world metadata
- **Importing** selected worlds into other systems

## Snapshot Structure

Each snapshot is a ZIP file containing:

```
worlds-snapshot-[timestamp].zip
├── README.txt                    # Documentation about the snapshot
├── worlds-metadata.json          # Master index of all worlds
└── world-[id]/                   # Individual world folders
    ├── metadata.json             # Full world metadata
    ├── content.json              # Complete world data
    ├── thumbnail.[ext]           # World thumbnail image
    └── comments.json             # All comments with authors
```

### Master Metadata (worlds-metadata.json)

The root-level metadata file provides a searchable index of all worlds:

```json
{
  "generatedAt": "2025-01-05T14:30:15.000Z",
  "version": "1.0.0",
  "totalWorlds": 42,
  "worlds": [
    {
      "id": "uuid-here",
      "name": "Amazing World",
      "description": "A fantastic creation",
      "tags": ["adventure", "combat"],
      "author": {
        "id": "author-uuid",
        "username": "creator123"
      },
      "downloads": 150,
      "commentCount": 12,
      "spoiler": false,
      "createdAt": "2025-01-01T10:00:00.000Z",
      "updatedAt": "2025-01-05T12:00:00.000Z",
      "folderName": "world-uuid-here"
    }
    // ... more worlds
  ]
}
```

This file enables:
- Quick searching and filtering without extracting the entire ZIP
- Building catalogs of worlds
- Comparing snapshots over time
- Creating world indexes

### Individual World Metadata

Each world folder contains a `metadata.json` with complete information:

```json
{
  "id": "uuid-here",
  "name": "Amazing World",
  "description": "A fantastic creation",
  "tags": ["adventure", "combat"],
  "author": {
    "id": "author-uuid",
    "username": "creator123"
  },
  "downloads": 150,
  "commentCount": 12,
  "spoiler": false,
  "createdAt": "2025-01-01T10:00:00.000Z",
  "updatedAt": "2025-01-05T12:00:00.000Z",
  "files": {
    "content": "content.json",
    "thumbnail": "thumbnail.jpg",
    "metadata": "metadata.json",
    "comments": "comments.json"
  }
}
```

### World Content (content.json)

The complete world data in the game's native format. This is typically a large JSON file (20MB+) containing all world information.

### World Comments (comments.json)

All comments for the world with author information:

```json
{
  "worldId": "uuid-here",
  "totalComments": 3,
  "comments": [
    {
      "id": "comment-uuid",
      "content": "Great world!",
      "author": {
        "id": "user-uuid",
        "username": "player1"
      },
      "createdAt": "2025-01-02T10:00:00.000Z",
      "updatedAt": "2025-01-02T10:00:00.000Z"
    }
    // ... more comments
  ]
}
```

## Usage

### Creating a Snapshot

Create a snapshot with an automatic timestamp name:

```bash
npm run snapshot
```

Create a snapshot with a custom name:

```bash
npm run snapshot my-custom-name
```

This will create `my-custom-name.zip` in the `snapshots/` directory.

**Output Example:**
```
=== Exotic Dangerous World Snapshot Creator ===

Snapshot will be saved to: C:\path\to\servertest\snapshots\worlds-snapshot-2025-01-05_14-30-15.zip
Fetching worlds from database...
Found 42 worlds
Creating master metadata...
Processing worlds...
  [1/42] Amazing World (uuid-here)
    Added 12 comments
  [2/42] Cool Adventure (uuid-here)
  ...

✓ Snapshot created successfully: worlds-snapshot-2025-01-05_14-30-15.zip
  Size: 1024.50 MB
  Total worlds: 42
  Successfully processed: 42
```

### Listing Snapshots

View all available snapshots:

```bash
npm run list-snapshots
```

**Output Example:**
```
=== Available World Snapshots ===

Found 5 snapshot(s):

1. worlds-snapshot-2025-01-05_14-30-15.zip
   Size: 1024.50 MB
   Created: 1/5/2025, 2:30:15 PM
   Path: C:\path\to\servertest\snapshots\worlds-snapshot-2025-01-05_14-30-15.zip

2. worlds-snapshot-2025-01-04_10-15-30.zip
   Size: 950.25 MB
   Created: 1/4/2025, 10:15:30 AM
   Path: C:\path\to\servertest\snapshots\worlds-snapshot-2025-01-04_10-15-30.zip

...
```

### Cleaning Up Old Snapshots

Remove old snapshots, keeping only the most recent ones:

```bash
# Keep the 3 most recent snapshots (default)
npm run cleanup-snapshots

# Keep a specific number of snapshots
npm run cleanup-snapshots 5
```

**Output Example:**
```
=== World Snapshot Cleanup ===

Keeping the 3 most recent snapshots...

Removed old snapshot: worlds-snapshot-2025-01-01_08-00-00.zip
Removed old snapshot: worlds-snapshot-2025-01-02_09-30-00.zip
Cleanup complete: removed 2 old snapshots, kept 3

=== Cleanup Complete ===
```

## Snapshot vs Backup

| Feature | Snapshot | Backup |
|---------|----------|--------|
| **Purpose** | Export/share worlds | Restore entire system |
| **Format** | Structured ZIP with JSON | Raw database + files |
| **Includes** | Worlds only | Database + worlds + thumbnails |
| **Readability** | Human-readable JSON | Binary database file |
| **Use Case** | Migration, archival, sharing | Disaster recovery |
| **Size** | Medium (compressed worlds) | Large (everything) |
| **Comments** | Included with authors | In database |
| **Metadata** | Searchable index | Not indexed |

**When to use Snapshots:**
- Exporting worlds to share with others
- Creating an archive of world content
- Migrating selected worlds to another server
- Creating a catalog of available worlds
- Preserving worlds in an accessible format

**When to use Backups:**
- Complete system backup for disaster recovery
- Restoring the entire server state
- Preserving all data including user accounts
- Quick recovery after corruption

## Use Cases

### 1. Sharing World Collections

Create a snapshot and share the ZIP file:

```bash
npm run snapshot community-favorites
```

Recipients can extract the ZIP and browse the `worlds-metadata.json` to see all available worlds, then access individual world folders for full content.

### 2. Migration Between Servers

Export worlds from one server:
```bash
npm run snapshot server1-export
```

On the destination server, extract the snapshot and import selected worlds using the structured JSON data.

### 3. Archival

Create periodic snapshots for long-term archival:

```bash
# Create monthly archive
npm run snapshot archive-2025-01

# Remove old archives, keep 12 months
npm run cleanup-snapshots 12
```

### 4. Offline Browsing

Extract a snapshot to browse world metadata, thumbnails, and content offline without running the server.

### 5. Content Analysis

Use the searchable `worlds-metadata.json` to analyze:
- Most popular tags
- World creation trends
- User activity
- Download patterns

## Storage Considerations

- Snapshots are stored in the `snapshots/` directory
- Each snapshot can be 500MB - 2GB+ depending on world count and size
- Automatic cleanup helps manage disk space
- Snapshots are compressed at maximum level (zlib level 9)

## Error Handling

The snapshot process is resilient:

- **Missing Files**: Warns but continues with other worlds
- **Database Errors**: Reports errors but completes what it can
- **Disk Space**: Fails gracefully if insufficient space
- **Permissions**: Reports permission errors clearly

If some worlds fail during snapshotting, the process completes successfully and lists which worlds failed in the summary.

## Technical Details

### File Naming

- Automatic names: `worlds-snapshot-YYYY-MM-DD_HH-MM-SS.zip`
- Custom names: `[your-name].zip`
- Timestamps use ISO format with safe characters

### Compression

- Uses `archiver` library with zlib compression
- Maximum compression level (9) to minimize file size
- Efficient for large JSON files

### Performance

- Progress updates every world
- Processes worlds sequentially to manage memory
- Typical speed: 5-10 worlds per second (depends on world size)

### Database Queries

Snapshots use optimized SQL queries:
- Single query to fetch all worlds with authors
- Single query per world for comments
- No content file reads from database (uses file system)

## Integration with Other Systems

The structured snapshot format makes it easy to:

1. **Import to other platforms**: Parse the JSON data and import
2. **Create web catalogs**: Use `worlds-metadata.json` to build searchable interfaces
3. **Generate statistics**: Analyze the metadata for insights
4. **Build tools**: Create utilities to work with snapshot data

## Best Practices

1. **Regular snapshots**: Create snapshots regularly (weekly/monthly)
2. **Meaningful names**: Use descriptive names for important snapshots
3. **Cleanup schedule**: Run cleanup regularly to manage disk space
4. **Verify snapshots**: Occasionally extract and verify snapshot contents
5. **Document changes**: Keep notes about what each snapshot contains

## Troubleshooting

### Snapshot Creation Fails

1. Check disk space in `snapshots/` directory
2. Verify database file is accessible
3. Check file permissions on world and thumbnail directories
4. Review console output for specific errors

### Large File Sizes

- Normal for servers with many/large worlds
- Consider cleanup of old snapshots
- Compression is already at maximum level

### Missing Worlds in Snapshot

- Check console warnings during creation
- Verify world files exist in `src/storage/worlds/`
- Ensure database records match actual files

## Future Enhancements

Potential improvements:
- Selective snapshot (filter by tags, date, author)
- Differential snapshots (only changed worlds)
- Snapshot comparison tools
- Automatic scheduled snapshots
- Snapshot import functionality
- Web UI for snapshot management
