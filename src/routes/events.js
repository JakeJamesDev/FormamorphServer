const express = require('express');
const {
  getActiveEvents,
  getEvents,
  createEvent,
  updateEvent,
  cancelEventById,
  deleteEvent
} = require('../controllers/eventController');
const { protect, admin, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Literal path first, so `active` is never read as an event ID.

// What is running right now — the banner's source. Public: a signed-out visitor sees the same happenings
// everyone else does, and knowing who is asking only changes what a staff caller sees on the list below.
router.get('/active', optionalAuth, getActiveEvents);

// Everything that has started, ended ones included — the archive source. Staff additionally see what is
// still scheduled and what was cancelled.
router.get('/', optionalAuth, getEvents);

// Scheduling, editing and withdrawing an event are the owner's, not the moderation team's: these speak
// to everyone at once, exactly as a broadcast does, and that gate has always been `admin`.
router.post('/', protect, admin, createEvent);
router.put('/:id', protect, admin, updateEvent);

// Cancel is its own route rather than a flavor of DELETE. Calling off something people were told about
// is an announcement in itself; removing the row is the answer only for something nobody ever saw.
router.post('/:id/cancel', protect, admin, cancelEventById);
router.delete('/:id', protect, admin, deleteEvent);

module.exports = router;
