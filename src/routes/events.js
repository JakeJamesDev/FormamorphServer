const express = require('express');
const {
  getActiveEvents,
  getEvents,
  getEvent,
  createEvent,
  updateEvent,
  cancelEventById,
  deleteEvent,
  announceResults,
  editPlacements
} = require('../controllers/eventController');
const { protect, admin, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Parsed per route rather than for the whole group: an event's poster arrives as a base64 image, which
// does not fit the cap the rest of this server's bodies are held to. Only routes taking a body get one.
// Behind the auth gates, not in front of them: a 4MB body is only worth reading once the caller has
// proved they may write events at all.
const posterJson = express.json({ limit: '4mb' });

// Literal path first, so `active` is never read as an event ID.

// What is running right now — the banner's source. Public: a signed-out visitor sees the same happenings
// everyone else does, and knowing who is asking only changes what a staff caller sees on the list below.
router.get('/active', optionalAuth, getActiveEvents);

// Everything that has started, ended ones included — the archive source. Staff additionally see what is
// still scheduled and what was cancelled.
router.get('/', optionalAuth, getEvents);

// One event in full. What a client reads when the list it holds was served trimmed and a surface needs
// the prose — the end-of-contest poster and the rules dialog, and nothing else.
router.get('/:id', optionalAuth, getEvent);

// Scheduling, editing and withdrawing an event are the owner's, not the moderation team's: these speak
// to everyone at once, exactly as a broadcast does, and that gate has always been `admin`.
router.post('/', protect, admin, posterJson, createEvent);
router.put('/:id', protect, admin, posterJson, updateEvent);

// Cancel is its own route rather than a flavor of DELETE. Calling off something people were told about
// is an announcement in itself; removing the row is the answer only for something nobody ever saw.
router.post('/:id/cancel', protect, admin, cancelEventById);
router.delete('/:id', protect, admin, deleteEvent);

// Announcing results is the owner's, like every other thing this server says to everyone at once — the
// broadcast that goes out is the point of the route. Editing an announced podium is the same authority
// used quietly, so it sits behind the same gate rather than a looser one.
const podiumJson = express.json({ limit: '100kb' });
router.put('/:id/results', protect, admin, podiumJson, announceResults);
router.put('/:id/placements', protect, admin, podiumJson, editPlacements);

module.exports = router;
