const db = require('../config/db');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { v4: uuidv4 } = require('uuid');

/**
 * Comment model
 */
const Comment = {
  /**
   * Find a comment by ID
   * @param {string} id - Comment ID
   * @returns {Object|null} Comment object or null if not found
   */
  findById: (id) => {
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  },

  /**
   * Find a comment by ID and populate with author data
   * @param {string} id - Comment ID
   * @returns {Object|null} Comment object with author data or null if not found
   */
  findByIdWithAuthor: (id) => {
    const comment = Comment.findById(id);
    
    if (!comment) {
      return null;
    }
    
    // Get author data
    const authorRow = db.prepare('SELECT id, username, avatar_file FROM users WHERE id = ?').get(comment.author_id);
    const author = authorRow
      ? { id: authorRow.id, username: authorRow.username, avatarUrl: avatarUrlFor(authorRow.avatar_file) }
      : authorRow;
    
    // Return comment with author
    return {
      ...comment,
      author
    };
  },

  /**
   * Get all comments for a world with pagination
   * @param {string} worldId - World ID
   * @param {Object} options - Query options
   * @returns {Object} Object containing comments, count, and pagination info
   */
  getByWorldId: (worldId, options = {}) => {
    try {
      const {
        page = 1,
        limit = 10,
      } = options;
      
      // Calculate offset
      const offset = (page - 1) * limit;
      
      // Base query
      let query = `
        SELECT c.*, u.username as author_username, u.avatar_file as author_avatar_file
        FROM comments c 
        JOIN users u ON c.author_id = u.id
        WHERE c.world_id = ?
      `;
      let countQuery = 'SELECT COUNT(*) as count FROM comments WHERE world_id = ?';
      let params = [worldId];
      
      // Add order by and limit to main query
      query += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      // Execute queries
      const comments = db.prepare(query).all(...params);
      const countResult = db.prepare(countQuery).get(worldId);
      const total = countResult ? countResult.count : 0;
      
      // Process comments
      const processedComments = comments.map(comment => {
        // Format author
        comment.author = {
          id: comment.author_id,
          username: comment.author_username,
          avatarUrl: avatarUrlFor(comment.author_avatar_file)
        };
        
        // Remove redundant fields
        delete comment.author_id;
        delete comment.author_username;
        delete comment.author_avatar_file;
        
        return comment;
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
        comments: processedComments,
        count: processedComments.length,
        pagination,
        total
      };
    } catch (error) {
      throw error;
    }
  },

  /**
   * Create a new comment
   * @param {Object} commentData - Comment data
   * @returns {Object} Created comment object
   */
  create: (commentData) => {
    try {
      // Generate UUID for comment ID
      const commentId = commentData.id || uuidv4();
      
      // Start a transaction
      db.prepare('BEGIN TRANSACTION').run();
      
      try {
        // Insert comment into database
        db.prepare(`
          INSERT INTO comments (
            id, content, world_id, author_id
          )
          VALUES (?, ?, ?, ?)
        `).run(
          commentId,
          commentData.content,
          commentData.world_id,
          commentData.author_id
        );
        
        // Increment comment_count in worlds table
        db.prepare(`
          UPDATE worlds
          SET comment_count = comment_count + 1
          WHERE id = ?
        `).run(commentData.world_id);
        
        // Commit the transaction
        db.prepare('COMMIT').run();
      } catch (err) {
        // Rollback the transaction if an error occurs
        db.prepare('ROLLBACK').run();
        throw err;
      }
      
      // Return created comment with author
      return Comment.findByIdWithAuthor(commentId);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Update a comment
   * @param {string} id - Comment ID
   * @param {Object} commentData - Comment data to update
   * @returns {Object} Updated comment object
   */
  update: (id, commentData) => {
    try {
      // Update timestamp
      commentData.updated_at = new Date().toISOString();
      
      // Build update query
      const fields = Object.keys(commentData).filter(key => key !== 'id');
      const placeholders = fields.map(field => `${field} = ?`).join(', ');
      const values = fields.map(field => commentData[field]);
      
      // Add ID to values
      values.push(id);
      
      // Update comment in database
      db.prepare(`
        UPDATE comments
        SET ${placeholders}
        WHERE id = ?
      `).run(...values);
      
      // Return updated comment with author
      return Comment.findByIdWithAuthor(id);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Delete a comment
   * @param {string} id - Comment ID
   * @returns {boolean} True if comment was deleted successfully
   */
  delete: (id) => {
    try {
      // Get the world_id before deleting the comment
      const comment = Comment.findById(id);
      
      if (!comment) {
        return false;
      }
      
      // Start a transaction
      db.prepare('BEGIN TRANSACTION').run();
      
      try {
        // Delete comment from database
        const result = db.prepare('DELETE FROM comments WHERE id = ?').run(id);
        
        // Decrement comment_count in worlds table if comment was deleted
        if (result.changes > 0) {
          db.prepare(`
            UPDATE worlds
            SET comment_count = MAX(0, comment_count - 1)
            WHERE id = ?
          `).run(comment.world_id);
        }
        
        // Commit the transaction
        db.prepare('COMMIT').run();
        
        return result.changes > 0;
      } catch (err) {
        // Rollback the transaction if an error occurs
        db.prepare('ROLLBACK').run();
        throw err;
      }
    } catch (error) {
      throw error;
    }
  },

  /**
   * Check if a user is the author of a comment
   * @param {string} id - Comment ID
   * @param {string} userId - User ID
   * @returns {boolean} True if user is the author
   */
  isAuthor: (id, userId) => {
    try {
      const comment = db.prepare('SELECT author_id FROM comments WHERE id = ?').get(id);
      
      return comment && comment.author_id === userId;
    } catch (error) {
      throw error;
    }
  }
};

module.exports = Comment;
