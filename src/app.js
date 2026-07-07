const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { errorHandler } = require('./middleware/error');
const { clientIpKeyGenerator } = require('./utils/rateLimitKey');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const worldRoutes = require('./routes/worlds');
const commentRoutes = require('./routes/comments');
const thumbnailRoutes = require('./routes/thumbnails');

const app = express();

// cloudflared reaches this origin from loopback; trust only that hop so `req.ip` / `req.protocol`
// derive from the proxy without letting a direct client spoof `X-Forwarded-For`. The rate limiters
// key on `CF-Connecting-IP` (see clientIpKeyGenerator), not on the trusted-proxy chain.
app.set('trust proxy', 'loopback');

// Security headers
app.use(helmet());

// Loose global rate limit (defense-in-depth; auth routes add a tighter one)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKeyGenerator
}));

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// urlencoded only acts on form posts (world uploads are JSON), so a tight cap here is safe
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(morgan('dev'));

// JSON bodies are parsed per route-group: only world create/update accept the large
// 200MB payload (see routes/worlds.js); everything else is capped tight to blunt payload DoS.
const smallJson = express.json({ limit: '100kb' });

// Routes
app.use('/api/auth', smallJson, authRoutes);
app.use('/api/users', smallJson, userRoutes);
app.use('/api/worlds', worldRoutes);
app.use('/api/comments', smallJson, commentRoutes);
app.use('/api/thumbnails', thumbnailRoutes);

// Base route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Exotic Dangerous World Workshop Server' });
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
