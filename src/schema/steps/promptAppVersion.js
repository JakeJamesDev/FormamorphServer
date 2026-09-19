const fs = require('fs');
const path = require('path');
const { addColumns } = require('../columns');
const { WORLDS_DIR } = require('../../config/paths');
const { appVersionOf } = require('../../utils/appVersion');

/** A stored content file's parsed JSON, or null when it is gone or unreadable. */
const readContent = (fileName) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, fileName), 'utf8'));
  } catch {
    return null;
  }
};

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
