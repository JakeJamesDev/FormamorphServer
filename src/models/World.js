const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { readWorldContent, getThumbnailBase64 } = require('../utils/fileStorage');
const { DEFAULT_KIND, ALL_KINDS } = require('../config/kinds');
const { DEFAULT_VISIBILITY, PUBLIC, UNLISTED } = require('../config/relationships');
const Comment = require('./Comment');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { isStaff, badgeRole } = require('../config/roles');

/**
 * Ceiling for an author listing. High because the question is "everything I published", not "the first
 * page" — the browse catalog is fetched the same way. `getAll`'s `total` reveals if it ever bites.
 */
const AUTHOR_LIST_LIMIT = 1000;

/**
 * Ceiling for a staff like list, in either direction. Enough to read a burst; a viral listing's full
 * roll would turn the endpoint into a table dump. The list's `total` says when it bites.
 */
const LIKE_LIST_LIMIT = 500;

/**
 * Orders the catalog may be asked for. A whitelist: the value is interpolated into the ORDER BY.
 *
 * Maps to the expression rather than a bare name, because `likes` is computed on the select and carries
 * no `w.` prefix. Null-prototyped like every other sort whitelist here — a plain object answers to
 * `constructor` and `toString`, which would put a function's source into the query and 500 the request.
 */
const SORT_EXPRESSIONS = Object.assign(Object.create(null), {
  created_at: 'w.created_at',
  updated_at: 'w.updated_at',
  downloads: 'w.downloads',
  name: 'w.name',
  likes: 'like_count'
});

/**
 * World model
 */
/**
 * An Avatar's stored license terms, or null for a row that has none.
 *
 * A row written before a shape change, or by hand, could hold text that is not JSON; that reads as "no
 * terms" rather than failing the whole listing read.
 *
 * @param {string|null} stored - The `model_license` column
 * @returns {Object|null} The parsed terms
 */
