const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const morgan = require('morgan');
const { REQUEST_LOGS_DIR } = require('../config/paths');

/**
 * The request log, in two classes. Routine lines are successful image and poll requests: most of the volume
 * and rarely read, so they go to a daily file that is kept by age. Every other line, and every failure, goes
 * to stdout for the journal, which is kept by size.
 */

const ROUTINE_PREFIXES = ['/api/thumbnails/', '/api/avatars/'];
const ROUTINE_PATHS = ['/api/events/active'];
const ROUTINE_KEEP_DAYS = 21;

const DAY_FILE = /^routine-(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/;
const FORMAT = ':method :url :status :response-time ms - :res[content-length] :client';

/** True for a request whose line belongs in the day file. An unfinished response is never routine. */
const isRoutine = (req, res) => {
  if (!res.headersSent || res.statusCode >= 400) return false;
  const pathname = req.originalUrl.split('?')[0];

  return ROUTINE_PATHS.includes(pathname) || ROUTINE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
};

const dayOf = (date) => date.toISOString().slice(0, 10);

/**
 * A log of one file per UTC day. A past day's file is compressed, and a file older than `keepDays` is removed,
 * on the first write of each day. A failed write or tidy is reported and never thrown.
 *
 * @param {{ dir: string, keepDays: number, now?: () => Date }} options
 * @returns {{ write: (line: string) => void, flush: () => Promise<void> }}
 */
const createDailyLog = ({ dir, keepDays, now = () => new Date() }) => {
  let day = null;
  let queue = Promise.resolve();

  const tidy = async (today) => {
    const oldest = dayOf(new Date(Date.parse(today) - keepDays * 86400000));

    for (const name of await fsp.readdir(dir)) {
      const match = DAY_FILE.exec(name);
      if (!match || match[1] === today) continue;
      const file = path.join(dir, name);

      if (match[1] < oldest) {
        await fsp.unlink(file);
      } else if (!match[2]) {
        await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(`${file}.gz`));
        await fsp.unlink(file);
      }
    }
  };

  const step = (work) => {
    queue = queue.then(work).catch((error) => console.error('Request log failed:', error.message));
  };

  return {
    write(line) {
      const today = dayOf(now());
      if (today !== day) {
        day = today;
        step(async () => {
          await fsp.mkdir(dir, { recursive: true });
          await tidy(today);
        });
      }
      step(() => fsp.appendFile(path.join(dir, `routine-${today}.log`), line));
    },
    flush: () => queue
  };
};

const routineLog = createDailyLog({ dir: REQUEST_LOGS_DIR, keepDays: ROUTINE_KEEP_DAYS });

/** The two loggers, for `app.use`. The journal stamps its own lines; the day file needs the time in the line. */
const requestLoggers = () => [
  morgan(FORMAT, { skip: isRoutine }),
  morgan(`:date[iso] ${FORMAT}`, { skip: (req, res) => !isRoutine(req, res), stream: routineLog })
];

module.exports = { requestLoggers, routineLog, createDailyLog, isRoutine };
