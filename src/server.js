require('dotenv').config();

// Before anything opens a database or serves a request: a Signal's whole protection is that the address is
// salted before it is hashed, and an unsalted hash of an address is a lookup table away from the address.
// A deploy that forgets the salt must not write one row, so this is fatal rather than loud — the only
// environment check this server makes, and the one where carrying on is worse than not starting.
if (!process.env.SIGNAL_SALT) {
  console.error('SIGNAL_SALT is not set — refusing to start rather than write unsalted address hashes.');
  process.exit(1);
}

const db = require('./config/db');
const { migrate } = require('./schema');
const { initStorage } = require('./utils/fileStorage');
const { sweepQuarantine, startQuarantineSweeper } = require('./utils/sweepQuarantine');
const { sweepEvents, startEventSweeper } = require('./utils/sweepEvents');
const { sweepSignals, startSignalSweeper } = require('./utils/sweepSignals');
const { sweepDeletions, startDeletionSweeper } = require('./utils/sweepDeletions');
const app = require('./app');

// Bring the schema up to date before serving, so a deploy that adds a table or a column needs nothing run
// by hand. Without this, forgetting `npm run init-db` leaves the new endpoints answering `no such table` —
// an outage caused by a step nobody sees until it is missed. `npm run init-db` still exists to run ahead
// of a deploy, and additionally seeds the admin account.
//
// Never fatal: a failed step must not take the process down, or a bad database turns into a boot loop
// under any restart policy. Booting with a loud error leaves the operator a running server to diagnose
// from, which is what this server did before any of this existed.
try {
  migrate(db);
} catch (error) {
  console.error('Schema setup failed — starting anyway; some endpoints may fail until resolved:', error);
}

// Initialize storage directories
initStorage();

// Clear anything whose quarantine ran out while the server was down, then keep checking on a timer. The
// catalog routes sweep too, so a missed tick can never serve a listing past its deadline.
void sweepQuarantine();
startQuarantineSweeper();

// The same arrangement for event windows: open or close anything whose moment passed while the server
// was down, then keep checking. The events routes sweep too, so a missed tick can never show a banner
// for something that is over.
void sweepEvents();
startEventSweeper();

// And for the Signals: purge whatever passed its 90 days while the server was down, then keep purging.
// Retention is a promise the privacy policy makes in writing, so nothing here waits for a reader.
sweepSignals();
startSignalSweeper();

// And for the accounts that asked to go: erase whatever came due while the server was down, then keep
// erasing. A user was told a date, so the wait must not depend on the process having stayed up.
void sweepDeletions();
startDeletionSweeper();

// Set port
const PORT = process.env.PORT || 8797;

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
