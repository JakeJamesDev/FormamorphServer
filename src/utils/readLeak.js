const sharp = require('sharp');
const { read } = require('./watermark');
const WatermarkMark = require('../models/WatermarkMark');

/**
 * Read the watermark out of a leaked image file and name the account it was made for.
 *
 * @param {string} filePath - Any image `sharp` can decode: WebP, PNG, JPEG, a screenshot
 * @returns {Promise<Object>} `{ mark, account }`; `mark` is null when none is found, `account` is null
 *   when no account holds the mark (one erased since, say)
 */
const readLeak = async (filePath) => {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mark = read({ width: info.width, height: info.height, data });
  return { mark, account: mark === null ? null : WatermarkMark.accountFor(mark) };
};

/** One line for a person to read. */
const describeLeak = ({ mark, account }) => {
  if (mark === null) return 'No mark found';
  const hex = `0x${mark.toString(16).padStart(8, '0')}`;
  return account
    ? `Mark ${hex}: account ${account.id} (${account.username})`
    : `Mark ${hex}: no account holds it`;
};

module.exports = { readLeak, describeLeak };
