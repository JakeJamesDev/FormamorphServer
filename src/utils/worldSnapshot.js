const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { promisify } = require('util');
const db = require('../config/db');
const { readWorldContent } = require('./fileStorage');
const Comment = require('../models/Comment');

const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);

// Define paths
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const WORLDS_DIR = path.join(PROJECT_ROOT, 'src', 'storage', 'worlds');
const THUMBNAILS_DIR = path.join(PROJECT_ROOT, 'src', 'storage', 'thumbnails');
const SNAPSHOTS_DIR = path.join(PROJECT_ROOT, 'snapshots');

// Ensure directory exists
const ensureDir = async (dirPath) => {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

// Generate snapshot timestamp
const generateSnapshotTimestamp = () => {
  const now = new Date();
  return now.toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '-')
    .replace('T', '_')
    .slice(0, 19);
};

// Get all worlds with author information from database
const getAllWorldsWithAuthors = () => {
  try {
    const worlds = db.prepare(`
      SELECT 
        w.id,
        w.name,
        w.description,
        w.thumbnail_file,
        w.content_file,
        w.tags,
        w.downloads,
        w.comment_count,
        w.spoiler,
        w.created_at,
        w.updated_at,
        u.id as author_id,
        u.username as author_username
      FROM worlds w
      JOIN users u ON w.author_id = u.id
      ORDER BY w.created_at DESC
    `).all();
    
    // Process worlds
    return worlds.map(world => ({
      ...world,
      tags: world.tags ? JSON.parse(world.tags) : [],
      spoiler: world.spoiler === 1,
      author: {
        id: world.author_id,
        username: world.author_username
      }
    }));
  } catch (error) {
    throw new Error(`Failed to fetch worlds: ${error.message}`);
  }
};

// Create master metadata JSON
const createMasterMetadata = (worlds) => {
  return {
    generatedAt: new Date().toISOString(),
    version: '1.0.0',
    totalWorlds: worlds.length,
    worlds: worlds.map(world => ({
      id: world.id,
      name: world.name,
      description: world.description,
      tags: world.tags,
      author: {
        id: world.author.id,
        username: world.author.username
      },
      downloads: world.downloads,
      commentCount: world.comment_count,
      spoiler: world.spoiler,
      createdAt: world.created_at,
      updatedAt: world.updated_at,
      folderName: `world-${world.id}`
    }))
  };
};

// Create individual world metadata
const createWorldMetadata = (world) => {
  return {
    id: world.id,
    name: world.name,
    description: world.description,
    tags: world.tags,
    author: {
      id: world.author.id,
      username: world.author.username
    },
    downloads: world.downloads,
    commentCount: world.comment_count,
    spoiler: world.spoiler,
    createdAt: world.created_at,
    updatedAt: world.updated_at,
    files: {
      content: 'content.json',
      thumbnail: 'thumbnail' + path.extname(world.thumbnail_file),
      metadata: 'metadata.json',
      comments: 'comments.json'
    }
  };
};

// Get all comments for a world
const getWorldComments = (worldId) => {
  try {
    const comments = db.prepare(`
      SELECT 
        c.id,
        c.content,
        c.created_at,
        c.updated_at,
        u.id as author_id,
        u.username as author_username
      FROM comments c
      JOIN users u ON c.author_id = u.id
      WHERE c.world_id = ?
      ORDER BY c.created_at ASC
    `).all(worldId);
    
    // Process comments
    return comments.map(comment => ({
      id: comment.id,
      content: comment.content,
      author: {
        id: comment.author_id,
        username: comment.author_username
      },
      createdAt: comment.created_at,
      updatedAt: comment.updated_at
    }));
  } catch (error) {
    console.warn(`Warning: Failed to fetch comments for world ${worldId}:`, error.message);
    return [];
  }
};

