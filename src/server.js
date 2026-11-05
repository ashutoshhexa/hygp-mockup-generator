'use strict';

/**
 * Listing Studio server.
 *   /listing       client page: the main Etsy photo only, with a download button
 *   /              Studio UI (listing preview + template editor)
 *   /api/state     patterns, templates, frames, current decision, presets
 *   /api/templates/:id      GET / POST (save geometry from the editor)
 *   /api/engraving.png      engraving raster (name, phone, font, phoneFont, w), same code path as export
 *   /api/phone              a random 419-555-XXXX number
 *   /api/background.png     background plate preset
 *   /api/decision           POST: save the working decision
 *   /api/export             POST: render all frames at full size into out/listings/
 *   /api/backgrounds        POST: upload an empty background plate
 *   /api/collections        storefront pattern collections (src/catalog.js)
 *   /api/collections/:id/patterns   patterns in one collection
 *   /files/...              read-only access to poc/ (photos, patterns, plates)
 *   /files/cache/patterns/<id>.png  a catalog pattern, downloaded on first use
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const { fromRoot } = require('./paths');
const { FINISHES, decideListing } = require('./decide');
const { rasterizeEngraving, randomPhone } = require('./engraving');
const { fontList, warmFonts, resolveFontName, PHONE_FONT, DEFAULT_FONT } = require('./fonts');
const catalog = require('./catalog');
const { listPresets } = require('./background');
const { renderListing, readTemplate, readJson, backgroundPng } = require('./mockup/node-io');

const PORT = Number(process.env.PORT) || 4173;
const WORKING_DECISION = fromRoot('decisions', 'preview.json');
const DEFAULT_DECISION = fromRoot('decisions', 'christmas-gingerbread.json');

const PATTERN_LABELS = {
  'image (81).png': 'Candy stripes',
  'image (82).png': 'Santa',
  'image (84).png': 'Gingerbread',
};

// image (53) is a dog photo that was dropped in the patterns folder
const NOT_PATTERNS = new Set(['image (53).png']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

function slug(text) {
  return String(text || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'listing';
}

function listPatterns() {
  const dir = fromRoot('poc', 'patterns');
  return fs.readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name) && !NOT_PATTERNS.has(name))
    .map((name) => ({ file: `poc/patterns/${name}`, label: PATTERN_LABELS[name] || name.replace(/\.[^.]+$/, '') }));
}

function listTemplates() {
  const order = readJson('frames.json').frames.map((f) => f.template);
  const rank = (id) => (order.indexOf(id) === -1 ? 99 : order.indexOf(id));
  return fs.readdirSync(fromRoot('templates'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      const t = readTemplate(n.replace(/\.json$/, ''));
      return { id: t.id, name: t.name, base: t.base, width: t.width, height: t.height };
    })
    .sort((a, b) => rank(a.id) - rank(b.id));
}

function listBackgroundFiles() {
  const dir = fromRoot('poc', 'backgrounds');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .map((n) => ({ file: `poc/backgrounds/${n}`, label: n.replace(/\.[^.]+$/, '') }));
}

function currentDecision() {
  const file = fs.existsSync(WORKING_DECISION) ? WORKING_DECISION : DEFAULT_DECISION;
  const decision = JSON.parse(fs.readFileSync(file, 'utf8'));
  // older decisions named Windows fonts; map them onto the storefront list
  for (const c of (decision.listing && decision.listing.collars) || []) {
    c.font = resolveFontName(c.font);
    if (c.phoneFont) c.phoneFont = resolveFontName(c.phoneFont);
  }
  // a background file that was removed from the picker falls back to the default preset
  const l = decision.listing || {};
  if (l.backgroundFile && !fs.existsSync(fromRoot(l.backgroundFile))) delete l.backgroundFile;
  return decision;
}

// Templates are hand-edited too, so keep number arrays on one line.
function compactJson(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([-\d.e]+(?:,\s+[-\d.e]+)*)\s+\]/g, (m, inner) => `[${inner.split(/,\s+/).join(', ')}]`);
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendFile(res, file, cache = 'no-store') {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
}

// resolve a URL path inside a root folder, refusing traversal
function safeJoin(rootDir, rel) {
  const full = path.resolve(rootDir, '.' + path.sep + decodeURIComponent(rel));
  if (!full.startsWith(path.resolve(rootDir) + path.sep)) return null;
  return full;
}

function validateDecision(decision) {
  const tmp = fromRoot('decisions', '.validate.json');
  fs.writeFileSync(tmp, JSON.stringify(decision));
  try { return decideListing(tmp); } finally { fs.unlinkSync(tmp); }
}

const engravingCache = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(__dirname, 'ui', 'index.html'));
    if (req.method === 'GET' && (p === '/listing' || p === '/listing/')) return sendFile(res, path.join(__dirname, 'ui', 'listing.html'));
    if (req.method === 'GET' && p.startsWith('/ui/')) {
      const f = safeJoin(path.join(__dirname, 'ui'), p.slice(4));
      return f ? sendFile(res, f) : sendJson(res, 400, { error: 'bad path' });
    }
    if (req.method === 'GET' && p.startsWith('/mockup/')) {
      const f = safeJoin(path.join(__dirname, 'mockup'), p.slice(8));
      return f ? sendFile(res, f) : sendJson(res, 400, { error: 'bad path' });
    }
    // catalog patterns: downloaded on first use, then served from cache/patterns/
    if (req.method === 'GET' && p.startsWith('/files/cache/patterns/')) {
      const f = await catalog.ensurePatternFile(p.slice('/files/'.length));
      return f ? sendFile(res, f, 'max-age=86400') : sendJson(res, 400, { error: 'bad path' });
    }
    if (req.method === 'GET' && p === '/api/collections') return sendJson(res, 200, { collections: await catalog.listCollections() });
    const cm = p.match(/^\/api\/collections\/(\d+)\/patterns$/);
    if (req.method === 'GET' && cm) return sendJson(res, 200, { patterns: await catalog.listPatterns(cm[1]) });
    if (req.method === 'GET' && p.startsWith('/files/')) {
      const f = safeJoin(fromRoot('poc'), p.slice('/files/poc/'.length));
      if (!p.startsWith('/files/poc/') || !f) return sendJson(res, 400, { error: 'bad path' });
      return sendFile(res, f, 'max-age=60');
    }
    if (req.method === 'GET' && p.startsWith('/out/')) {
      const f = safeJoin(fromRoot('out'), p.slice(5));
      return f ? sendFile(res, f) : sendJson(res, 400, { error: 'bad path' });
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        patterns: listPatterns(),
        templates: listTemplates(),
        frames: readJson('frames.json'),
        decision: currentDecision(),
        finishes: FINISHES,
        fonts: fontList().map((f) => ({ name: f.name, preview: f.preview })),
        phoneFont: PHONE_FONT,
        presets: listPresets(),
        backgroundFiles: listBackgroundFiles(),
      });
    }

    const tm = p.match(/^\/api\/templates\/([a-z0-9-]+)$/i);
    if (tm && req.method === 'GET') return sendJson(res, 200, readTemplate(tm[1]));
    if (tm && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.layers) || !body.base) throw new Error('Not a template.');
      body.id = tm[1];
      fs.writeFileSync(fromRoot('templates', `${tm[1]}.json`), compactJson(body) + '\n');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/engraving.png') {
      const name = url.searchParams.get('name') || '';
      const phone = url.searchParams.get('phone') || '';
      const font = url.searchParams.get('font') || DEFAULT_FONT;
      const phoneFont = url.searchParams.get('phoneFont') || PHONE_FONT;
      // w: smaller rasters for the font picker tiles; the buckle itself uses the default 1400
      const width = Math.max(120, Math.min(1400, Number(url.searchParams.get('w')) || 1400));
      const key = `${name}|${phone}|${font}|${phoneFont}|${width}`;
      let png = engravingCache.get(key);
      if (!png) {
        png = await rasterizeEngraving({ name, phone, font, phoneFont, width });
        if (!png) { res.writeHead(204); return res.end(); }
        if (engravingCache.size > 600) engravingCache.clear();
        engravingCache.set(key, png);
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      return res.end(png);
    }

    if (req.method === 'GET' && p === '/api/phone') return sendJson(res, 200, { phone: randomPhone() });

    if (req.method === 'GET' && p === '/api/background.png') {
      const w = Math.min(4096, Number(url.searchParams.get('w')) || 1024);
      const h = Math.min(4096, Number(url.searchParams.get('h')) || 1024);
      const preset = url.searchParams.get('preset') || 'winter-linen';
      const png = await backgroundPng({ kind: 'preset', preset }, w, h);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      return res.end(png);
    }

    if (req.method === 'POST' && p === '/api/decision') {
      const body = await readBody(req);
      validateDecision(body);
      fs.writeFileSync(WORKING_DECISION, JSON.stringify(body, null, 2));
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/backgrounds') {
      const body = await readBody(req);
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(body.dataUrl || '');
      if (!m) throw new Error('Upload a PNG, JPG or WebP image.');
      const dir = fromRoot('poc', 'backgrounds');
      fs.mkdirSync(dir, { recursive: true });
      const name = `${slug(body.name || 'background')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
      return sendJson(res, 200, { file: `poc/backgrounds/${name}` });
    }

    if (req.method === 'POST' && p === '/api/export') {
      const body = await readBody(req);
      validateDecision(body);
      fs.writeFileSync(WORKING_DECISION, JSON.stringify(body, null, 2));
      const started = Date.now();
      const results = await renderListing(body, { exportScale: 2 });
      const folder = slug(body.patternLabel || path.basename(body.patternFile));
      const dir = fromRoot('out', 'listings', folder);
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      for (const r of results) {
        fs.writeFileSync(path.join(dir, r.frame.file), r.png);
        files.push({ id: r.frame.id, label: r.frame.label, url: `/out/listings/${folder}/${r.frame.file}?t=${Date.now()}` });
      }
      fs.writeFileSync(path.join(dir, 'decision.json'), JSON.stringify(body, null, 2));
      return sendJson(res, 200, { folder: dir, files, ms: Date.now() - started });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

// storefront engraving fonts are fetched (and cached) before the Studio opens
warmFonts()
  .then((fonts) => console.log(`Engraving fonts: ${fonts.map((f) => f.name).join(', ')}`))
  .catch((err) => console.warn(`Engraving fonts unavailable: ${err.message}`))
  .finally(() => server.listen(PORT, '127.0.0.1', () => {
    console.log(`Listing Studio: http://127.0.0.1:${PORT}  (client page: /listing)`);
    warmBackgrounds();
  }));

// paint every preset at the main photo's size once (cached on disk in cache/backgrounds/)
async function warmBackgrounds() {
  const hero = readTemplate(readJson('frames.json').frames[0].template);
  for (const p of listPresets()) {
    try { await backgroundPng({ kind: 'preset', preset: p.id }, hero.width, hero.height); } catch (err) { console.warn(`Background ${p.id}: ${err.message}`); }
  }
}
