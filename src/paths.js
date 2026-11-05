'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// On Vercel the bundle is read-only: downloads and painted plates go to /tmp, seeded from the
// files shipped in cache/ (fonts and storefront lists) so a cold start needs no network.
const ON_VERCEL = !!process.env.VERCEL;
const CACHE_ROOT = ON_VERCEL ? path.join(os.tmpdir(), 'hygp-cache') : path.join(ROOT, 'cache');

function cachePath(...parts) {
  return path.join(CACHE_ROOT, ...parts);
}

if (ON_VERCEL) {
  for (const sub of ['engraving-fonts', 'shop']) {
    const from = path.join(ROOT, 'cache', sub), to = path.join(CACHE_ROOT, sub);
    try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, preserveTimestamps: true }); } catch (err) { console.warn(`cache seed ${sub}: ${err.message}`); }
  }
}
const SCREENSHOT_ROOT = path.resolve(ROOT, '..', 'B2B-screenshot');

function fromRoot(...parts) {
  return path.join(ROOT, ...parts);
}

module.exports = { ROOT, SCREENSHOT_ROOT, fromRoot, cachePath, ON_VERCEL };
