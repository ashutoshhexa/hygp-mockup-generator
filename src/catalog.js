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

async function cachedJson(name, url) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fs.mkdirSync(CACHE, { recursive: true });
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

module.exports = { listCollections, listPatterns, ensurePatternFile, patternFileFor, printFraming, framedFile };
