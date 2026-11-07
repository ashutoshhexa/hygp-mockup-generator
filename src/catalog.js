'use strict';

/**
 * Pattern catalog: the storefront's Shopify collections and the patterns inside them.
 *   GET https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection/            -> collections
 *   GET https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection/products/:id -> patterns
 * A pattern's print file (png_image, a seamless square tile) is downloaded once to
 * cache/patterns/<productId>.png.
 *
 * Print framing: the store places the tile on the collar with dataX (per size: scale,
 * translateX, translateY). Measured against the store's own 20 mm print TIFFs (tiff_20mm):
 *   - the strap is `scale` x the tile height tall (tile height = strap / scale)
 *   - the strap centre sits at (0.5 + translateY / 2) of the tile height
 * So instead of the TIFF (CMYK, duller, half the pixels, missing for ~12% of patterns)
 * we cut the same window from the bright PNG: cache/patterns/<id>.s<scale>.x<tx>.y<ty>.png
 * is one horizontal repeat whose height is exactly the strap, so the renderer's
 * patternScale 1 = true print size.
 */
const fs = require('fs');
const path = require('path');

const { cachePath } = require('./paths');

const API = 'https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection';
const CACHE = cachePath('shop');
const PATTERN_DIR = cachePath('patterns');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PATTERN_FILE = /^cache\/patterns\/(\d+)(?:\.s([\d.]+)\.x(-?[\d.]+)\.y(-?[\d.]+))?\.png$/;

async function cachedJson(name, url, maxAge = MAX_AGE_MS, dir = CACHE) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAge) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  } catch (err) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    throw new Error(`Could not load ${url}: ${err.message}`);
  }
}

// The collar placement from a product's dataX (a flat list, or { collar: [...] }).
// Sizes almost always agree; take the most common entry.
function printFraming(dataX) {
  let d;
  try { d = typeof dataX === 'string' ? JSON.parse(dataX) : dataX; } catch { return null; }
  const list = Array.isArray(d) ? d : d && Array.isArray(d.collar) ? d.collar : null;
  if (!list) return null;
  const counts = new Map();
  for (const e of list) {
    if (!(e && e.scale > 0)) continue;
    const key = [e.scale, e.translateX || 0, e.translateY || 0].map((v) => +(+v).toFixed(4)).join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return null;
  const [scale, tx, ty] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split('|').map(Number);
  return { scale, tx, ty };
}

function patternFileFor(productId, framing) {
  if (!framing || (framing.scale === 1 && !framing.tx && !framing.ty)) return `cache/patterns/${productId}.png`;
  return `cache/patterns/${productId}.s${framing.scale}.x${framing.tx}.y${framing.ty}.png`;
}

async function listCollections() {
  const data = await cachedJson('collections.json', `${API}/`);
  return (data.custom_collections || []).map((c) => ({
    id: String(c.id),
    title: c.title,
    image: c.image || null,
    isDefault: !!c.Default_collection,
  }));
}

async function listPatterns(collectionId) {
  if (!/^\d+$/.test(String(collectionId))) throw new Error('Bad collection id');
  const data = await cachedJson(`products-${collectionId}.json`, `${API}/products/${collectionId}`);
  if (data.pageInfo && data.pageInfo.hasNextPage) {
    console.warn(`Collection ${collectionId}: more patterns than one page; showing the first ${data.products.length}.`);
  }
  return (data.products || []).filter((p) => p.png_image).map((p) => ({
    id: String(p.id),
    label: String(p.name || p.id).replace(/_/g, ' ').trim(),
    thumb: p.preview || null,
    file: patternFileFor(p.id, printFraming(p.dataX)),
    url: p.png_image,
  }));
}

/** Make sure a catalog pattern is on disk. Local files (poc/patterns/...) pass through. */
async function ensurePatternFile(rel) {
  const lm = LEGACY_FILE.exec(String(rel || '').replace(/\\/g, '/'));
  if (lm) return ensureLegacyFile(lm[1], lm[2]);
  const m = PATTERN_FILE.exec(String(rel || '').replace(/\\/g, '/'));
  if (!m) return null;
  const tile = await ensureTile(m[1]);
  if (m[2] == null) return tile;
  const file = path.join(PATTERN_DIR, path.basename(String(rel)));
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const png = await framePrint(tile, { scale: +m[2], tx: +m[3], ty: +m[4] });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, png);
  fs.renameSync(tmp, file);
  return file;
}

