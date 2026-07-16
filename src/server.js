require('dotenv').config();
const { initStorage } = require('./utils/fileStorage');
const { addKindColumn } = require('./utils/addKindColumn');
const app = require('./app');

// Bring the schema up to date before serving. Every list query filters on `worlds.kind`, so booting
// against a database that predates it would 500 the entire catalog until someone ran the migration by
// hand — the deploy order must not be able to cause an outage. The migration is additive and idempotent,
// so this is a no-op on every boot after the first. `npm run migrate-kind` still runs it ahead of a deploy.
//
// Never fatal: a migration that throws must not take the process down, or a bad database turns into a
// boot loop under any restart policy. Booting with a loud error leaves the operator a running server to
// diagnose from, which is what this server did before the migration existed.
try {
  addKindColumn();
} catch (error) {
  console.error('Schema migration failed — starting anyway; list endpoints may fail until resolved:', error);
}

// Initialize storage directories
initStorage();

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
