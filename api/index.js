'use strict';

// Vercel entry point: every /api/* request (and catalog pattern files) is rewritten here,
// see vercel.json. The same handler runs the local Studio (src/studio.js).
module.exports = require('../src/studio.js');
