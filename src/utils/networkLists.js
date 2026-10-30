const fs = require('fs');
const path = require('path');
const { NETWORK_LISTS } = require('../config/networkKind');
const { NETWORK_LISTS_DIR } = require('../config/paths');
const { networkClassifier } = require('./networkClassifier');
const { daily } = require('./hourly');

/** Long enough for the largest list, about 700 KB, on a slow link. */
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

/**
 * Fetch one list as text.
 *
 * @param {string} url - Where the list lives
 * @returns {Promise<string>} Its body
 * @throws {Error} On a network failure, a timeout or a status other than 2xx
 */
const download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response.text();
};

const fileFor = (dir, name) => path.join(dir, `${name}.txt`);

/**
 * Load every list that has a copy on disk into the classifier.
 *
 * A copy that will not read or parse is skipped with a log line, and the next refresh replaces it.
 *
 * @param {Object} [options]
 * @param {Object} [options.classifier] - Where the lists go; the shared one by default
 * @param {string} [options.dir] - Where the copies live
 * @returns {string[]} The names of the lists loaded
 */
const loadNetworkLists = ({ classifier = networkClassifier, dir = NETWORK_LISTS_DIR } = {}) => {
  const loaded = [];

  for (const { name } of NETWORK_LISTS) {
    const file = fileFor(dir, name);
    if (!fs.existsSync(file)) continue;

    try {
      classifier.load(name, fs.readFileSync(file, 'utf8'));
      loaded.push(name);
    } catch (error) {
      console.error(`Network list ${name} on disk was not loaded:`, error.message);
    }
  }

  return loaded;
};

/**
 * Download every list, and put each one that parses on disk and into the classifier.
 *
 * A list that fails to download or to parse keeps its previous copy, on disk and in memory, and says so
 * on the console, so a list stuck on an old copy is visible. Each list is handled on its own.
 *
 * Never throws: it runs on a timer nobody is watching.
 *
 * @param {Object} [options]
 * @param {Object} [options.classifier] - Where the lists go; the shared one by default
 * @param {string} [options.dir] - Where the copies live
 * @param {Function} [options.fetchList] - `url => Promise<text>`, for tests
 * @returns {Promise<{ loaded: string[], refused: string[] }>} The lists replaced, and the lists kept
 */
const refreshNetworkLists = async ({
  classifier = networkClassifier,
  dir = NETWORK_LISTS_DIR,
  fetchList = download
} = {}) => {
  const result = { loaded: [], refused: [] };

  for (const { name, url } of NETWORK_LISTS) {
    try {
      const text = await fetchList(url);
      classifier.load(name, text);

      // Written after the parse, so the disk only ever holds a copy that loaded. The rename keeps a crash
      // mid-write from leaving half a list behind.
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = fileFor(dir, name);
        fs.writeFileSync(`${file}.tmp`, text);
        fs.renameSync(`${file}.tmp`, file);
      } catch (error) {
        console.error(`Network list ${name} loaded but was not saved:`, error.message);
      }

      result.loaded.push(name);
    } catch (error) {
      console.error(`Network list ${name} was refused:`, error.message);
      result.refused.push(name);
    }
  }

  return result;
};

/**
 * Load the copies on disk, download now if any list has none, then refresh once a day.
 *
 * Runs whether collection is on or off, so the lists are ready when the operator switches it on.
 *
 * @returns {Object} The interval handle
 */
const startNetworkLists = () => {
  const loaded = loadNetworkLists();
  if (loaded.length < NETWORK_LISTS.length) void refreshNetworkLists();

  return daily(refreshNetworkLists);
};

module.exports = { loadNetworkLists, refreshNetworkLists, startNetworkLists };
