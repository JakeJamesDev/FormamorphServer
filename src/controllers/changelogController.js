const Changelog = require('../models/Changelog');
const World = require('../models/World');
const User = require('../models/User');
const { canModerate, isAdmin } = require('../config/roles');

/** An entry's title: long enough for "New for v2 — the drowned quarter", short enough to stay one line. */
const TITLE_MAX = 120;

/** The body, matching what a comment holds — the same editor writes both. */
const BODY_MAX = 4000;

/** How many entries one listing may carry. A ceiling on the embed, not a judgment about how much history
 *  is too much: the whole changelog is served inside the single-listing response. */
const MAX_ENTRIES = 100;

/** The author's date, day granularity. Checked as a shape and then as a real calendar date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a string is a calendar date that exists.
 *
 * The pattern alone accepts `2026-02-31`; round-tripping it through Date catches what the regex cannot,
 * because an impossible day comes back as a different one.
 *
 * @param {string} value - The candidate
 * @returns {boolean} Whether it names a real day
 */
const isCalendarDate = (value) => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * The listing a changelog request is about, or the refusal to answer instead.
 *
 * Reads follow the listing exactly as comments do: quarantined, it is as absent as a deleted one to
 * everyone but its author and the staff, and the same 404 means the room cannot probe for it either way.
 * Writing is the author's, or a moderator's who may reach them.
 *
 * Deliberately silent about the contest lock: an entry being judged still takes changelog entries, the way
 * it still takes comments and likes. None of them change the work in front of the judges.
 *
 * @param {Object} req - The request
 * @returns {Object} `{ world }`, or `{ refusal: { status, error } }`
 */
const resolveListing = (req) => {
  const world = World.findById(req.params.worldId);

  if (!world || !World.isVisibleTo(world, req.user)) {
    return { refusal: { status: 404, error: 'World not found' } };
  }

  if (req.user.status === 'suspended' && !isAdmin(req.user)) {
    return { refusal: { status: 403, error: 'Suspended users cannot change a changelog' } };
  }

  if (world.author_id !== req.user.id && !canModerate(req.user, User.findById(world.author_id))) {
    return { refusal: { status: 403, error: 'Not authorized to change this changelog' } };
  }

  return { world };
};

/**
 * The authored fields off a request body, or the first thing wrong with them.
 *
 * @param {Object} body - The request body
 * @returns {Object} `{ entry }`, or `{ error }`
 */
const readEntry = (body) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const entryBody = typeof body.body === 'string' ? body.body.trim() : '';
  const date = typeof body.date === 'string' ? body.date.trim() : '';

  if (!title) return { error: 'A title is required' };
  if (title.length > TITLE_MAX) return { error: `Title cannot exceed ${TITLE_MAX} characters` };
  if (!entryBody) return { error: 'A body is required' };
  if (entryBody.length > BODY_MAX) return { error: `Body cannot exceed ${BODY_MAX} characters` };
  if (!isCalendarDate(date)) return { error: 'Date must be a calendar date (YYYY-MM-DD)' };

  return { entry: { title, body: entryBody, entry_date: date } };
};

/**
 * @desc    Add a changelog entry to a listing
 * @route   POST /api/worlds/:worldId/changelog
 * @access  Private (the listing's author, or a moderator who may reach them)
 */
exports.createEntry = async (req, res, next) => {
  try {
    const { world, refusal } = resolveListing(req);
    if (refusal) return res.status(refusal.status).json({ success: false, error: refusal.error });

    const { entry, error } = readEntry(req.body);
    if (error) return res.status(400).json({ success: false, error });

    if (Changelog.countFor(world.id) >= MAX_ENTRIES) {
      return res.status(400).json({
        success: false,
        error: `A changelog holds at most ${MAX_ENTRIES} entries. Delete one to add another.`
      });
    }

    res.status(201).json({
      success: true,
      data: Changelog.create({ world_id: world.id, ...entry })
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Rewrite a changelog entry
 * @route   PUT /api/worlds/:worldId/changelog/:entryId
 * @access  Private (the listing's author, or a moderator who may reach them)
 */
exports.updateEntry = async (req, res, next) => {
  try {
    const { world, refusal } = resolveListing(req);
    if (refusal) return res.status(refusal.status).json({ success: false, error: refusal.error });

    // Matched against the listing in the path as well as its own id: an entry id alone would let one
    // listing's route address another's row.
    const existing = Changelog.findById(req.params.entryId);
    if (!existing || existing.world_id !== world.id) {
      return res.status(404).json({ success: false, error: 'Changelog entry not found' });
    }

    const { entry, error } = readEntry(req.body);
    if (error) return res.status(400).json({ success: false, error });

    res.status(200).json({ success: true, data: Changelog.update(existing.id, entry) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a changelog entry
 * @route   DELETE /api/worlds/:worldId/changelog/:entryId
 * @access  Private (the listing's author, or a moderator who may reach them)
 */
exports.deleteEntry = async (req, res, next) => {
  try {
    const { world, refusal } = resolveListing(req);
    if (refusal) return res.status(refusal.status).json({ success: false, error: refusal.error });

    const existing = Changelog.findById(req.params.entryId);
    if (!existing || existing.world_id !== world.id) {
      return res.status(404).json({ success: false, error: 'Changelog entry not found' });
    }

    Changelog.delete(existing.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};