const parseModelLicense = (stored) => {
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
};

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
  findByIdWithAuthor: (id, viewer = null) => {
    const world = World.findById(id);

    if (!world) {
      return null;
    }

    // The same pair the catalog rows carry, so a listing read on its own says the same thing as the card
    // it was opened from. `liked` is absent rather than false without a reader — see `getAll`.
    world.likes = World.likeCount(id);
    if (viewer) world.liked = World.hasLiked(id, viewer.id);

    // Get author data
    const authorRow = db.prepare('SELECT id, username, avatar_file, account_type FROM users WHERE id = ?').get(world.author_id);
    // Live rather than snapshotted, unlike a feedback reply: a reply is a record of who said something
    // at a moment, but a listing's author badge says who they are now.
    const author = authorRow
      ? {
        id: authorRow.id,
        username: authorRow.username,
        avatarUrl: avatarUrlFor(authorRow.avatar_file),
        role: badgeRole(authorRow.account_type)
      }
      : authorRow;
    
    // Parse tags
    world.tags = world.tags ? JSON.parse(world.tags) : [];
    
    // Convert spoiler from INTEGER to boolean
    world.spoiler = world.spoiler === 1;

    // An Avatar's own license terms, which only a listing opened on its own ever shows. Absent rather
    // than null for every other kind, so a reader has nothing to render instead of an empty object.
    const modelLicense = parseModelLicense(world.model_license);
    delete world.model_license;
    
    // Add thumbnail URL - ensure we're using the correct path
    // The thumbnail_file might contain a full path, so we need to extract just the filename
    const thumbnailFilename = world.thumbnail_file.split('/').pop();
    const thumbnailUrl = `/api/thumbnails/${thumbnailFilename}`;

    return {
      ...world,
      ...(modelLicense ? { modelLicense } : {}),
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
  findByIdWithAuthorAndComments: (id, options = {}, viewer = null) => {
    const world = World.findByIdWithAuthor(id, viewer);
    
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
        viewer = null
      } = options;
      
      // Calculate offset
      const offset = (page - 1) * limit;
      
      // Base query
      // `like_count` is counted per row rather than kept as a column beside `downloads`: the catalog is
      // sortable by it, and a denormalized counter that drifts would rank the whole catalog wrongly rather
      // than merely display one bad number. Takes no parameter, so it can sit ahead of the WHERE clause
      // without disturbing the positional params below.
      let query = `SELECT w.*, u.username as author_username, u.avatar_file as author_avatar_file, u.account_type as author_account_type,
        (SELECT COUNT(*) FROM world_likes l WHERE l.world_id = w.id) AS like_count
        FROM worlds w JOIN users u ON w.author_id = u.id`;
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

      // Quarantine and unlisted visibility. Both hide a listing from the room while leaving it visible to
      // the person who published it and to the staff — so what the catalog contains depends on who is
      // asking, and an anonymous visitor is asking as nobody. One clause for both, because the answer
      // for each is the same pair of people.
      const isStaffViewer = Boolean(viewer && isStaff(viewer));
      if (!isStaffViewer) {
        if (viewer) {
          whereClause.push("((w.quarantined_at IS NULL AND w.visibility = 'public') OR w.author_id = ?)");
          params.push(viewer.id);
        } else {
          whereClause.push("w.quarantined_at IS NULL AND w.visibility = 'public'");
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
      
      // An unknown sort falls back to newest-first, which is what an unsorted catalog has always shown.
      const sortExpression = SORT_EXPRESSIONS[sort] || SORT_EXPRESSIONS.created_at;

      // Validate order direction
      const orderDirection = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      // Add order by and limit to main query
      query += ` ORDER BY ${sortExpression} ${orderDirection} LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      // Execute queries
      const worlds = db.prepare(query).all(...params);
      const countResult = db.prepare(countQuery).get(...params.slice(0, params.length - 2));
      const total = countResult ? countResult.count : 0;

      // One query for the whole page rather than a correlated subquery carrying a parameter into the
      // select list, which would have to sit ahead of every positional param the WHERE clause appends.
      const likedIds = viewer ? World.likedAmong(worlds.map(w => w.id), viewer.id) : new Set();

      // Process worlds
      const processedWorlds = worlds.map(world => {
        // Parse tags
        world.tags = world.tags ? JSON.parse(world.tags) : [];
        
        // Convert spoiler from INTEGER to boolean
        world.spoiler = world.spoiler === 1;

        // How many liked it, and whether this reader is one of them. `liked` is absent rather than false
        // for a signed-out visitor: somebody with no account has not decided against liking anything, and
        // the heart should be a number rather than a control they cannot press.
        world.likes = world.like_count || 0;
        delete world.like_count;
        if (viewer) world.liked = likedIds.has(world.id);

        // Format author
        world.author = {
          id: world.author_id,
          username: world.author_username,
          avatarUrl: avatarUrlFor(world.author_avatar_file),
          role: badgeRole(world.author_account_type)
        };

        // Remove redundant fields
        delete world.author_id;
        delete world.author_username;
        delete world.author_avatar_file;
        delete world.author_account_type;
        delete world.content_file;
        // A page of cards shows no license terms, so it does not carry any — the column exists for the
        // one listing a reader opens.
        delete world.model_license;

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
      
      // The two timestamps are written rather than left to the column default. `CURRENT_TIMESTAMP` is
      // whole seconds in SQLite's own format, while every update writes ISO with milliseconds — one
      // column in two formats, which orders by where a space sorts against a `T` rather than by time.
      // A listing published in the same second a follower read their feed was invisible to them.
      const now = new Date().toISOString();

      // Insert world into database
      db.prepare(`
        INSERT INTO worlds (
          id, name, description, author_id, thumbnail_file,
          content_file, tags, comment_count, spoiler, kind,
          model_license, contest_event_id, visibility, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        worldId,
        worldData.name,
        worldData.description,
        worldData.author_id,
        thumbnailFile,
        contentFile,
        tagsString,
        0, // Initialize comment_count to 0
        worldData.spoiler ? 1 : 0, // Convert boolean to INTEGER (0 or 1)
        worldData.kind || DEFAULT_KIND,
        // The Avatar terms a reader is shown, as JSON. Null for every other kind, which has none.
        worldData.model_license || null,
        // Written here and nowhere else. Entering happens at publish, so nothing ever moves a listing
        // from one contest into another, and the entry date is simply the publish date.
        worldData.contest_event_id || null,
        worldData.visibility || DEFAULT_VISIBILITY,
        now,
        now
      );
      
      // Return created world
      return World.findById(worldId);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Update a world. Every call bumps the revision, because every caller is changing what a downloader
   * receives; a change that is not (visibility, spoiler) has a writer of its own that leaves it alone.
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
      
      // Build update query
      const fields = Object.keys(worldData).filter(key => key !== 'id');
      const placeholders = [...fields.map(field => `${field} = ?`), 'revision = revision + 1'].join(', ');
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
   * Whether this viewer may see a quarantined or unlisted listing at all.
   *
   * The room sees nothing: to everyone else a hidden listing is as absent as a deleted one. For a
   * quarantine that is the point — it is out of circulation while its author fixes it, not merely
   * flagged. For an unlisted listing it is what keeps a component reachable only through a world that
   * requires it; `isDependencyVisibleTo` is that one other path.
   *
   * @param {Object} world - The world row
   * @param {Object} [viewer] - The signed-in user, or null for an anonymous visitor
   * @returns {boolean} True when it may be shown
   */
  isVisibleTo: (world, viewer = null) => {
    if (!world) return false;
    if (!world.quarantined_at && world.visibility !== UNLISTED) return true;
    if (!viewer) return false;

    return isStaff(viewer) || world.author_id === viewer.id;
  },

  /**
   * Whether this viewer may receive a listing as a required dependency of a world they can read.
   *
   * Unlisted stops mattering: that is the whole of what unlisted permits. Quarantine still applies, as
   * it does everywhere — a quarantined source is out of circulation by whichever door it is reached.
   *
   * @param {Object} source - The source row
   * @param {Object} [viewer] - The signed-in user, or null for an anonymous visitor
   * @returns {boolean} True when it may be served
   */
  isDependencyVisibleTo: (source, viewer = null) =>
    Boolean(source) && World.isVisibleTo({ ...source, visibility: PUBLIC }, viewer),

  /**
   * Change how a listing is shown, leaving its revision and its date alone: nothing a downloader receives
   * has changed, so a client comparing revisions must not be told it has.
   *
   * @param {string} id - World ID
   * @param {string} visibility - One of `VISIBILITIES`
   * @returns {Object|undefined} The updated row
   */
  setVisibility: (id, visibility) => {
    db.prepare('UPDATE worlds SET visibility = ? WHERE id = ?').run(visibility, id);

    return World.findById(id);
  },

  /**
   * Mark a listing changed without changing any of its columns. For a change kept in another table that
   * still alters what a downloader receives: the required dependencies of a world.
   *
   * @param {string} id - World ID
   * @returns {Object|undefined} The updated row
   */
  touch: (id) => {
    db.prepare('UPDATE worlds SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);

    return World.findById(id);
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
   * This author's entry in a contest, if they have one.
   *
   * The one-per-person rule in one question. A quarantined entry still counts: it is out of the room, not
   * withdrawn, and its author has had their turn.
   *
   * @param {string} authorId - Author ID
   * @param {string} eventId - Contest event ID
   * @returns {Object|undefined} Their entry, or undefined when they have none
   */
  contestEntryFor: (authorId, eventId) => db
    .prepare('SELECT * FROM worlds WHERE author_id = ? AND contest_event_id = ? LIMIT 1')
    .get(authorId, eventId),

  /**
   * Take a listing out of the contest it was entered in.
   *
   * Leaves `updated_at` alone, as the spoiler toggle does: withdrawing changes where a listing appears,
   * not what it is, and bumping the date would push it back up a catalog sorted by freshness.
   *
   * @param {string} id - World ID
   * @returns {Object|undefined} The updated row
   */
  withdrawFromContest: (id) => {
    db.prepare('UPDATE worlds SET contest_event_id = NULL WHERE id = ?').run(id);

    return World.findById(id);
  },

  /**
   * What an author's published work adds up to, across every kind.
   *
   * Deliberately public-only, with no viewer: this is what the room sees an account as having earned, and
   * a total that moved depending on who was reading would make an author's own profile disagree with the
   * one they hand somebody else. Their hidden work — quarantined or unlisted — still appears in their own
   * listing, with its own numbers; it just doesn't count here while it is out of the catalog.
   *
   * @param {string} authorId - Author ID
   * @returns {Object} `{ likes, downloads }`, both zero for an account that has published nothing
   */
  authorTotals: (authorId) => {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(w.downloads), 0) AS downloads,
        (SELECT COUNT(*) FROM world_likes l
          JOIN worlds lw ON lw.id = l.world_id
          WHERE lw.author_id = ? AND lw.quarantined_at IS NULL AND lw.visibility = 'public') AS likes
      FROM worlds w
      WHERE w.author_id = ? AND w.quarantined_at IS NULL AND w.visibility = 'public'
    `).get(authorId, authorId);

    return { likes: row.likes || 0, downloads: row.downloads || 0 };
  },

  /**
   * Add or remove this user's like. Idempotent in both directions.
   *
   * @param {string} worldId - World ID
   * @param {string} userId - User ID
   * @param {boolean} liked - Whether they want their like on it
   */
  setLike: (worldId, userId, liked) => {
    if (liked) {
      db.prepare(`
        INSERT INTO world_likes (world_id, user_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT(world_id, user_id) DO NOTHING
      `).run(worldId, userId, new Date().toISOString());
      return;
    }

    World.removeLike(worldId, userId);
  },

  /**
   * How many accounts have liked a listing.
   * @param {string} worldId - World ID
   * @returns {number} The count
   */
  likeCount: (worldId) =>
    db.prepare('SELECT COUNT(*) AS count FROM world_likes WHERE world_id = ?').get(worldId).count,

  /**
   * Whether this user has liked a listing.
   * @param {string} worldId - World ID
   * @param {string} userId - User ID
   * @returns {boolean} True when their like is on it
   */
  hasLiked: (worldId, userId) => Boolean(
    db.prepare('SELECT 1 AS found FROM world_likes WHERE world_id = ? AND user_id = ?').get(worldId, userId)
  ),

  /**
   * Which of the given listings this user has liked, so a page of cards can fill every heart in without a
   * query per row.
   *
   * @param {Array<string>} ids - World IDs
   * @param {string} userId - User ID
   * @returns {Set<string>} The IDs they have liked
   */
  likedAmong: (ids, userId) => {
    if (!ids || ids.length === 0) return new Set();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT world_id FROM world_likes WHERE user_id = ? AND world_id IN (${placeholders})
    `).all(userId, ...ids);

    return new Set(rows.map((row) => row.world_id));
  },

  /**
   * Who liked a listing, newest like first. For staff: the public count is a count and nothing more.
   *
   * The age is computed here rather than by the caller because the two timestamps are stored in
   * different shapes — SQLite's CURRENT_TIMESTAMP for the account, an ISO string for the like — and
   * SQLite's date functions read both. Whole seconds, since the account stamp has no finer resolution.
   *
   * @param {string} worldId - World ID
   * @param {number} [limit] - Row ceiling
   * @returns {Object} `{ total, rows }` — `total` is the full count; each row is the account plus
   *   `liked_at` and `account_age_seconds`
   */
  likers: (worldId, limit = LIKE_LIST_LIMIT) => {
    const rows = db.prepare(`
      SELECT u.id, u.username, u.avatar_file, u.status, u.created_at,
        l.created_at AS liked_at,
        CAST(strftime('%s', l.created_at) AS INTEGER) - CAST(strftime('%s', u.created_at) AS INTEGER)
          AS account_age_seconds
      FROM world_likes l
      JOIN users u ON u.id = l.user_id
      WHERE l.world_id = ?
      ORDER BY l.created_at DESC, u.id DESC
      LIMIT ?
    `).all(worldId, limit);

    return { total: World.likeCount(worldId), rows };
  },

  /**
   * Every listing an account has liked, newest like first, each with its author. For staff: one
   * account liking a whole cluster from one author is the shape a throwaway account leaves.
   *
   * As stored, not as the room sees it: a like on a quarantined listing is a row with the flag set
   * rather than a row that vanished.
   *
   * @param {string} userId - User ID
   * @param {number} [limit] - Row ceiling
   * @returns {Object} `{ total, rows }` — `total` is the full count; each row is the listing's id,
   *   name, author id and username, `quarantined_at`, and `liked_at`
   */
  likesGiven: (userId, limit = LIKE_LIST_LIMIT) => {
    const rows = db.prepare(`
      SELECT w.id, w.name, w.author_id, a.username AS author_username, w.quarantined_at,
        l.created_at AS liked_at
      FROM world_likes l
      JOIN worlds w ON w.id = l.world_id
      LEFT JOIN users a ON a.id = w.author_id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC, w.id DESC
      LIMIT ?
    `).all(userId, limit);
    const total = db.prepare('SELECT COUNT(*) AS count FROM world_likes WHERE user_id = ?').get(userId).count;

    return { total, rows };
  },

  /**
   * Take one account's like off a listing.
   * @param {string} worldId - World ID
   * @param {string} userId - User ID
   * @returns {boolean} Whether a like was there to remove
   */
  removeLike: (worldId, userId) =>
    db.prepare('DELETE FROM world_likes WHERE world_id = ? AND user_id = ?').run(worldId, userId).changes > 0,

  /**
   * Remove every like an account has given.
   * @param {string} userId - User ID
   * @returns {number} How many likes went
   */
  clearLikes: (userId) => db.prepare('DELETE FROM world_likes WHERE user_id = ?').run(userId).changes,

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
   * @param {Object} viewer - Who is asking, for quarantine visibility. Nobody sees a quarantined row
   *   except its own author and the staff, so an omitted viewer lists only what is public.
   * @returns {Object} `{ worlds, total, pagination }` from getAll
   */
  getByAuthor: (authorId, kind = DEFAULT_KIND, limit = AUTHOR_LIST_LIMIT, viewer = null) => {
    try {
      return World.getAll({ authorId, kind, limit, viewer });
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
