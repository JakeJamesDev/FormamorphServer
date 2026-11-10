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

/** The R2 free tier is account-wide: 10 GB of storage across all buckets. */
const R2_FREE_TIER_BYTES = 10 * 1000 ** 3;

/** The Cloudflare GraphQL endpoint and how far back the newest storage row is looked for. */
const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const R2_WINDOW_DAYS = 7;
const R2_READ_TIMEOUT_MS = 15000;

/**
 * The R2 read's settings from the server env, or null when any is missing. Read per call so a test can set them.
 *
 * @returns {{ token: string, accountId: string, buckets: string[] }|null} The settings, or null when R2 is off
 */
const r2Settings = () => {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountId = process.env.R2_ACCOUNT_ID;
  const buckets = [...new Set([process.env.R2_BUCKET, process.env.R2_BACKUP_BUCKET])];

  if (!token || !accountId || buckets.some((bucket) => !bucket)) return null;

  return { token, accountId, buckets };
};

/** The `storage_days` name of a bucket's row. */
const r2PartName = (bucket) => `r2:${bucket}`;

/** The `?days=N` of the report: default and upper bound. Storage rows are kept forever, so the bound is a trend length. */
const REPORT_DEFAULT_DAYS = 30;
const REPORT_MAX_DAYS = 365;

/** The forecast fits the last `FORECAST_WINDOW_DAYS` UTC days and needs `FORECAST_MIN_DAYS` of them measured. */
const FORECAST_WINDOW_DAYS = 30;
const FORECAST_MIN_DAYS = 7;

module.exports = {
  r2PartName,
  DIRECTORY_PARTS, PART_NAMES, DISK_ROLES, VACUUM_SPACE_FACTOR,
  R2_FREE_TIER_BYTES, CLOUDFLARE_GRAPHQL_URL, R2_WINDOW_DAYS, R2_READ_TIMEOUT_MS, r2Settings,
  REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, FORECAST_WINDOW_DAYS, FORECAST_MIN_DAYS
};
