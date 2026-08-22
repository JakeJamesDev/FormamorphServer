const express = require('express');
const {
  getActiveEvents,
  getEvents,
  getEvent,
  createEvent,
  updateEvent,
  cancelEventById,
  deleteEvent,
  pickWinner
} = require('../controllers/eventController');
const { protect, admin, staff, optionalAuth } = require('../middleware/auth');

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

// Picking the winner is the moderation team's, not the owner's alone: it is a judgement about entries
// rather than an announcement to write, and the notice that follows is posted by the server either way.
router.put('/:id/winner', protect, staff, express.json({ limit: '100kb' }), pickWinner);

module.exports = router;
