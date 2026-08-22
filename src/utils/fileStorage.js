const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Storage directories (configurable — see config/paths)
const {
  WORLDS_DIR: worldsStorageDir,
  THUMBNAILS_DIR: thumbnailsStorageDir,
  AVATARS_DIR: avatarsStorageDir,
  EVENT_POSTERS_DIR: eventPostersStorageDir
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
  if (!fs.existsSync(eventPostersStorageDir)) {
    fs.mkdirSync(eventPostersStorageDir, { recursive: true });
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


/**
 * Save an uploaded image under a fresh UUID filename, returning that filename.
 *
 * A UUID per upload rather than a name derived from what owns the image: the URL is then immutable, so
 * it can be cached forever and a replacement can never be served from a stale cache.
 *
 * The extension comes from the allowlist, never from the raw MIME, so nothing arbitrary or unsafe can be
 * written; the caps and the allowlist itself are the caller's, because a cropped 256-square avatar and an
 * admin's poster artwork are genuinely different uploads.
 *
 * @param {string} base64Image - A `data:image/<subtype>;base64,...` URI
 * @param {Object} options
 * @param {string} options.directory - Where to write it
 * @param {Object} options.allowedTypes - Lowercase MIME subtype to the extension it is stored under
 * @param {number} options.maxBytes - The largest decoded image accepted
 * @param {string} options.noun - What the type rejection and the log line call it ("avatar", "poster")
 * @param {string} options.oversized - The whole message an image past the cap is refused with
 * @returns {Promise<string>} The stored filename
 */
const saveImageAsset = async (base64Image, { directory, allowedTypes, maxBytes, noun, oversized }) => {
  try {
    const matches = typeof base64Image === 'string'
      && base64Image.match(/^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/);

    if (!matches) {
      throw badRequest('Invalid base64 image string');
    }

    // Null-prototype so a subtype spelling an inherited key ('constructor') cannot pass for an allowed
    // one and be written under whatever that key happens to hold.
    const allowed = Object.assign(Object.create(null), allowedTypes);
    const extension = allowed[matches[1].toLowerCase()];
    if (!extension) {
      const list = [...new Set(Object.values(allowedTypes))].join(', ');
      throw badRequest(`Unsupported ${noun} type '${matches[1]}' (allowed: ${list})`);
    }

    const imageData = Buffer.from(matches[2], 'base64');
    if (imageData.length > maxBytes) {
      throw badRequest(oversized);
    }

    const filename = `${uuidv4()}.${extension}`;
    await fs.promises.writeFile(path.join(directory, filename), imageData);

    return filename;
  } catch (error) {
    // Don't log expected client-input rejections (bad/oversized image); only real failures
    if (!error.statusCode) {
      console.error(`Error saving ${noun}:`, error);
    }
    throw error;
  }
};

/**
 * Delete an uploaded image.
 *
 * Never throws: a file that is already gone must not stop the row that pointed at it from being cleared,
 * or that row is stuck pointing at nothing with no way to fix it.
 *
 * @param {string} fileName - The stored filename
 * @param {Object} options
 * @param {string} options.directory - Where it was written
 * @param {string} options.noun - What a real failure is logged as
 */
const deleteImageAsset = async (fileName, { directory, noun }) => {
  if (!fileName) return;

  try {
    const filePath = path.join(directory, path.basename(fileName));
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error(`Error deleting ${noun}:`, error);
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
 * @param {string} base64Image - A `data:image/(webp|png);base64,...` URI
 * @returns {Promise<string>} The stored filename
 */
const saveAvatar = (base64Image) => saveImageAsset(base64Image, {
  directory: avatarsStorageDir,
  allowedTypes: ALLOWED_AVATAR_TYPES,
  maxBytes: MAX_AVATAR_SIZE,
  noun: 'avatar',
  oversized: 'Avatar exceeds maximum size of 1MB'
});

/**
 * Delete a profile image.
 *
 * @param {string} fileName - The stored filename
 */
const deleteAvatar = (fileName) => deleteImageAsset(fileName, {
  directory: avatarsStorageDir,
  noun: 'avatar'
});

// What an event's poster band may be led with. The same list thumbnails take: this is artwork an admin
// picked off their disk, not something a crop step re-encoded.
const ALLOWED_POSTER_TYPES = ALLOWED_THUMBNAIL_TYPES;

// The largest poster the events routes will store. A band is a strip behind a title, so this is generous
// rather than a target; the admin form refuses the same size before the upload.
const MAX_POSTER_SIZE = 2 * 1024 * 1024;

/**
 * Save an event's poster artwork, returning its stored filename.
 *
 * @param {string} base64Image - A `data:image/(jpeg|png|gif|webp);base64,...` URI
 * @returns {Promise<string>} The stored filename
 */
const saveEventPoster = (base64Image) => saveImageAsset(base64Image, {
  directory: eventPostersStorageDir,
  allowedTypes: ALLOWED_POSTER_TYPES,
  maxBytes: MAX_POSTER_SIZE,
  noun: 'poster',
  oversized: 'Poster image exceeds maximum size of 2MB'
});

/**
 * Delete an event's poster artwork.
 *
 * @param {string} fileName - The stored filename
 */
const deleteEventPoster = (fileName) => deleteImageAsset(fileName, {
  directory: eventPostersStorageDir,
  noun: 'poster'
});

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
  saveEventPoster,
  deleteEventPoster,
  worldsStorageDir,
  thumbnailsStorageDir,
  avatarsStorageDir,
  eventPostersStorageDir,
  MAX_AVATAR_SIZE,
  MAX_POSTER_SIZE
};
