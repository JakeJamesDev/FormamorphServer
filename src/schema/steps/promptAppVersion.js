const { addColumns } = require('../columns');
const { readWorldContentSync: readContent } = require('../../utils/fileStorage');
const { appVersionOf } = require('../../utils/appVersion');

/**
 * The app version a prompt listing's preset was made for, copied from its content at publish.
 *
 * A column so the details read shows it without reading the content, which counts a download. Null for
 * every other kind. Prompt rows published before the column are backfilled from their stored files.
 */
const apply = (database) => {
  if (addColumns(database, 'worlds', [['app_version', 'TEXT']]).length === 0) return false;

  const prompts = database.prepare("SELECT id, content_file FROM worlds WHERE kind = 'prompt' AND content_file IS NOT NULL").all();
  const write = database.prepare('UPDATE worlds SET app_version = ? WHERE id = ?');
  for (const row of prompts) write.run(appVersionOf(readContent(row.content_file)), row.id);

  return true;
};

module.exports = { name: 'promptAppVersion', apply };