// Cut the strap-high window out of the repeating tile (see the header comment).
async function framePrint(tileFile, { scale, tx, ty }) {
  const sharp = require('sharp');
  const { data, info } = await sharp(tileFile).raw().toBuffer({ resolveWithObject: true });
  const pw = info.width, ph = info.height, ch = info.channels;
  const oh = Math.max(1, Math.round(ph * scale));
  const top = Math.round((0.5 + ty / 2) * ph - oh / 2);
  const x0 = mod(Math.round((tx / 2) * pw), pw);
  const row = pw * ch;
  const out = Buffer.alloc(row * oh);
  for (let y = 0; y < oh; y++) {
    const src = mod(y + top, ph) * row, dst = y * row;
    // one horizontal repeat starting at x0, wrapping around
    data.copy(out, dst, src + x0 * ch, src + row);
    data.copy(out, dst + (pw - x0) * ch, src, src + x0 * ch);
  }
  return sharp(out, { raw: { width: pw, height: oh, channels: ch } })
    .withMetadata({ density: info.density || 300 })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

async function ensureTile(id) {
  const file = path.join(PATTERN_DIR, `${id}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const url = `https://d1ows48k9hyw72.cloudfront.net/metafields/${id}/image.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download pattern ${id}: HTTP ${res.status}`);
  fs.mkdirSync(PATTERN_DIR, { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
  return file;
}

// Older designs saved the raw tile (cache/patterns/<id>.png). Point them at the print-framed
// file, using whichever cached collection lists that product. Unknown ids stay as they are.
function framedFile(rel) {
  const m = PATTERN_FILE.exec(String(rel || ''));
  if (!m || m[2] != null || !fs.existsSync(CACHE)) return rel;
  for (const name of fs.readdirSync(CACHE)) {
    if (!/^products-\d+\.json$/.test(name)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8')); } catch { continue; }
    const p = (data.products || []).find((x) => String(x.id) === m[1]);
    if (p) return patternFileFor(p.id, printFraming(p.dataX));
  }
  return rel;
}

/* ---------------- legacy patterns ----------------
 * GET .../legacy-patterns -> { patterns: [{ name: "0871", tiff_20mm: <signed S3 url, 6 h> }] }
 * Only the 20 mm print TIFF exists (sRGB, 500 dpi, 28 mm tall = 20 mm strap + 4 mm bleed above
 * and below, one horizontal repeat). The strap band is cut out once and cached as
 * cache/legacy/<name>.png (patternScale 1 = true print size) plus a small square thumbnail.
 */
const LEGACY_DIR = cachePath('legacy');
const LEGACY_FILE = /^cache\/legacy\/([A-Za-z0-9_-]{1,40})(\.png|\.thumb\.jpg)$/;
const LEGACY_MAX_AGE_MS = 4 * 60 * 60 * 1000; // links expire after 6 h
const BLEED_MM = 4, STRIP_MM = 28;
let legacyMemo = null;

async function legacyIndex() {
  if (legacyMemo && Date.now() - legacyMemo.at < LEGACY_MAX_AGE_MS) return legacyMemo.byName;
  // kept out of cache/shop (which is bundled for Vercel): its links expire
  const data = await cachedJson('legacy-patterns.json', `${API}/legacy-patterns`, LEGACY_MAX_AGE_MS, LEGACY_DIR);
  const byName = new Map((data.patterns || []).filter((p) => p.name && p.tiff_20mm).map((p) => [String(p.name), p.tiff_20mm]));
  legacyMemo = { at: Date.now(), byName };
  return byName;
}

/** Just the names (the client builds file and thumbnail paths from them). */
async function listLegacy() {
  return [...(await legacyIndex()).keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const legacyJobs = new Map();
async function ensureLegacyFile(name, kind) {
  const strap = path.join(LEGACY_DIR, `${name}.png`);
  const target = kind === '.png' ? strap : path.join(LEGACY_DIR, `${name}.thumb.jpg`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  // one download per pattern even when the tile and the photo ask at once
  if (!legacyJobs.has(name)) {
    legacyJobs.set(name, buildLegacy(name, strap).finally(() => legacyJobs.delete(name)));
  }
  await legacyJobs.get(name);
  return target;
}

async function buildLegacy(name, strapFile) {
  const sharp = require('sharp');
  if (!(fs.existsSync(strapFile) && fs.statSync(strapFile).size > 0)) {
    const url = (await legacyIndex()).get(name);
    if (!url) throw new Error(`Unknown legacy pattern ${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download legacy pattern ${name}: HTTP ${res.status}`);
    const tif = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(tif).metadata();
    const top = Math.round((meta.height * BLEED_MM) / STRIP_MM);
    const height = meta.height - 2 * top;
    const png = await sharp(tif).extract({ left: 0, top, width: meta.width, height })
      .toColourspace('srgb').removeAlpha().png({ compressionLevel: 6 }).toBuffer();
    fs.mkdirSync(LEGACY_DIR, { recursive: true });
    fs.writeFileSync(`${strapFile}.part`, png);
    fs.renameSync(`${strapFile}.part`, strapFile);
  }
  const thumb = strapFile.replace(/\.png$/, '.thumb.jpg');
  if (!fs.existsSync(thumb)) {
    // a square tile showing four strap-heights of the strip, as two rows (the strip repeats,
    // so it wraps), so long patterns like a pumpkin-and-bats strip show more than one motif
    const { data, info } = await sharp(strapFile).raw().toBuffer({ resolveWithObject: true });
    const h = info.height, w = info.width, ch = info.channels, side = 2 * h;
    const out = Buffer.alloc(side * side * ch);
    for (let y = 0; y < side; y++) {
      const sy = y % h, x0 = y < h ? 0 : side;
      for (let x = 0; x < side; x++) {
        const s = (sy * w + ((x0 + x) % w)) * ch, d = (y * side + x) * ch;
        for (let c = 0; c < ch; c++) out[d + c] = data[s + c];
      }
    }
    const jpg = await sharp(out, { raw: { width: side, height: side, channels: ch } })
      .resize(220, 220).jpeg({ quality: 82 }).toBuffer();
    fs.writeFileSync(`${thumb}.part`, jpg);
    fs.renameSync(`${thumb}.part`, thumb);
  }
}

// What the store says about a pattern file: { label, thumb, collection }. Read from the cached
// collection lists only (no network), so callers can't make the server fetch arbitrary URLs.
function describePattern(rel) {
  const lm = LEGACY_FILE.exec(String(rel || ''));
  // legacy patterns have no store preview: hand over our own thumbnail (made from the TIFF)
  if (lm) return { label: `Legacy pattern ${lm[1]}`, thumb: null, thumbFile: `cache/legacy/${lm[1]}.thumb.jpg`, collection: 'Legacy' };
  const m = PATTERN_FILE.exec(String(rel || ''));
  if (!m || !fs.existsSync(CACHE)) return null;
  let titles = {};
  try {
    for (const c of JSON.parse(fs.readFileSync(path.join(CACHE, 'collections.json'), 'utf8')).custom_collections || []) titles[String(c.id)] = c.title;
  } catch { titles = {}; }
  for (const name of fs.readdirSync(CACHE)) {
    const cm = /^products-(\d+)\.json$/.exec(name);
    if (!cm) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8')); } catch { continue; }
    const p = (data.products || []).find((x) => String(x.id) === m[1]);
    if (p) return { label: String(p.name || p.id).replace(/_/g, ' ').trim(), thumb: p.preview || null, collection: titles[cm[1]] || null };
  }
  return null;
}

module.exports = { listCollections, listPatterns, listLegacy, ensurePatternFile, patternFileFor, printFraming, framedFile, describePattern };
