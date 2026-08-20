/**
 * The notices an event posts about itself.
 *
 * Templated here rather than typed by an admin, because the wording is the same every time and asking
 * for it at schedule time means an event whose announcement was left blank. What an admin does control
 * is the event's own title, banner line and body, which is what these are built from — and the sent
 * message stays an ordinary message afterwards, so polishing it is the existing edit route.
 */

/** The composer's caps, which these have to respect as much as a hand-written message does. */
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

const clamp = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Every notice is signed by the team and carries the event's own wording as its body. */
const compose = ({ subject, body, severity = 'info', scope }) => ({
  subject: clamp(subject.trim(), SUBJECT_MAX),
  body: clamp(body.trim(), BODY_MAX),
  severity,
  scope,
  senderAs: 'team'
});

/**
 * The notice posted when an event starts.
 *
 * Pinned: it reaches accounts made after it was posted and cannot be dismissed, which is what makes a
 * running event impossible to miss. It comes down again when the window closes, so nothing outlives it.
 *
 * @param {Object} event - The event row
 * @returns {Object} Composer fields for `Message.create`
 */
const startBroadcast = (event) => compose({
  subject: event.title,
  body: [event.banner_text, event.body].filter(Boolean).join('\n\n'),
  scope: 'pinned'
});

/**
 * The notice posted when a contest's window closes. Announcements post nothing here — their pin simply
 * comes down.
 *
 * @param {Object} event - The event row
 * @returns {Object} Composer fields for `Message.create`
 */
const endBroadcast = (event) => compose({
  subject: `${event.title} has closed`,
  body: `Entries for ${event.title} are closed and judging has begun. The winner will be announced here.`,
  scope: 'new'
});

/**
 * The notice posted when a started event is called off. Scope `new` rather than pinned: it is news, not
 * something to keep in front of people.
 *
 * @param {Object} event - The event row
 * @returns {Object} Composer fields for `Message.create`
 */
const cancelBroadcast = (event) => compose({
  subject: `${event.title} has been cancelled`,
  body: `${event.title} has been cancelled and is no longer running.`,
  scope: 'new'
});

/**
 * The notice posted when a contest's winner is picked.
 *
 * Built from the snapshot rather than from the listing, so it reads the same a year later as the archive
 * does — and keeps reading that way if the listing is taken down afterwards.
 *
 * @param {Object} event - The event row
 * @param {Object} winner - `{ name, authorName }` as stamped on the event
 * @returns {Object} Composer fields for `Message.create`
 */
const winnerBroadcast = (event, { name, authorName }) => compose({
  subject: `${event.title} has a winner`,
  body: `${name} by ${authorName} has won ${event.title}. Congratulations, and thank you to everyone who entered.`,
  scope: 'new'
});

module.exports = { startBroadcast, endBroadcast, cancelBroadcast, winnerBroadcast, SUBJECT_MAX, BODY_MAX };
