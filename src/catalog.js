'use strict';

/**
 * Pattern catalog: the storefront's Shopify collections and the patterns inside them.
 *   GET https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection/            -> collections
 *   GET https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection/products/:id -> patterns
 * A pattern's print file (png_image, a seamless square tile) is downloaded once to
 * cache/patterns/<productId>.png, which is the patternFile the renderer reads.
 */
const fs = require('fs');
const path = require('path');

const { fromRoot } = require('./paths');

const API = 'https://d24u4mowe6x0rg.cloudfront.net/api/shopify-collection';
const CACHE = fromRoot('cache', 'shop');
const PATTERN_DIR = fromRoot('cache', 'patterns');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PATTERN_FILE = /^cache\/patterns\/(\d+)\.png$/;

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

function patternFileFor(productId) {
  return `cache/patterns/${productId}.png`;
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
    file: patternFileFor(p.id),
    url: p.png_image,
  }));
}

/** Make sure a catalog pattern is on disk. Local files (poc/patterns/...) pass through. */
async function ensurePatternFile(rel) {
  const m = PATTERN_FILE.exec(String(rel || '').replace(/\\/g, '/'));
  if (!m) return null;
  const file = path.join(PATTERN_DIR, `${m[1]}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const url = `https://d1ows48k9hyw72.cloudfront.net/metafields/${m[1]}/image.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download pattern ${m[1]}: HTTP ${res.status}`);
  fs.mkdirSync(PATTERN_DIR, { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { listCollections, listPatterns, ensurePatternFile, patternFileFor };
