require('dotenv').config();
const { initStorage } = require('./utils/fileStorage');
const { addKindColumn } = require('./utils/addKindColumn');
const { addQuarantineColumns } = require('./utils/addQuarantineColumns');
const { addAvatarColumns } = require('./utils/addAvatarColumns');
const { addAuthorRoleColumn } = require('./utils/addAuthorRoleColumn');
const { addReporterRoleColumn } = require('./utils/addReporterRoleColumn');
const { addActorRoleColumn } = require('./utils/addActorRoleColumn');
const { addFeedbackEditedColumn } = require('./utils/addFeedbackEditedColumn');
const { addFeedSeenColumn } = require('./utils/addFeedSeenColumn');
const { addTokenVersionColumn } = require('./utils/addTokenVersionColumn');
const { createTables, createIndexes } = require('./utils/initDb');
const { sweepQuarantine, startQuarantineSweeper } = require('./utils/sweepQuarantine');
const app = require('./app');

// Bring the schema up to date before serving, so a deploy that adds a table needs nothing run by hand.
// Without this, forgetting `npm run init-db` leaves the new endpoints answering `no such table` — an
// outage caused by a step nobody sees until it is missed.
//
// Both halves are safe to repeat. `createTables`/`createIndexes` are `IF NOT EXISTS` throughout, and the
// kind migration is additive and idempotent, so every boot after the first is a no-op. Note the split in
// what they can do: creating a *table* is covered here, but neither adds a *column* to a table that
// already exists — that still needs its own migration, which is exactly what `addKindColumn` is.
//
// `npm run init-db` still exists to run ahead of a deploy, and additionally seeds the admin account.
//
// Never fatal: a schema step that throws must not take the process down, or a bad database turns into a
// boot loop under any restart policy. Booting with a loud error leaves the operator a running server to
// diagnose from, which is what this server did before any of this existed.
//
// Order matters: the column migrations run before the indexes, because an index may name a column a
// migration is what adds. Indexing first would throw on exactly the databases the migration exists for,
// and take the migration down with it.
try {
  createTables();
  addKindColumn();
  addQuarantineColumns();
  addAvatarColumns();
  addAuthorRoleColumn();
  addReporterRoleColumn();
  addActorRoleColumn();
  addFeedbackEditedColumn();
  addFeedSeenColumn();
  addTokenVersionColumn();
  createIndexes();
} catch (error) {
  console.error('Schema setup failed — starting anyway; some endpoints may fail until resolved:', error);
}

// Initialize storage directories
initStorage();

// Clear anything whose quarantine ran out while the server was down, then keep checking on a timer. The
// catalog routes sweep too, so a missed tick can never serve a listing past its deadline.
void sweepQuarantine();
startQuarantineSweeper();

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
