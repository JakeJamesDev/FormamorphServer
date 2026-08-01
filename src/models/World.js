const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { readWorldContent, getThumbnailBase64 } = require('../utils/fileStorage');
const { DEFAULT_KIND, ALL_KINDS } = require('../config/kinds');
const Comment = require('./Comment');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { isStaff } = require('../config/roles');

/**
 * Ceiling for an author listing. High because the question is "everything I published", not "the first
 * page" — the browse catalog is fetched the same way. `getAll`'s `total` reveals if it ever bites.
 */
const AUTHOR_LIST_LIMIT = 1000;

/**
 * World model
 */
const World = {
  /**
   * Find a world by ID
   * @param {string} id - World ID
   * @returns {Object|null} World object or null if not found
   */
  findById: (id) => {
    return db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);
  },

  /**
   * Find a world by ID and populate with author data
   * @param {string} id - World ID
   * @returns {Object|null} World object with author data or null if not found
   */
  findByIdWithAuthor: (id) => {
    const world = World.findById(id);
    
    if (!world) {
      return null;
    }
    
    // Get author data
    const authorRow = db.prepare('SELECT id, username, avatar_file FROM users WHERE id = ?').get(world.author_id);
    const author = authorRow
      ? { id: authorRow.id, username: authorRow.username, avatarUrl: avatarUrlFor(authorRow.avatar_file) }
      : authorRow;
    
    // Parse tags
    world.tags = world.tags ? JSON.parse(world.tags) : [];
    
    // Convert spoiler from INTEGER to boolean
    world.spoiler = world.spoiler === 1;
    
    // Don't include preview_data as it contains megabytes due to thumbnail
    
    // Return world with author but without preview_data
    const { preview_data, ...worldWithoutPreviewData } = world;
    
    // Add thumbnail URL - ensure we're using the correct path
    // The thumbnail_file might contain a full path, so we need to extract just the filename
    const thumbnailFilename = world.thumbnail_file.split('/').pop();
    const thumbnailUrl = `/api/thumbnails/${thumbnailFilename}`;
    
    return {
      ...worldWithoutPreviewData,
      thumbnailUrl,
      author
    };
  },

  /**
   * Find a world by ID and populate with author data and comments
   * @param {string} id - World ID
   * @param {Object} options - Query options for comments
   * @returns {Object|null} World object with author data and comments or null if not found
   */
  findByIdWithAuthorAndComments: (id, options = {}) => {
    const world = World.findByIdWithAuthor(id);
    
    if (!world) {
      return null;
    }
    
    // Get comments for the world
    const commentsResult = Comment.getByWorldId(id, options);
    
    // Add comments to world
    world.comments = commentsResult.comments;
    world.commentCount = commentsResult.total;
    world.commentPagination = commentsResult.pagination;
    
    return world;
  },

  /**
   * Get all worlds with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Object} Object containing worlds, count, and pagination info
   */
  getAll: (options = {}) => {
    try {
      const {
        page = 1,
        limit = 10,
        search = '',
        tags = '',
        searchByAuthor = false,
        authorId = null,
        sort = 'created_at',
        order = 'desc',
        kind = DEFAULT_KIND,
        viewer = null,
        quarantinedOnly = false
      } = options;
      
      // Calculate offset
      const offset = (page - 1) * limit;
      
      // Base query
      let query = 'SELECT w.*, u.username as author_username, u.avatar_file as author_avatar_file FROM worlds w JOIN users u ON w.author_id = u.id';
      let countQuery = 'SELECT COUNT(*) as count FROM worlds w JOIN users u ON w.author_id = u.id';
      let whereClause = [];
      let params = [];

      // Scope to one kind unless every kind was asked for by name. Defaulted rather than optional on
      // purpose: a caller that forgets it gets worlds, never a mixed list — which is what keeps clients
      // written before `kind` existed correct.
      if (kind !== ALL_KINDS) {
        whereClause.push('w.kind = ?');
        params.push(kind);
      }

      // Quarantine visibility. A quarantined listing is hidden from the room but stays visible to the
      // person who published it and to the staff — so what the catalog contains depends on who is
      // asking, and an anonymous visitor is asking as nobody.
      const isStaffViewer = Boolean(viewer && isStaff(viewer));
      if (quarantinedOnly) {
        whereClause.push('w.quarantined_at IS NOT NULL');
      } else if (!isStaffViewer) {
        if (viewer) {
          whereClause.push('(w.quarantined_at IS NULL OR w.author_id = ?)');
          params.push(viewer.id);
        } else {
          whereClause.push('w.quarantined_at IS NULL');
        }
      }

      // Filter by author ID
      if (authorId) {
        whereClause.push('w.author_id = ?');
        params.push(authorId);
      }
      
      // Search by author name
      if (searchByAuthor && search) {
        whereClause.push('u.username LIKE ?');
        params.push(`%${search}%`);
      }
      
      // Search by world name, description, or tags
      if (!searchByAuthor && search) {
        whereClause.push('(w.name LIKE ? OR w.description LIKE ? OR w.tags LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      
      // Filter by tags
      if (tags) {
        const tagList = tags.split(',');
        const tagConditions = tagList.map(tag => `w.tags LIKE ?`);
        whereClause.push(`(${tagConditions.join(' OR ')})`);
        tagList.forEach(tag => params.push(`%${tag}%`));
      }
      
      // Add where clause to queries
      if (whereClause.length > 0) {
        query += ' WHERE ' + whereClause.join(' AND ');
        countQuery += ' WHERE ' + whereClause.join(' AND ');
      }
      
      // Validate sort field to prevent SQL injection
      const validSortFields = ['created_at', 'updated_at', 'downloads', 'name'];
      const sortField = validSortFields.includes(sort) ? sort : 'created_at';
      
      // Validate order direction
      const orderDirection = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      
      // Add order by and limit to main query
      query += ` ORDER BY w.${sortField} ${orderDirection} LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      // Execute queries
      const worlds = db.prepare(query).all(...params);
      const countResult = db.prepare(countQuery).get(...params.slice(0, params.length - 2));
      const total = countResult ? countResult.count : 0;
      
      // Process worlds
      const processedWorlds = worlds.map(world => {
        // Parse tags
        world.tags = world.tags ? JSON.parse(world.tags) : [];
        
        // Convert spoiler from INTEGER to boolean
        world.spoiler = world.spoiler === 1;
        
        // Format author
        world.author = {
          id: world.author_id,
          username: world.author_username,
          avatarUrl: avatarUrlFor(world.author_avatar_file)
        };
        
        // Remove redundant fields
        delete world.author_id;
        delete world.author_username;
        delete world.author_avatar_file;
        delete world.content_file;
        delete world.preview_data; // Don't include preview_data as it contains megabytes due to thumbnail
        
        // Add thumbnail URL - ensure we're using the correct path
        // The thumbnail_file might contain a full path, so we need to extract just the filename
        const thumbnailFilename = world.thumbnail_file.split('/').pop();
        world.thumbnailUrl = `/api/thumbnails/${thumbnailFilename}`;
        
        return world;
      });
      
      // Calculate pagination
      const pagination = {};
      
      if (offset + limit < total) {
        pagination.next = {
          page: page + 1,
          limit
        };
      }
      
      if (page > 1) {
        pagination.prev = {
          page: page - 1,
          limit
        };
      }
      
      return {
        worlds: processedWorlds,
        count: processedWorlds.length,
        pagination,
        total
      };
    } catch (error) {
      throw error;
    }
  },

  /**
   * Create a new world
   * @param {Object} worldData - World data
   * @param {string} contentFile - Content file name
   * @param {string} thumbnailFile - Thumbnail file name
   * @returns {Object} Created world object
   */
  create: (worldData, contentFile, thumbnailFile) => {
    try {
      // Generate UUID for world ID
      const worldId = worldData.id || uuidv4();
      
      // Ensure tags is an array before stringifying
      let tags = [];
      if (worldData.tags) {
        if (Array.isArray(worldData.tags)) {
          tags = worldData.tags;
          console.log('World.create - Tags is an array:', tags);
        } else if (typeof worldData.tags === 'string') {
          // Try to parse if it's a JSON string
          try {
            const parsedTags = JSON.parse(worldData.tags);
            tags = Array.isArray(parsedTags) ? parsedTags : [];
            console.log('World.create - Tags parsed from JSON string:', tags);
          } catch (e) {
            // If parsing fails, treat as a single tag
            tags = [worldData.tags];
            console.log('World.create - Tags as single string tag:', tags);
          }
        }
      }
      
      // Stringify the tags array for storage
      const tagsString = JSON.stringify(tags);
      console.log('World.create - Final tags string for storage:', tagsString);
      
      // Parse preview data if it's a string
      const previewData = typeof worldData.preview_data === 'string'
        ? worldData.preview_data
        : JSON.stringify(worldData.preview_data || {});
      
      // Insert world into database
      db.prepare(`
        INSERT INTO worlds (
          id, name, description, author_id, thumbnail_file,
          preview_data, content_file, tags, comment_count, spoiler, kind
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        worldId,
        worldData.name,
        worldData.description,
        worldData.author_id,
        thumbnailFile,
        previewData,
        contentFile,
        tagsString,
        0, // Initialize comment_count to 0
        worldData.spoiler ? 1 : 0, // Convert boolean to INTEGER (0 or 1)
        worldData.kind || DEFAULT_KIND
      );
      
      // Return created world
      return World.findById(worldId);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Update a world
   * @param {string} id - World ID
   * @param {Object} worldData - World data to update
   * @returns {Object} Updated world object
   */
  update: (id, worldData) => {
    try {
      // Update timestamp
      worldData.updated_at = new Date().toISOString();
      
      // Handle tags properly
      if (worldData.tags !== undefined) {
        // Ensure tags is an array before stringifying
        let tags = [];
        if (worldData.tags) {
          if (Array.isArray(worldData.tags)) {
            tags = worldData.tags;
            console.log('World.update - Tags is an array:', tags);
          } else if (typeof worldData.tags === 'string') {
            // Try to parse if it's a JSON string
            try {
              const parsedTags = JSON.parse(worldData.tags);
              tags = Array.isArray(parsedTags) ? parsedTags : [];
              console.log('World.update - Tags parsed from JSON string:', tags);
            } catch (e) {
              // If parsing fails, treat as a single tag
              tags = [worldData.tags];
              console.log('World.update - Tags as single string tag:', tags);
            }
          }
        }
        
        // Stringify the tags array for storage
        worldData.tags = JSON.stringify(tags);
        console.log('World.update - Final tags string for storage:', worldData.tags);
      }
      
      // Parse preview data if it's an object
      if (worldData.preview_data && typeof worldData.preview_data === 'object') {
        worldData.preview_data = JSON.stringify(worldData.preview_data);
      }
      
      // Build update query
      const fields = Object.keys(worldData).filter(key => key !== 'id');
      const placeholders = fields.map(field => `${field} = ?`).join(', ');
      const values = fields.map(field => worldData[field]);
      
      // Add ID to values
      values.push(id);
      
      // Update world in database
      db.prepare(`
        UPDATE worlds
        SET ${placeholders}
        WHERE id = ?
      `).run(...values);
      
      // Return updated world
      return World.findById(id);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Whether this viewer may see a quarantined listing at all.
   *
   * The room sees nothing: to everyone else a quarantined listing is as absent as a deleted one, which is
   * the point — it is out of circulation while its author fixes it, not merely flagged.
   *
   * @param {Object} world - The world row
   * @param {Object} [viewer] - The signed-in user, or null for an anonymous visitor
   * @returns {boolean} True when it may be shown
   */
  isVisibleTo: (world, viewer = null) => {
    if (!world) return false;
    if (!world.quarantined_at) return true;
    if (!viewer) return false;

    return isStaff(viewer) || world.author_id === viewer.id;
  },

  /**
   * Put a listing into quarantine, or move its deadline.
   *
   * Starting a quarantine clears the extension flag: each episode carries its own one-time grace, so a
   * listing quarantined again months later is not punished for an unrelated incident.
   *
   * @param {string} id - World ID
   * @param {number} days - How long the author has before it is deleted
   * @returns {Object|undefined} The updated row
   */
  quarantine: (id, days) => {
    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    db.prepare(`
      UPDATE worlds
      SET quarantined_at = ?, quarantine_expires_at = ?, quarantine_extended = 0
      WHERE id = ?
    `).run(now.toISOString(), expires.toISOString(), id);

    return World.findById(id);
  },

  /**
   * Lift a quarantine, returning the listing to the catalog exactly as it was.
   * @param {string} id - World ID
   * @returns {Object|undefined} The updated row
   */
  release: (id) => {
    db.prepare(`
      UPDATE worlds
      SET quarantined_at = NULL, quarantine_expires_at = NULL, quarantine_extended = 0
      WHERE id = ?
    `).run(id);

    return World.findById(id);
  },

  /**
   * Give a quarantined listing its one-time extension, counted from the deadline it already had.
   *
   * Once per episode, on the first update the author makes: the point is that somebody who fixes their
   * world on day six is not deleted on day seven, not that editing repeatedly buys forever.
   *
   * @param {string} id - World ID
   * @param {number} days - How much longer to allow
   * @returns {Object|undefined} The updated row, unchanged when the grace was already used
   */
  extendQuarantine: (id, days) => {
    const world = World.findById(id);
    if (!world || !world.quarantined_at || world.quarantine_extended) return world;

    const from = new Date(world.quarantine_expires_at);
    const extended = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

    db.prepare('UPDATE worlds SET quarantine_expires_at = ?, quarantine_extended = 1 WHERE id = ?')
      .run(extended.toISOString(), id);

    return World.findById(id);
  },

  /**
   * Every quarantined listing whose deadline has passed, with its author's name for the log entry.
   *
   * Compared as raw ISO strings rather than through `datetime()`, which truncates to whole seconds — the
   * same trap the unread badge had to work around.
   *
   * @param {string} [now] - The instant to compare against, for tests
   * @returns {Array<Object>} The rows due for deletion
   */
  expiredQuarantines: (now = new Date().toISOString()) => db.prepare(`
    SELECT w.*, u.username AS author_username
    FROM worlds w
    LEFT JOIN users u ON u.id = w.author_id
    WHERE w.quarantined_at IS NOT NULL
      AND w.quarantine_expires_at IS NOT NULL
      AND w.quarantine_expires_at <= ?
  `).all(now),

  /**
   * Delete a world
   * @param {string} id - World ID
   * @returns {boolean} True if world was deleted successfully
   */
  delete: (id) => {
    try {
      // Delete world from database
      const result = db.prepare('DELETE FROM worlds WHERE id = ?').run(id);
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Increment download count for a world
   * @param {string} id - World ID
   * @returns {number} New download count
   */
  incrementDownloads: (id) => {
    try {
      // Update download count only, not updated_at
      db.prepare(`
        UPDATE worlds
        SET downloads = downloads + 1
        WHERE id = ?
      `).run(id);
      
      // Get updated world
      const world = World.findById(id);
      
      return world ? world.downloads : 0;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Update spoiler status for a world without updating the updated_at timestamp
   * @param {string} id - World ID
   * @param {boolean} spoiler - Spoiler status
   * @returns {Object} Updated world object
   */
  updateSpoilerStatus: (id, spoiler) => {
    try {
      // Update spoiler status only, not updated_at
      db.prepare(`
        UPDATE worlds
        SET spoiler = ?
        WHERE id = ?
      `).run(spoiler ? 1 : 0, id);
      
      // Return updated world
      return World.findById(id);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Get an author's rows of one kind (or every kind, with `ALL_KINDS`).
   *
   * An author listing answers "what have I published" — it wants everything, not a first page, since
   * callers like the publish dialog offer each row as an overwrite target. `getAll` always applies a
   * LIMIT, so `AUTHOR_LIST_LIMIT` is a ceiling rather than a page size; the caller can pass its own, and
   * the returned `total` tells it whether the ceiling actually cut anything off.
   *
   * @param {string} authorId - Author ID
   * @param {string} kind - Kind to list; defaults to worlds, as the list endpoints do
   * @param {number} limit - Row ceiling
   * @returns {Object} `{ worlds, total, pagination }` from getAll
   */
  getByAuthor: (authorId, kind = DEFAULT_KIND, limit = AUTHOR_LIST_LIMIT) => {
    try {
      return World.getAll({ authorId, kind, limit });
    } catch (error) {
      throw error;
    }
  },

  /**
   * Get world content
   * @param {string} id - World ID
   * @returns {Object} World content
   */
  getContent: async (id) => {
    try {
      // Get world
      const world = World.findByIdWithAuthor(id);
      
      if (!world) {
        throw new Error('World not found');
      }
      
      // Read content from file
      const contentData = await readWorldContent(world.content_file);
      
      // Get thumbnail as base64
      const thumbnail = await getThumbnailBase64(world.thumbnail_file);
      
      // Return world with content
      return {
        ...world,
        thumbnail,
        contentData
      };
    } catch (error) {
      throw error;
    }
  }
};

module.exports = World;