// Create world snapshot
const createWorldSnapshot = async (customName = null) => {
  try {
    console.log('Starting world snapshot creation...');
    
    // Ensure snapshots directory exists
    await ensureDir(SNAPSHOTS_DIR);
    
    // Generate snapshot name
    const timestamp = generateSnapshotTimestamp();
    const snapshotName = customName || `worlds-snapshot-${timestamp}`;
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${snapshotName}.zip`);
    
    console.log(`Snapshot will be saved to: ${snapshotPath}`);
    
    // Get all worlds from database
    console.log('Fetching worlds from database...');
    const worlds = getAllWorldsWithAuthors();
    console.log(`Found ${worlds.length} worlds`);
    
    if (worlds.length === 0) {
      console.log('No worlds found in database. Creating empty snapshot.');
    }
    
    // Create write stream for zip
    const output = fs.createWriteStream(snapshotPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    // Track progress
    let processedWorlds = 0;
    let failedWorlds = [];
    
    // Handle archive events
    output.on('close', () => {
      const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
      console.log(`\n✓ Snapshot created successfully: ${snapshotName}.zip`);
      console.log(`  Size: ${sizeInMB} MB`);
      console.log(`  Total worlds: ${worlds.length}`);
      console.log(`  Successfully processed: ${processedWorlds}`);
      if (failedWorlds.length > 0) {
        console.log(`  Failed: ${failedWorlds.length}`);
        console.log(`  Failed worlds:`, failedWorlds.map(f => f.name).join(', '));
      }
    });
    
    archive.on('error', (err) => {
      throw err;
    });
    
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Warning:', err);
      } else {
        throw err;
      }
    });
    
    // Pipe archive to output file
    archive.pipe(output);
    
    // Create master metadata
    console.log('Creating master metadata...');
    const masterMetadata = createMasterMetadata(worlds);
    archive.append(JSON.stringify(masterMetadata, null, 2), { 
      name: 'worlds-metadata.json' 
    });
    
    // Process each world
    console.log('Processing worlds...');
    for (const world of worlds) {
      try {
        const worldFolderName = `world-${world.id}`;
        console.log(`  [${processedWorlds + 1}/${worlds.length}] ${world.name} (${world.id})`);
        
        // Create world metadata
        const worldMetadata = createWorldMetadata(world);
        archive.append(JSON.stringify(worldMetadata, null, 2), {
          name: `${worldFolderName}/metadata.json`
        });
        
        // Add world content file
        try {
          const contentPath = path.join(WORLDS_DIR, world.content_file);
          if (fs.existsSync(contentPath)) {
            const contentData = await readFile(contentPath);
            archive.append(contentData, {
              name: `${worldFolderName}/content.json`
            });
          } else {
            console.warn(`    Warning: Content file not found for ${world.name}`);
            failedWorlds.push({ id: world.id, name: world.name, reason: 'Content file missing' });
          }
        } catch (error) {
          console.warn(`    Warning: Failed to read content for ${world.name}:`, error.message);
          failedWorlds.push({ id: world.id, name: world.name, reason: `Content read error: ${error.message}` });
        }
        
        // Add thumbnail file
        try {
          // Extract just the filename from the path
          const thumbnailFilename = world.thumbnail_file.split('/').pop();
          const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename);
          
          if (fs.existsSync(thumbnailPath)) {
            const thumbnailExt = path.extname(thumbnailFilename);
            const thumbnailData = await readFile(thumbnailPath);
            archive.append(thumbnailData, {
              name: `${worldFolderName}/thumbnail${thumbnailExt}`
            });
          } else {
            console.warn(`    Warning: Thumbnail file not found for ${world.name}`);
            // Don't add to failed list for missing thumbnails as content is more important
          }
        } catch (error) {
          console.warn(`    Warning: Failed to read thumbnail for ${world.name}:`, error.message);
          // Don't add to failed list for thumbnail errors
        }
        
        // Add comments file
        try {
          const comments = getWorldComments(world.id);
          const commentsData = {
            worldId: world.id,
            totalComments: comments.length,
            comments: comments
          };
          archive.append(JSON.stringify(commentsData, null, 2), {
            name: `${worldFolderName}/comments.json`
          });
          if (comments.length > 0) {
            console.log(`    Added ${comments.length} comments`);
          }
        } catch (error) {
          console.warn(`    Warning: Failed to export comments for ${world.name}:`, error.message);
        }
        
        processedWorlds++;
      } catch (error) {
        console.error(`    Error processing world ${world.name}:`, error.message);
        failedWorlds.push({ id: world.id, name: world.name, reason: error.message });
      }
    }
    
    // Add README to explain snapshot structure
    const readmeContent = `# Exotic Dangerous World Snapshot

This snapshot contains all worlds from the Exotic Dangerous World Workshop Server.

## Generated
${new Date().toISOString()}

## Structure

- **worlds-metadata.json** - Master index of all worlds with searchable metadata
- **world-[id]/** - Individual world folders, each containing:
  - **metadata.json** - Full world metadata including author information
  - **content.json** - Complete world data
  - **thumbnail.[ext]** - World thumbnail image
  - **comments.json** - All comments for the world with author information

## Total Worlds
${worlds.length}

## Using This Snapshot

1. Extract the zip file
2. Use worlds-metadata.json to search and filter worlds
3. Access individual world folders to get full world data
4. Each world folder is self-contained with all necessary files

## World Metadata Format

Each world's metadata includes:
- ID, name, and description
- Tags for categorization
- Author information (username, ID)
- Download count and comment count
- Creation and update timestamps
- Spoiler flag

## Importing Worlds

To import worlds from this snapshot back into a server:
1. Read the world metadata
2. Upload the content.json as the world content
3. Upload the thumbnail image
4. Restore author and world metadata
`;
    
    archive.append(readmeContent, { name: 'README.txt' });
    
    // Finalize the archive
    await archive.finalize();
    
    // Wait for output stream to close
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });
    
    return {
      success: true,
      snapshotName: `${snapshotName}.zip`,
      snapshotPath,
      worldCount: worlds.length,
      processedCount: processedWorlds,
      failedCount: failedWorlds.length,
      failedWorlds: failedWorlds.length > 0 ? failedWorlds : undefined
    };
  } catch (error) {
    console.error('Snapshot creation failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Get snapshot information
const getSnapshotInfo = async (snapshotName) => {
  try {
    const snapshotPath = path.join(SNAPSHOTS_DIR, snapshotName);
    
    if (!fs.existsSync(snapshotPath)) {
      return { error: 'Snapshot not found' };
    }
    
    const stats = await stat(snapshotPath);
    
    return {
      name: snapshotName,
      path: snapshotPath,
      size: stats.size,
      sizeInMB: (stats.size / 1024 / 1024).toFixed(2),
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (error) {
    return { error: error.message };
  }
};

// List all snapshots
const listSnapshots = async () => {
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      return [];
    }
    
    const files = fs.readdirSync(SNAPSHOTS_DIR);
    const snapshots = [];
    
    for (const file of files) {
      if (file.endsWith('.zip')) {
        const info = await getSnapshotInfo(file);
        if (!info.error) {
          snapshots.push(info);
        }
      }
    }
    
    // Sort by creation date (newest first)
    snapshots.sort((a, b) => b.created - a.created);
    
    return snapshots;
  } catch (error) {
    console.error('Error listing snapshots:', error);
    return [];
  }
};

// Clean up old snapshots
const cleanupOldSnapshots = async (keepCount = 3) => {
  try {
    const snapshots = await listSnapshots();
    
    if (snapshots.length <= keepCount) {
      console.log(`Found ${snapshots.length} snapshots, keeping all (limit: ${keepCount})`);
      return { removed: 0, kept: snapshots.length };
    }
    
    const toRemove = snapshots.slice(keepCount);
    let removedCount = 0;
    
    for (const snapshot of toRemove) {
      try {
        fs.unlinkSync(snapshot.path);
        console.log(`Removed old snapshot: ${snapshot.name}`);
        removedCount++;
      } catch (error) {
        console.warn(`Warning: Could not remove snapshot ${snapshot.name}:`, error.message);
      }
    }
    
    console.log(`Cleanup complete: removed ${removedCount} old snapshots, kept ${snapshots.length - removedCount}`);
    return { removed: removedCount, kept: snapshots.length - removedCount };
  } catch (error) {
    console.error('Cleanup failed:', error);
    return { error: error.message };
  }
};

module.exports = {
  createWorldSnapshot,
  getSnapshotInfo,
  listSnapshots,
  cleanupOldSnapshots
};
