const Event = require('../models/Event');
const World = require('../models/World');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { isStaff } = require('../config/roles');
const { sweepEvents, cancelEvent, announceResults: postResultsBroadcast } = require('../utils/sweepEvents');
const { saveEventPoster, deleteEventPoster } = require('../utils/fileStorage');
const { SUBJECT_MAX, BODY_MAX } = require('../utils/eventBroadcasts');

/**
 * The public URL of an event's poster artwork, or null when it has none.
 *
 * Keyed on the filename rather than the event, so the URL is immutable — an upload writes a new UUID,
 * which means a replacement can never come back from a cache.
 *
 * @param {string|null|undefined} posterImage - The `poster_image` column
 * @returns {string|null} The URL, or null
 */
const posterUrlFor = (posterImage) => (posterImage ? `/api/event-posters/${posterImage}` : null);

/**
 * An event as anyone may see it.
 *
 * The message ids ride along so the client can mark the notice it is showing as read — the banner and
 * the inbox badge would otherwise disagree about whether the reader has seen the same announcement.
 *
 * @param {Object} row - An event row with its derived `state`
 * @returns {Object} The public DTO
 */
const placementDto = (row) => ({
  place: row.place,
  worldId: row.world_id || null,
  worldName: row.world_name,
  authorName: row.author_name
});

