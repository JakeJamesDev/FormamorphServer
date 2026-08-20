const express = require('express');
const { getActiveEvents, getEvents } = require('../controllers/eventController');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Literal path first, so `active` is never read as an event ID.

// What is running right now — the banner's source. Public: a signed-out visitor sees the same happenings
// everyone else does, and knowing who is asking only changes what a staff caller sees on the list below.
router.get('/active', optionalAuth, getActiveEvents);

// Everything that has started, ended ones included — the archive source. Staff additionally see what is
// still scheduled and what was cancelled.
router.get('/', optionalAuth, getEvents);

module.exports = router;
