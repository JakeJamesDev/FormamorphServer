const path = require('path');
const dotenv = require('dotenv');

/**
 * Load the repo's `.env` into an entry point's process, whatever directory the shell is in.
 *
 * Required first by the server and every operator script, before anything opens the database. Never by a
 * module the tests load, so no local key reaches the suite. `ENV_FILE` names another file, or a missing one.
 */
const envFile = process.env.ENV_FILE || path.resolve(__dirname, '../../.env');
dotenv.config({ path: envFile });

module.exports = { envFile };
