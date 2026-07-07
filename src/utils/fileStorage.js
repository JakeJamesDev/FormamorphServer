const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Define storage directories
const worldsStorageDir = path.join(__dirname, '..', 'storage', 'worlds');
const thumbnailsStorageDir = path.join(__dirname, '..', 'storage', 'thumbnails');

// Maximum world content size in bytes (200MB)
const MAX_CONTENT_SIZE = 200 * 1024 * 1024;

// Maximum thumbnail size in bytes (5MB)
const MAX_THUMBNAIL_SIZE = 5 * 1024 * 1024;

// Allowed thumbnail image types, mapped to their stored file extension
const ALLOWED_THUMBNAIL_TYPES = {
  jpeg: 'jpeg',
  jpg: 'jpeg',
  png: 'png',
  gif: 'gif',
  webp: 'webp'
};

// Client-input error tagged so the error handler returns 400, not 500
const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};

// Ensure storage directories exist
const initStorage = () => {
  if (!fs.existsSync(worldsStorageDir)) {
    fs.mkdirSync(worldsStorageDir, { recursive: true });
  }
  if (!fs.existsSync(thumbnailsStorageDir)) {
    fs.mkdirSync(thumbnailsStorageDir, { recursive: true });
  }
};

// Save world content to a file
const saveWorldContent = async (worldId, content) => {
  try {
    const filePath = path.join(worldsStorageDir, `${worldId}.json`);
    
    // Convert content to JSON string
    const contentString = JSON.stringify(content);
    
    // Check if content size exceeds the limit
    if (Buffer.byteLength(contentString) > MAX_CONTENT_SIZE) {
      throw new Error(`World content exceeds maximum size of 200MB`);
    }
    
    // Use a more memory-efficient approach for large files
    await fs.promises.writeFile(filePath, contentString);
    return `${worldId}.json`;
  } catch (error) {
    console.error('Error saving world content:', error);
    throw error;
  }
};

// Save thumbnail image to a file
const saveThumbnail = async (base64Image) => {
  try {
    // Parse a base64 image data-URI (data:image/<subtype>;base64,<data>)
    const matches = typeof base64Image === 'string'
      && base64Image.match(/^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/);

    if (!matches) {
      throw badRequest('Invalid base64 image string');
    }

    // Extension comes from an allowlist, never from the raw MIME (avoids arbitrary/unsafe types)
    const extension = ALLOWED_THUMBNAIL_TYPES[matches[1].toLowerCase()];
    if (!extension) {
      throw badRequest(`Unsupported thumbnail type '${matches[1]}' (allowed: jpeg, png, gif, webp)`);
    }

    const imageData = Buffer.from(matches[2], 'base64');
    if (imageData.length > MAX_THUMBNAIL_SIZE) {
      throw badRequest('Thumbnail exceeds maximum size of 5MB');
    }

    // Generate a unique filename
    const filename = `${uuidv4()}.${extension}`;
    const filePath = path.join(thumbnailsStorageDir, filename);

    // Write the image file
    await fs.promises.writeFile(filePath, imageData);

    return filename;
  } catch (error) {
    // Don't log expected client-input rejections (bad/oversized image); only real failures
    if (!error.statusCode) {
      console.error('Error saving thumbnail:', error);
    }
    throw error;
  }
};

// Read world content from a file
const readWorldContent = async (fileName) => {
  try {
    const filePath = path.join(worldsStorageDir, fileName);
    
    // Use a stream-based approach for reading large files
    const content = await fs.promises.readFile(filePath, {
      encoding: 'utf8',
      flag: 'r'
    });
    
    return JSON.parse(content);
  } catch (error) {
    console.error('Error reading world content:', error);
    throw new Error('Failed to read world content file');
  }
};

// Get thumbnail as base64 string (for API responses)
const getThumbnailBase64 = async (fileName) => {
  try {
    const filePath = path.join(thumbnailsStorageDir, fileName);
    const imageBuffer = await fs.promises.readFile(filePath);
    
    // Determine the MIME type based on file extension
    const ext = path.extname(fileName).toLowerCase();
    let mimeType = 'image/jpeg'; // Default
    
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.webp') mimeType = 'image/webp';
    
    return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  } catch (error) {
    console.error('Error getting thumbnail:', error);
    throw new Error('Failed to read thumbnail file');
  }
};

// Delete world content file
const deleteWorldContent = async (fileName) => {
  try {
    const filePath = path.join(worldsStorageDir, fileName);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error('Error deleting world content:', error);
    throw new Error('Failed to delete world content file');
  }
};

// Delete thumbnail file
const deleteThumbnail = async (fileName) => {
  try {
    const filePath = path.join(thumbnailsStorageDir, fileName);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error('Error deleting thumbnail:', error);
    throw new Error('Failed to delete thumbnail file');
  }
};

module.exports = {
  initStorage,
  saveWorldContent,
  saveThumbnail,
  readWorldContent,
  getThumbnailBase64,
  deleteWorldContent,
  deleteThumbnail,
  worldsStorageDir,
  thumbnailsStorageDir
};
