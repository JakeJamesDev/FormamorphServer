const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { errorHandler } = require('./middleware/error');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const worldRoutes = require('./routes/worlds');
const commentRoutes = require('./routes/comments');
const thumbnailRoutes = require('./routes/thumbnails');

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '200mb' })); // Increased limit for large world content
app.use(express.urlencoded({ extended: false, limit: '200mb' }));
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/worlds', worldRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/thumbnails', thumbnailRoutes);

// Base route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Exotic Dangerous World Workshop Server' });
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
