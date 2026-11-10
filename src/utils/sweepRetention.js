const { hourly } = require('./hourly');
const Signal = require('../models/Signal');
const AnonymousLike = require('../models/AnonymousLike');
const World = require('../models/World');
const ActiveInstall = require('../models/ActiveInstall');
const MailLog = require('../models/MailLog');
const { utcDay } = require('../config/time');

/**
 * Let go of everything the retention promise says is let go of.
 *
 * Retention is a promise the privacy policy makes in writing, so it is kept by code that runs whether
 * anyone is watching or not: once at boot, to clear whatever expired while the server was down, and then
 * hourly. Unlike the quarantine sweeper there is no lazy read path, because nothing reads these tables on
 * a request an ordinary user makes — the staff views ask for matches inside retention themselves.
 *
 * Three address steps, because the rows expire differently. A Signal is nothing but where an account acted
 * from, so the whole row goes. An Anonymous Like is a like as well as an address, and the like is not
 * the operator's to take away with it, so only where it came from goes — hash, browser family and
 * Network Kind — and the number a listing shows does not move. An account Like loses only its Network
 * Kind. One deadline over all three, which is the Signal's: an address is an address whichever table it
 * sits in, and two windows would be two promises.
 *
 * Each step is caught on its own, the way the event sweeper catches each transition. They share the
 * deadline and nothing else, and a table that will not write must not keep another from expiring.
 *
 * A fourth step, the Month Close, runs first, on the calendar month of `now` rather than the deadline, so a
 * deadline that will not read never holds it back. The mail log follows, on its own 90-day deadline.
 *
 * Never throws, down to reading the deadline. This runs on a timer nobody is watching; a failure to
 * purge must not take the process down.
 *
 * @param {string} [now] - The instant to measure retention back from, for tests
 * @returns {{signals: number, marks: number, kinds: number, months: number, mails: number}} Signals deleted,
 *   marks emptied, account Likes that lost their kind, Active Install months closed, and mail-log rows deleted
 */
const sweepRetention = (now = undefined) => {
  const swept = { signals: 0, marks: 0, kinds: 0, months: 0, mails: 0 };

  try {
    swept.months = ActiveInstall.closeMonthsBefore(utcDay(now ? new Date(now) : new Date()).slice(0, 7));
  } catch (error) {
    console.error('Active Install month close failed:', error);
  }

  try {
    swept.mails = MailLog.deleteBefore(MailLog.cutoff(now));
  } catch (error) {
    console.error('Mail log sweep failed:', error);
  }

  let cutoff;
  try {
    cutoff = Signal.cutoff(now);
  } catch (error) {
    console.error('Retention sweep could not read its deadline:', error);
    return swept;
  }

  try {
    swept.signals = Signal.deleteBefore(cutoff);
  } catch (error) {
    console.error('Signal sweep failed:', error);
  }

  try {
    swept.marks = AnonymousLike.blankOriginsBefore(cutoff);
  } catch (error) {
    console.error('Anonymous Like origin sweep failed:', error);
  }

  try {
    swept.kinds = World.blankNetworkKindsBefore(cutoff);
  } catch (error) {
    console.error('Like network kind sweep failed:', error);
  }

  return swept;
};

const startRetentionSweeper = () => hourly(sweepRetention);

module.exports = { sweepRetention, startRetentionSweeper };
