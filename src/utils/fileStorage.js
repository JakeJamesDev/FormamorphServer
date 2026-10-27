const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Storage directories (configurable — see config/paths)
const {
  WORLDS_DIR: worldsStorageDir,
  THUMBNAILS_DIR: thumbnailsStorageDir,
  PENDING_DIR: pendingStorageDir,
  AVATARS_DIR: avatarsStorageDir,
  EVENT_POSTERS_DIR: eventPostersStorageDir,
  SUPPORTER_PRIVATE_DIR: supporterStorageDir
} = require('../config/paths');

// Maximum world content size in bytes (100MB)
const MAX_CONTENT_SIZE = 100 * 1024 * 1024;

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

// Served type per stored extension — shared by the route and the base64 path so the two cannot drift.
const THUMBNAIL_CONTENT_TYPES = Object.assign(Object.create(null), {
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
});

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
  if (!fs.existsSync(pendingStorageDir)) {
    fs.mkdirSync(pendingStorageDir, { recursive: true });
  }
  if (!fs.existsSync(avatarsStorageDir)) {
    fs.mkdirSync(avatarsStorageDir, { recursive: true });
  }
  if (!fs.existsSync(eventPostersStorageDir)) {
    fs.mkdirSync(eventPostersStorageDir, { recursive: true });
  }
  fs.mkdirSync(supporterStorageDir, { recursive: true });
};

