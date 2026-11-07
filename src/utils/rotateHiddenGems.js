const { hourly } = require('./hourly');
const { HiddenGem } = require('../models/HiddenGem');

/**
 * Rotate the Hidden Gems when a rotation is due. Never throws: it runs on a timer, and the next hourly
 * tick retries.
 *
 * @param {Date} [now] - The run's time, for tests
 * @returns {string[]|null} The new picks, or null when none was due or the run failed
 */
const rotateHiddenGems = (now = new Date()) => {
  try {
    return HiddenGem.rotate(now);
  } catch (error) {
    console.error('Hidden Gem rotation failed:', error);
    return null;
  }
};

const startHiddenGemRotation = () => hourly(() => rotateHiddenGems());

module.exports = { rotateHiddenGems, startHiddenGemRotation };
