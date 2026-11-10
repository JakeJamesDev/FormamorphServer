const paths = require('./paths');

/** The measured directories, by the name the report and `storage_days` use. */
const DIRECTORY_PARTS = {
  worlds: paths.WORLDS_DIR,
  thumbnails: paths.THUMBNAILS_DIR,
  pending: paths.PENDING_DIR,
  avatars: paths.AVATARS_DIR,
  'event-posters': paths.EVENT_POSTERS_DIR,
  'supporter-private': paths.SUPPORTER_PRIVATE_DIR,
  backups: paths.BACKUPS_DIR
};

/** Every part the report lists, always present. */
const PART_NAMES = [...Object.keys(DIRECTORY_PARTS), 'database'];

/** The paths whose filesystems are reported, in the order that joins into a disk id. */
const DISK_ROLES = {
  storage: paths.STORAGE_ROOT,
  data: paths.DATA_DIR,
  app: paths.BACKUPS_DIR
};

/** A VACUUM writes a full copy beside the file; SQLite documents up to twice the file size. */
const VACUUM_SPACE_FACTOR = 2;

module.exports = { DIRECTORY_PARTS, PART_NAMES, DISK_ROLES, VACUUM_SPACE_FACTOR };
