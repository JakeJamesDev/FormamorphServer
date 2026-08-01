const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Storage directories (configurable — see config/paths)
const {
  WORLDS_DIR: worldsStorageDir,
  THUMBNAILS_DIR: thumbnailsStorageDir,
  AVATARS_DIR: avatarsStorageDir
} = require('../config/paths');

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
  if (!fs.existsSync(avatarsStorageDir)) {
    fs.mkdirSync(avatarsStorageDir, { recursive: true });
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


// The avatar the crop step produces: 256x256, lossless. WebP everywhere the canvas can encode it, PNG on
// a browser that cannot. Nothing else is accepted — the client always re-encodes, so a JPEG or a GIF
// arriving here means something other than the crop dialog sent it.
const ALLOWED_AVATAR_TYPES = {
  webp: 'webp',
  png: 'png'
};

// Maximum stored avatar size in bytes. A lossless 256-square is tens of kilobytes; the cap is a backstop
// against something else being posted at this route, not a limit the crop step can reach.
const MAX_AVATAR_SIZE = 1024 * 1024;

/**
 * Save a profile image, returning its stored filename.
 *
 * A fresh UUID per upload rather than a name derived from the account: the URL is then immutable, so it
 * can be cached forever and a replacement can never be served from a stale cache.
 *
 * @param {string} base64Image - A `data:image/(webp|png);base64,...` URI
 * @returns {Promise<string>} The stored filename
 */
const saveAvatar = async (base64Image) => {
  try {
    const matches = typeof base64Image === 'string'
      && base64Image.match(/^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/);

    if (!matches) {
      throw badRequest('Invalid base64 image string');
    }

    // Extension comes from an allowlist, never from the raw MIME (avoids arbitrary/unsafe types)
    const extension = ALLOWED_AVATAR_TYPES[matches[1].toLowerCase()];
    if (!extension) {
      throw badRequest(`Unsupported avatar type '${matches[1]}' (allowed: webp, png)`);
    }

    const imageData = Buffer.from(matches[2], 'base64');
    if (imageData.length > MAX_AVATAR_SIZE) {
      throw badRequest('Avatar exceeds maximum size of 1MB');
    }

    const filename = `${uuidv4()}.${extension}`;
    await fs.promises.writeFile(path.join(avatarsStorageDir, filename), imageData);

    return filename;
  } catch (error) {
    // Don't log expected client-input rejections (bad/oversized image); only real failures
    if (!error.statusCode) {
      console.error('Error saving avatar:', error);
    }
    throw error;
  }
};

/**
 * Delete a profile image.
 *
 * Never throws: an avatar file that is already gone must not stop the row that pointed at it from being
 * cleared, or the account is left pointing at nothing with no way to fix it.
 *
 * @param {string} fileName - The stored filename
 */
const deleteAvatar = async (fileName) => {
  if (!fileName) return;

  try {
    const filePath = path.join(avatarsStorageDir, path.basename(fileName));
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error('Error deleting avatar:', error);
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
  saveAvatar,
  deleteAvatar,
  worldsStorageDir,
  thumbnailsStorageDir,
  avatarsStorageDir,
  MAX_AVATAR_SIZE
};
