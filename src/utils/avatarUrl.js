/**
 * The public URL of a stored profile image, or null when the account has none.
 *
 * One helper rather than the expression repeated per DTO: the catalog, comments, feedback threads and the
 * admin table all carry an avatar, and a path built four times is a path that drifts three ways.
 *
 * Keyed on the filename rather than the account, so the URL is immutable — an upload writes a new UUID,
 * which means the old URL is never reused and a replacement can never come back from a cache. That is
 * also why there is no version query parameter: the filename is the version.
 *
 * @param {string|null|undefined} avatarFile - The `avatar_file` column
 * @returns {string|null} The URL, or null
 */
const avatarUrlFor = (avatarFile) => (avatarFile ? `/api/avatars/${avatarFile}` : null);

module.exports = { avatarUrlFor };
