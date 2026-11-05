'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_ROOT = path.resolve(ROOT, '..', 'B2B-screenshot');

function fromRoot(...parts) {
  return path.join(ROOT, ...parts);
}

module.exports = { ROOT, SCREENSHOT_ROOT, fromRoot };
