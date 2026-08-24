/**
 * The notice a reporter receives when their Report is resolved.
 *
 * Templated here rather than typed per resolution, because the wording is the same every time and a
 * pile-on would otherwise mean writing it once per reporter. What staff do control is the optional note,
 * which is appended — and the sent message stays an ordinary message afterwards, so an admin can edit or
 * recall it through the existing routes.
 *
 * The one thing these deliberately never say is *what was done*. A reporter is owed the outcome; naming
 * the quarantine, the takedown or the suspension would turn every report into a probe of somebody else's
 * moderation record.
 */

/** The composer's caps, which these have to respect as much as a hand-written message does. */
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

const clamp = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** How each target kind reads in the notice. The name is the reporter's only handle on which report
 *  this is, so it is worth naming even when the thing itself is gone. */
const TARGET_NOUNS = {
  listing: 'listing',
  comment: 'comment',
  profile: 'profile'
};

/**
 * What the reporter is told a report was about.
 *
 * Built from the snapshot rather than from the target, for the reason the snapshot exists: the notice
 * has to read the same after the content is gone, and content going is one of the ways a report ends.
 *
 * @param {Object} report - The report row
 * @returns {string} A phrase like `the listing "Sedge Landing"`
 */
const targetPhrase = (report) => {
  const noun = TARGET_NOUNS[report.target_kind] || 'content';

  return report.target_name ? `the ${noun} "${report.target_name}"` : `a ${noun}`;
};

/**
 * The message sent to one reporter when the group their report sat in is resolved.
 *
 * @param {Object} report - The report row, for its snapshot
 * @param {string} outcome - `actioned` or `dismissed`
 * @param {string|null} [note] - The staff note, appended when there is one
 * @returns {Object} Composer fields for `Message.create`
 */
const resolutionNotice = (report, outcome, note = null) => {
  const subject = outcome === 'actioned' ? 'Your report — action taken' : 'Your report — reviewed';

  const opening = outcome === 'actioned'
    ? `Thank you for reporting ${targetPhrase(report)}. We reviewed it and took action.`
    : `Thank you for reporting ${targetPhrase(report)}. We reviewed it and found nothing that breaks the rules.`;

  const body = [opening, note ? String(note).trim() : null].filter(Boolean).join('\n\n');

  return {
    subject: clamp(subject, SUBJECT_MAX),
    body: clamp(body, BODY_MAX),
    // A resolution is news, not a warning: the reporter did nothing wrong, so the badge stays quiet.
    severity: 'info',
    // Addressed to one person, so the audience question does not arise; `existing` is the plain default.
    scope: 'existing',
    senderAs: 'team'
  };
};

module.exports = { resolutionNotice, targetPhrase, SUBJECT_MAX, BODY_MAX };
