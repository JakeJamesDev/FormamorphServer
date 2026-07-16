const path = require('path');

/**
 * Every on-disk location the server reads or writes, in one place.
 *
 * One module rather than a copy per consumer: fileStorage, the thumbnails route, deleteUser, backupRestore,
 * and worldSnapshot all read from here, so the directories can't drift apart. Each is overridable by an
 * environment variable so user data can live outside the source tree (the defaults put uploads under
 * `src/`, which a redeploy or a clean checkout can wipe) and so tests can point at a scratch directory.
 *
 * Defaults reproduce the original hard-coded paths exactly, so an install that sets nothing is unchanged.
 */

const PROJECT_ROOT = path.join(__dirname, '..', '..');

/** Directory holding the SQLite database file. */
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');

/** The SQLite database itself. `:memory:` is honored as-is (tests), never joined to a directory. */
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'exotic-dangerous.db');

/** Root for user uploads; the worlds/thumbnails directories hang off it. */
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(PROJECT_ROOT, 'src', 'storage');

const WORLDS_DIR = path.join(STORAGE_ROOT, 'worlds');
const THUMBNAILS_DIR = path.join(STORAGE_ROOT, 'thumbnails');

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  DB_PATH,
  STORAGE_ROOT,
  WORLDS_DIR,
  THUMBNAILS_DIR,
};
