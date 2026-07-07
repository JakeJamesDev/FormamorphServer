/**
 * Error handling middleware
 * @param {Object} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const errorHandler = (err, req, res, next) => {
  console.error(err);

  // Default error message and status code
  let message = 'Server Error';
  let statusCode = 500;

  // Handle specific error types
  if (err.name === 'ValidationError') {
    message = Object.values(err.errors).map(val => val.message).join(', ');
    statusCode = 400;
  } else if (err.code === 'SQLITE_CONSTRAINT') {
    message = 'Database constraint error';
    statusCode = 400;
  } else if (err.message && err.message.includes('exceeds maximum size')) {
    message = err.message;
    statusCode = 400;
  } else if (err.status || err.statusCode) {
    // Honor status set by body-parser and similar (e.g. 413 payload too large, 400 malformed JSON)
    statusCode = err.status || err.statusCode;
    if (err.message) message = err.message;
  } else if (err.message) {
    message = err.message;
  }

  // Send error response
  res.status(statusCode).json({
    success: false,
    error: message
  });
};

module.exports = { errorHandler };