// Save world content to a file
const saveWorldContent = async (worldId, content) => {
  try {
    const filePath = path.join(worldsStorageDir, `${worldId}.json`);
    
    // Convert content to JSON string
    const contentString = JSON.stringify(content);
    
    // Check if content size exceeds the limit
    if (Buffer.byteLength(contentString) > MAX_CONTENT_SIZE) {
      throw new Error(`World content exceeds maximum size of 100MB`);
    }
    
    // Use a more memory-efficient approach for large files
    await fs.promises.writeFile(filePath, contentString);
    return `${worldId}.json`;
  } catch (error) {
    console.error('Error saving world content:', error);
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

/**
 * A stored thumbnail as a data-URI, or null when the file is gone or its extension names no served type
 * — the listing around a lost file stays readable, and a type is never guessed.
 *
 * @param {string} fileName - The stored filename
 * @returns {Promise<string|null>} `data:image/<type>;base64,...`, or null
 */
const getThumbnailBase64 = async (fileName) => {
  const mimeType = fileName && THUMBNAIL_CONTENT_TYPES[path.extname(fileName).toLowerCase()];
  if (!mimeType) return null;

  try {
    const imageBuffer = await fs.promises.readFile(path.join(thumbnailsStorageDir, fileName));

    return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  } catch (error) {
    // A row outliving its file is ordinary; anything else is a real failure.
    if (error.code !== 'ENOENT') {
      console.error('Error getting thumbnail:', error);
    }
    return null;
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

/**
 * Save a listing's thumbnail, returning its stored filename.
 *
 * @param {string} base64Image - A `data:image/(jpeg|jpg|png|gif|webp);base64,...` URI
 * @returns {Promise<string>} The stored filename
 */
const saveThumbnail = (base64Image) => saveImageAsset(base64Image, {
  directory: thumbnailsStorageDir,
  allowedTypes: ALLOWED_THUMBNAIL_TYPES,
  maxBytes: MAX_THUMBNAIL_SIZE,
  noun: 'thumbnail',
  oversized: 'Thumbnail exceeds maximum size of 5MB'
});

/**
 * Delete a listing's thumbnail.
 *
 * @param {string} fileName - The stored filename
 */
const deleteThumbnail = (fileName) => deleteImageAsset(fileName, {
  directory: thumbnailsStorageDir,
  noun: 'thumbnail'
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

/**
 * Save a pending update's content under a fresh name in the pending directory.
 *
 * Never `${worldId}.json`: that is the live file's name, and a pending copy under it would be served.
 *
 * @param {Object} content - The world content
 * @returns {Promise<string>} The stored filename
 */
const savePendingContent = async (content) => {
  const contentString = JSON.stringify(content);
  if (Buffer.byteLength(contentString) > MAX_CONTENT_SIZE) {
    throw new Error('World content exceeds maximum size of 100MB');
  }

  const fileName = `${uuidv4()}.json`;
  await fs.promises.writeFile(path.join(pendingStorageDir, fileName), contentString);
  return fileName;
};

/**
 * Read a pending update's content.
 *
 * @param {string} fileName - The stored filename
 * @returns {Promise<Object>} The parsed content
 */
const readPendingContent = async (fileName) =>
  JSON.parse(await fs.promises.readFile(path.join(pendingStorageDir, path.basename(fileName)), 'utf8'));

/**
 * Save a pending update's thumbnail in the pending directory, returning its stored filename.
 *
 * @param {string} base64Image - A `data:image/(jpeg|jpg|png|gif|webp);base64,...` URI
 * @returns {Promise<string>} The stored filename
 */
const savePendingThumbnail = (base64Image) => saveImageAsset(base64Image, {
  directory: pendingStorageDir,
  allowedTypes: ALLOWED_THUMBNAIL_TYPES,
  maxBytes: MAX_THUMBNAIL_SIZE,
  noun: 'thumbnail',
  oversized: 'Thumbnail exceeds maximum size of 5MB'
});

/**
 * Delete a pending update's file. Reaches only the pending directory, so it can never remove a live file.
 *
 * @param {string} fileName - The stored filename
 */
const deletePendingFile = (fileName) => deleteImageAsset(fileName, {
  directory: pendingStorageDir,
  noun: 'pending file'
});

/**
 * Whether every file a pending update names is still in the pending directory.
 *
 * @param {Object} update - A row carrying `content_file` and `thumbnail_file`
 * @returns {boolean} True when none is missing
 */
const pendingFilesExist = (update) => [update.content_file, update.thumbnail_file]
  .filter(Boolean)
  .every((fileName) => fs.existsSync(path.join(pendingStorageDir, path.basename(fileName))));

/**
 * Move an approved update's files over the live ones. Synchronous, so no request reads the listing
 * between the row change and the file change.
 *
 * @param {Object} files - `{ content, contentTarget, thumbnail }`; `content` replaces the live file named
 *   `contentTarget`, and `thumbnail` moves into the thumbnails directory under its own name
 */
const promotePendingFiles = ({ content, contentTarget, thumbnail }) => {
  if (content) {
    fs.renameSync(path.join(pendingStorageDir, path.basename(content)), path.join(worldsStorageDir, path.basename(contentTarget)));
  }
  if (thumbnail) {
    fs.renameSync(path.join(pendingStorageDir, path.basename(thumbnail)), path.join(thumbnailsStorageDir, path.basename(thumbnail)));
  }
};

// A name inside `directory`; basename strips any traversal segment.
const storedPath = (directory, fileName) => path.join(directory, path.basename(fileName));

// A stored file under `directory`, or null when it is gone.
const readStored = async (directory, fileName) => {
  try {
    return await fs.promises.readFile(storedPath(directory, fileName));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

// A read stream over a stored file, or null when it is gone.
const openStored = (directory, fileName) => {
  const filePath = storedPath(directory, fileName);
  return fs.existsSync(filePath) ? fs.createReadStream(filePath) : null;
};

/** A listing's content file as raw bytes, or null when it is gone. */
const readWorldContentBytes = (fileName) => readStored(worldsStorageDir, fileName);

/** A listing's thumbnail as raw bytes, or null when it is gone. */
const readThumbnailBytes = (fileName) => readStored(thumbnailsStorageDir, fileName);

/** A pending update's file as raw bytes, or null when it is gone. */
const readPendingBytes = (fileName) => readStored(pendingStorageDir, fileName);

/** A listing's content parsed, or null when it is gone or unreadable. Synchronous, for migrations. */
const readWorldContentSync = (fileName) => {
  try {
    return JSON.parse(fs.readFileSync(storedPath(worldsStorageDir, fileName), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Whether a stored thumbnail holds exactly these bytes. A missing file holds nothing.
 *
 * @param {string} fileName - The stored filename
 * @param {Buffer} expected - The bytes to compare with
 * @returns {boolean} True on a byte-for-byte match
 */
const thumbnailEquals = (fileName, expected) => {
  const filePath = storedPath(thumbnailsStorageDir, fileName);

  try {
    // The size first, so a listing with real art is never read in full.
    return fs.statSync(filePath).size === expected.length && fs.readFileSync(filePath).equals(expected);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

/** Read streams for the public image routes; each is null when the file is gone. */
const openThumbnail = (fileName) => openStored(thumbnailsStorageDir, fileName);
const openAvatar = (fileName) => openStored(avatarsStorageDir, fileName);
const openEventPoster = (fileName) => openStored(eventPostersStorageDir, fileName);

/**
 * The private Supporter area. No route serves its directory, so a file here leaves the server only
 * through a route that reads it by name. Keys are flat file names; basename strips traversal.
 */
const saveSupporterFile = async (fileName, data) => {
  const name = path.basename(fileName);
  await fs.promises.writeFile(path.join(supporterStorageDir, name), data);
  return name;
};

/** A private Supporter file as raw bytes, or null when it is gone. */
const readSupporterFile = (fileName) => readStored(supporterStorageDir, fileName);

/** Delete a private Supporter file. Never throws on a file that is already gone. */
const deleteSupporterFile = (fileName) => deleteImageAsset(fileName, {
  directory: supporterStorageDir,
  noun: 'supporter file'
});

/** Whether a private Supporter file exists. */
const supporterFileExists = (fileName) =>
  fs.existsSync(storedPath(supporterStorageDir, fileName));

module.exports = {
  initStorage,
  readWorldContentBytes,
  readThumbnailBytes,
  readPendingBytes,
  readWorldContentSync,
  thumbnailEquals,
  openThumbnail,
  openAvatar,
  openEventPoster,
  saveSupporterFile,
  readSupporterFile,
  deleteSupporterFile,
  supporterFileExists,
  supporterStorageDir,
  savePendingContent,
  readPendingContent,
  savePendingThumbnail,
  deletePendingFile,
  pendingFilesExist,
  promotePendingFiles,
  pendingStorageDir,
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
  MAX_POSTER_SIZE,
  THUMBNAIL_CONTENT_TYPES
};
