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
const avatarRoutes = require('./routes/avatars');
const messageRoutes = require('./routes/messages');
const policyRoutes = require('./routes/policies');
const feedbackRoutes = require('./routes/feedback');
const auditRoutes = require('./routes/audit');
const eventRoutes = require('./routes/events');
const eventPosterRoutes = require('./routes/eventPosters');

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
// Users mounts its own parsers per route: an avatar is a base64 image, which is larger than the
// 100kb everything else here is capped at (see routes/users.js).
app.use('/api/users', userRoutes);
app.use('/api/worlds', worldRoutes);
app.use('/api/comments', smallJson, commentRoutes);
app.use('/api/messages', smallJson, messageRoutes);
app.use('/api/policies', smallJson, policyRoutes);
app.use('/api/feedback', smallJson, feedbackRoutes);
app.use('/api/audit', smallJson, auditRoutes);
// Events mount their own parsers per route: an event's poster arrives as a base64 image, which is
// larger than the 100kb everything else here is capped at (see routes/events.js).
app.use('/api/events', eventRoutes);
app.use('/api/thumbnails', thumbnailRoutes);
app.use('/api/avatars', avatarRoutes);
app.use('/api/event-posters', eventPosterRoutes);

// Base route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Exotic Dangerous World Workshop Server' });
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