const toDto = (row, placements = Event.placements(row.id)) => ({
  id: row.id,
  type: row.type,
  state: row.state,
  title: row.title,
  bannerText: row.banner_text,
  body: row.body,
  rulesText: row.rules_text || null,
  posterColor: row.poster_color || null,
  posterImageUrl: posterUrlFor(row.poster_image),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  cancelledAt: row.cancelled_at || null,
  startMessageId: row.start_message_id || null,
  endMessageId: row.end_message_id || null,
  winnerMessageId: row.winner_message_id || null,
  resultsAnnouncedAt: row.results_announced_at || null,
  placements: placements.map(placementDto),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/**
 * A whole list of events as DTOs, with every podium read in one query.
 *
 * The archive is one row per contest ever run, so letting each DTO fetch its own placements would put a
 * query per row behind the list surface every client opens.
 *
 * @param {Array<Object>} rows - Event rows with their derived state
 * @returns {Array<Object>} The public DTOs
 */
const toDtoList = (rows) => {
  const byEvent = new Map();
  for (const placement of Event.placementsFor(rows.map((row) => row.id))) {
    const held = byEvent.get(placement.event_id);
    if (held) held.push(placement);
    else byEvent.set(placement.event_id, [placement]);
  }

  return rows.map((row) => toDto(row, byEvent.get(row.id) ?? []));
};

/**
 * @desc    Events running right now
 * @route   GET /api/events/active
 * @access  Public
 */
exports.getActiveEvents = async (req, res, next) => {
  try {
    // Anything whose window opened or closed while the timer was between ticks moves first, so this
    // route can never answer with a banner that should be up or one that should be gone.
    await sweepEvents();

    const events = toDtoList(Event.getActive());

    res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    next(error);
  }
};

/**
 * The prose an event carries: the poster's body and, for a contest, its rules. Together they are most of
 * a row's bytes, and the archive keeps every event that ever started.
 */
const PROSE_FIELDS = ['body', 'rulesText'];

/**
 * The same DTO with its prose left out.
 *
 * The keys are removed rather than nulled. A caller tells a trimmed row from a whole one by asking
 * whether the field is there at all, and `rulesText: null` is what an announcement legitimately carries.
 *
 * @param {Object} dto - A public DTO
 * @returns {Object} A copy without the prose fields
 */
const withoutProse = (dto) => {
  const out = { ...dto };
  PROSE_FIELDS.forEach((field) => { delete out[field]; });
  return out;
};

/**
 * Whether a query asked for the trimmed rows. Opt-in: an older client sends nothing and is served whole
 * rows, which is why deploying this breaks none of them.
 *
 * @param {*} value - The `slim` query value; a bare `?slim` arrives as an empty string
 * @returns {boolean} Whether to trim
 */
const wantsSlim = (value) => value === '' || value === '1' || value === 'true';

/**
 * @desc    Every event that has started, including those that have ended — the archive source
 * @route   GET /api/events
 * @access  Public (staff additionally see scheduled and cancelled events)
 */
exports.getEvents = async (req, res, next) => {
  try {
    await sweepEvents();

    const slim = wantsSlim(req.query.slim);
    const dtos = toDtoList(Event.getList({ includeUnannounced: isStaff(req.user) }));
    const events = slim ? dtos.map(withoutProse) : dtos;

    res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    One event in full — what a trimmed list is read out to when its prose is needed
 * @route   GET /api/events/:id
 * @access  Public (staff additionally see scheduled and cancelled events)
 */
exports.getEvent = async (req, res, next) => {
  try {
    await sweepEvents();

    const event = Event.findById(req.params.id);
    // The list's visibility rule, applied one row at a time: a detail read must not be the way around it.
    const visible = event && (isStaff(req.user) || (!event.cancelled_at && hasStarted(event)));
    if (!visible) return res.status(404).json({ success: false, error: 'Event not found' });

    res.status(200).json({ success: true, data: toDto(event) });
  } catch (error) {
    next(error);
  }
};

/**
 * Caps on the authored fields. The title and the body become a broadcast's subject and body, so they
 * borrow the composer's limits; a banner line is one row of a card and is held far shorter than either.
 */
const TITLE_MAX = SUBJECT_MAX;
const BANNER_MAX = 280;

/** Whether an event's window has opened, cancelled rows included — a cancelled event still started. */
const hasStarted = (row, now = new Date()) => new Date(row.starts_at) <= now;

/**
 * Read a timestamp the way the table stores them.
 *
 * Everything written here is normalized to ISO, because every comparison in the model goes through
 * `datetime()` and a value in some other format would compare against the rest of the table by luck.
 *
 * @param {*} value - Whatever the caller sent
 * @returns {string|null} The instant as ISO, or null when it is not one
 */
const isoOrNull = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Read an organizer's poster color.
 *
 * Hex only, which is what the client's picker emits and what CSS can paint. A value in some other
 * notation is refused rather than stored, because the client would then fall back to the default band
 * and the admin would have no way to tell their color from a color that simply did not apply.
 *
 * Shorthand is expanded rather than refused, matching the client's own parser: `#0af` is a color a
 * person can reasonably have typed or pasted off a stylesheet. Storing the expanded form means every
 * reader — including a client older than this server — sees the one canonical spelling.
 *
 * @param {*} value - Whatever the caller sent
 * @returns {string|null} The color as lowercase `#rrggbb`, or null when it is not one
 */
const hexOrNull = (value) => {
  const raw = trimmed(value).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;

  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.slice(1).split('').map((digit) => digit + digit).join('')}`;
  }

  return null;
};

/**
 * Validate and normalize an event payload.
 *
 * On an edit only the keys actually sent are read, so an admin fixing a typo in the banner cannot blank
 * the body by not mentioning it — and `rulesText: ''` still means "clear the rules", which is why the
 * absent case and the empty case are told apart here rather than in the model.
 *
 * @param {Object} body - Request body
 * @param {Object} [options] - `{ partial }` — true for an edit, where every field is optional
 * @returns {Object} `{ error }` on rejection, otherwise the normalized fields
 */
const parseEventBody = (body, { partial = false } = {}) => {
  const fields = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has('type')) {
    const type = body.type || 'announcement';
    if (!Event.TYPES.includes(type)) return { error: 'Invalid event type' };
    fields.type = type;
  }

  for (const [key, max, label] of [
    ['title', TITLE_MAX, 'Title'],
    ['bannerText', BANNER_MAX, 'Banner text'],
    ['body', BODY_MAX, 'Body']
  ]) {
    if (partial && !has(key)) continue;

    const value = trimmed(body[key]);
    if (!value) return { error: `${label} is required` };
    if (value.length > max) return { error: `${label} must be ${max} characters or fewer` };
    fields[key] = value;
  }

  if (has('rulesText')) {
    const rules = trimmed(body.rulesText);
    if (rules.length > BODY_MAX) return { error: `Rules must be ${BODY_MAX} characters or fewer` };
    fields.rulesText = rules || null;
  } else if (!partial) {
    fields.rulesText = null;
  }

  // Absent leaves the stored color alone on an edit and means "no color" on a create; empty clears it.
  if (has('posterColor')) {
    const raw = trimmed(body.posterColor);
    const color = raw ? hexOrNull(raw) : null;
    if (raw && !color) return { error: 'Poster color must be a hex color like #1e3a8a' };
    fields.posterColor = color;
  } else if (!partial) {
    fields.posterColor = null;
  }

  for (const [key, label] of [['startsAt', 'Start'], ['endsAt', 'End']]) {
    if (partial && !has(key)) continue;

    const value = isoOrNull(body[key]);
    if (!value) return { error: `${label} must be a valid timestamp` };
    fields[key] = value;
  }

  return fields;
};

/**
 * The window an event would have once a patch is applied, for the checks that are about the whole
 * window rather than the field that changed.
 *
 * @param {Object} row - The existing event row
 * @param {Object} fields - The normalized patch
 * @returns {Object} `{ startsAt, endsAt }`
 */
const resultingWindow = (row, fields) => ({
  startsAt: fields.startsAt || row.starts_at,
  endsAt: fields.endsAt || row.ends_at
});

/**
 * Refuse a window that is not one, or one already spoken for.
 *
 * The overlap rule is checked on the resulting window rather than on what was sent, so extending a
 * contest into next month's is caught even though `starts_at` never moved.
 *
 * @param {Object} window - `{ startsAt, endsAt }`
 * @param {string} type - The event type the window belongs to
 * @param {string|null} [excludeId] - The event being edited
 * @returns {Object|null} `{ status, error }` on refusal, otherwise null
 */
const windowConflict = ({ startsAt, endsAt }, type, excludeId = null) => {
  if (new Date(endsAt) <= new Date(startsAt)) {
    return { status: 400, error: 'End must be after start' };
  }

  if (type !== 'contest') return null;

  const clash = Event.conflictingContest({ startsAt, endsAt, excludeId });
  if (!clash) return null;

  return { status: 409, error: `That window overlaps the contest "${clash.title}"` };
};

/**
 * Note an event in the audit trail. The title is the snapshot, since an event may be deleted outright.
 *
 * @param {string} action - One of the event actions
 * @param {Object} actor - The acting user
 * @param {Object} row - The event row
 */
const auditEvent = (action, actor, row) => {
  AuditLog.tryRecord({ action, actor, targetKind: 'event', targetName: row.title, snippet: row.id });
};

/**
 * @desc    Schedule an event
 * @route   POST /api/events
 * @access  Admin
 */
exports.createEvent = async (req, res, next) => {
  try {
    const fields = parseEventBody(req.body);
    if (fields.error) return res.status(400).json({ success: false, error: fields.error });

    const conflict = windowConflict(fields, fields.type);
    if (conflict) return res.status(conflict.status).json({ success: false, error: conflict.error });

    // Written after the refusals, so a window that was never going to be accepted leaves no file behind.
    const posterImage = req.body.posterImage ? await saveEventPoster(req.body.posterImage) : null;

    const event = Event.create({ ...fields, posterImage, createdBy: req.user.id });

    auditEvent('event_created', req.user, event);

    // A window that has already opened is swept here rather than at the next tick: an admin scheduling
    // something for right now expects the notice to go out, not to appear within the hour.
    await sweepEvents();

    res.status(201).json({ success: true, data: toDto(Event.findById(event.id)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Edit an event
 * @route   PUT /api/events/:id
 * @access  Admin
 */
exports.updateEvent = async (req, res, next) => {
  try {
    const existing = Event.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Event not found' });

    const fields = parseEventBody(req.body, { partial: true });
    if (fields.error) return res.status(400).json({ success: false, error: fields.error });

    // The type decides which rules apply and what a client unlocks, and both are already out in a
    // broadcast by the time anyone could want it changed. A new event is the answer.
    if (fields.type && fields.type !== existing.type) {
      return res.status(400).json({ success: false, error: 'An event type cannot be changed' });
    }

    // People have been told when this begins, and for a contest the entry window opening is the thing
    // itself. Moving the end is the live edit that matters; moving the start is a different event.
    if (fields.startsAt && fields.startsAt !== existing.starts_at && hasStarted(existing)) {
      return res.status(400).json({ success: false, error: 'A started event cannot have its start moved' });
    }

    const conflict = windowConflict(resultingWindow(existing, fields), existing.type, existing.id);
    if (conflict) return res.status(conflict.status).json({ success: false, error: conflict.error });

    // Absent leaves the stored artwork alone — an edit that never opened the picker must not delete the
    // file — while an explicit null clears it and a data URI replaces it.
    if (req.body.posterImage !== undefined) {
      fields.posterImage = req.body.posterImage ? await saveEventPoster(req.body.posterImage) : null;
    }

    // Nothing here posts, recalls or re-sends: an edit changes what the event says it is, and the
    // notices already sent are ordinary messages the admin polishes through the message edit route.
    const event = Event.update(existing.id, fields);

    // Only once the row no longer points at it: a delete before the write would strand the event on a
    // missing file if the update threw.
    if (fields.posterImage !== undefined && existing.poster_image && existing.poster_image !== fields.posterImage) {
      await deleteEventPoster(existing.poster_image);
    }

    auditEvent('event_edited', req.user, event);

    res.status(200).json({ success: true, data: toDto(event) });
  } catch (error) {
    next(error);
  }
};

/**
 * Call an event off — the answer for anything that has already been announced.
 *
 * Idempotent, because the transition is: a second cancel keeps the first stamp and posts nothing more.
 * Entries are released here rather than left pointing at a dead event, so nothing downstream ever has
 * to ask whether the contest a world is entered in is still happening.
 *
 * @desc    Cancel an event
 * @route   POST /api/events/:id/cancel
 * @access  Admin
 */
exports.cancelEventById = async (req, res, next) => {
  try {
    const existing = Event.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Event not found' });

    const alreadyCancelled = Boolean(existing.cancelled_at);
    const cancelled = cancelEvent(existing);

    Event.clearEntries(existing.id);

    if (!alreadyCancelled) auditEvent('event_cancelled', req.user, cancelled || existing);

    res.status(200).json({ success: true, data: toDto(cancelled || Event.findById(existing.id)) });
  } catch (error) {
    next(error);
  }
};

/** The three places a podium has, in the order they read. */
const PLACES = [1, 2, 3];

/** How each place reads wherever the server has to name one. */
const PLACE_NAMES = { 1: 'First place', 2: 'Second place', 3: 'Third place' };

/**
 * Read a podium out of a request body, or say why it is not one.
 *
 * The strict-podium rule lives here rather than in the two routes that need it, so announcing and editing
 * cannot drift into judging the same request differently. Two kinds of wrong, and the status says which:
 * a body that is not a podium at all reads 400, and an entry that cannot hold the place it was given
 * reads 409 — the same split the rest of this controller uses.
 *
 * Every place is checked against the three refusals the single winner was: the listing has to still be an
 * entry in this contest, it has to be one people can actually see, and it must not belong to whoever is
 * judging. Staff enter contests like anyone else in a community this size, so refusing to let them crown
 * themselves is the one rule that keeps that above board.
 *
 * @param {Object} event - The contest being judged
 * @param {*} body - The request body
 * @param {Object} actor - The judging account
 * @returns {Object} `{ placements }` when it holds, or `{ refusal: { status, error } }`
 */
const readPodium = (event, body, actor) => {
  const sent = body && body.placements;
  const refuse = (status, error) => ({ refusal: { status, error } });

  if (!Array.isArray(sent)) return refuse(400, 'A list of placements is required');
  if (sent.length === 0) return refuse(400, 'First place is required');
  if (sent.length > PLACES.length) return refuse(400, 'A podium holds three places at most');

  const shaped = sent.every((entry) => entry
    && PLACES.includes(entry.place)
    && typeof entry.worldId === 'string'
    && entry.worldId);
  if (!shaped) return refuse(400, 'Each placement needs a place of 1, 2 or 3 and a world ID');

  // Compared numerically rather than by `sort()`'s default, which orders as text — right for one digit
  // and quietly wrong the day a podium grows past nine places.
  const places = sent.map((entry) => entry.place).sort((a, b) => a - b);
  if (new Set(places).size !== places.length) return refuse(400, 'One world per place');
  // Contiguous from gold: the sorted places have to run 1, 2, 3 with nothing skipped.
  if (places.some((place, index) => place !== index + 1)) {
    return refuse(400, 'A podium fills from first place down, with no gaps');
  }

  const worldIds = sent.map((entry) => entry.worldId);
  if (new Set(worldIds).size !== worldIds.length) return refuse(400, 'One place per world');

  const placements = [];

  for (const place of places) {
    const { worldId } = sent.find((entry) => entry.place === place);
    const world = World.findById(worldId);

    if (!world) return refuse(404, 'World not found');
    if (world.contest_event_id !== event.id) {
      return refuse(409, 'That listing is not an entry in this contest');
    }
    if (world.quarantined_at) {
      return refuse(409, 'A quarantined entry cannot place. Release it first.');
    }
    if (world.author_id === actor.id) {
      return refuse(409, 'You cannot place your own entry');
    }

    const author = User.findById(world.author_id);
    placements.push({
      place,
      worldId: world.id,
      name: world.name,
      authorName: author ? author.username : 'a departed account'
    });
  }

  return { placements };
};

/** The podium as one line, for a log entry and nothing else. */
const podiumSnippet = (placements) => placements
  .map((row) => `${PLACE_NAMES[row.place]}: ${row.world_name} by ${row.author_name}`)
  .join('; ');

/**
 * Announce a contest's podium, and tell everyone.
 *
 * The decision moment: one request carries the whole podium, so players never meet a contest that has
 * announced gold and is still thinking about silver. It is also what lifts the entry lock and what makes
 * the contest read as decided — none of which any single place does on its own.
 *
 * Once. A second announce would be a second set of results for the same contest, so it is refused rather
 * than quietly overwritten; correcting a podium afterwards is the edit route, which announces nothing.
 *
 * @desc    Announce a contest's results
 * @route   PUT /api/events/:id/results
 * @access  Admin
 */
exports.announceResults = async (req, res, next) => {
  try {
    const event = Event.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, error: 'Event not found' });

    if (event.type !== 'contest') {
      return res.status(400).json({ success: false, error: 'Only a contest has results' });
    }

    if (event.results_announced_at) {
      return res.status(409).json({ success: false, error: 'That contest has already announced its results' });
    }

    const { placements: podium, refusal } = readPodium(event, req.body, req.user);
    if (refusal) return res.status(refusal.status).json({ success: false, error: refusal.error });

    // Stored before the notice is written, because the notice is written from the store — which is what
    // makes the announcement and the archive say the same thing forever.
    const placements = Event.setPlacements(event.id, podium);
    const stamped = Event.announceResults(event.id);
    const announced = postResultsBroadcast(stamped, placements);

    const gold = World.findById(podium[0].worldId);

    AuditLog.tryRecord({
      action: 'results_announced',
      actor: req.user,
      targetUser: gold ? User.findById(gold.author_id) : null,
      targetKind: 'event',
      targetName: event.title,
      snippet: podiumSnippet(placements)
    });

    res.status(200).json({ success: true, data: toDto(announced || stamped, placements) });
  } catch (error) {
    next(error);
  }
};

/**
 * Correct an announced podium.
 *
 * Silent by design: a place fixed a day later is a correction rather than news, and re-broadcasting would
 * spend every player's attention on the server's own mistake. What it leaves instead is a log line per
 * place that actually moved, so a correction is accountable without being announced.
 *
 * Only after an announcement. Before one there is nothing stored to correct — the podium is still being
 * assembled in the dialog, which keeps its own staging and sends it whole.
 *
 * @desc    Edit an announced podium
 * @route   PUT /api/events/:id/placements
 * @access  Admin
 */
exports.editPlacements = async (req, res, next) => {
  try {
    const event = Event.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, error: 'Event not found' });

    if (event.type !== 'contest') {
      return res.status(400).json({ success: false, error: 'Only a contest has results' });
    }

    if (!event.results_announced_at) {
      return res.status(409).json({ success: false, error: 'Announce the results before editing the podium' });
    }

    const { placements: podium, refusal } = readPodium(event, req.body, req.user);
    if (refusal) return res.status(refusal.status).json({ success: false, error: refusal.error });

    const before = Event.placements(event.id);
    const placements = Event.setPlacements(event.id, podium);

    for (const place of PLACES) {
      const was = before.find((row) => row.place === place);
      const now = placements.find((row) => row.place === place);
      if ((was ? was.world_id : null) === (now ? now.world_id : null)) continue;

      const holder = now ? World.findById(now.world_id) : null;

      AuditLog.tryRecord({
        action: 'podium_edited',
        actor: req.user,
        targetUser: holder ? User.findById(holder.author_id) : null,
        targetKind: 'event',
        targetName: event.title,
        snippet: `${PLACE_NAMES[place]}: ${now ? `${now.world_name} by ${now.author_name}` : 'cleared'}`
          + (was ? ` (was ${was.world_name})` : '')
      });
    }

    res.status(200).json({ success: true, data: toDto(Event.findById(event.id), placements) });
  } catch (error) {
    next(error);
  }
};

/**
 * Remove an event that never happened.
 *
 * Only before it starts. Once a notice has gone out there is something to explain, and the honest
 * record of that is a cancellation — deleting the row would leave a recalled broadcast about an event
 * nobody can look up.
 *
 * @desc    Delete an event
 * @route   DELETE /api/events/:id
 * @access  Admin
 */
exports.deleteEvent = async (req, res, next) => {
  try {
    const existing = Event.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Event not found' });

    if (hasStarted(existing)) {
      return res.status(409).json({ success: false, error: 'A started event can only be cancelled' });
    }

    Event.clearEntries(existing.id);
    Event.delete(existing.id);
    // The row is gone, so nothing can still be serving this file.
    await deleteEventPoster(existing.poster_image);

    auditEvent('event_deleted', req.user, existing);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};
