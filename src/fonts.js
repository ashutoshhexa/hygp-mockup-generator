'use strict';

/**
 * Engraving fonts: the same list the HYGP storefront uses
 * (GET https://d24u4mowe6x0rg.cloudfront.net/api/engraving-fonts).
 * Only fonts marked for "buckle" are offered. The list and the font files
 * are cached in cache/engraving-fonts/ so renders work offline after the first fetch.
 */
const fs = require('fs');
const path = require('path');
const fontkit = require('fontkit');

const { fromRoot } = require('./paths');

const API = 'https://d24u4mowe6x0rg.cloudfront.net/api/engraving-fonts';
const CACHE_DIR = fromRoot('cache', 'engraving-fonts');
const LIST_FILE = path.join(CACHE_DIR, 'list.json');
const LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Font for the phone line (a plain bold sans, like the real buckles). */
const PHONE_FONT = 'Roboto';
const DEFAULT_FONT = 'Roboto';

// fonts the first proof used (Windows system fonts) -> closest storefront font
const LEGACY = { Arial: 'Roboto', Calibri: 'Roboto', 'Segoe UI': 'Roboto', Georgia: 'DM Serif' };

function readCachedList() {
  try { return JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')); } catch { return null; }
}

function normalizeList(raw) {
  return (raw && Array.isArray(raw.data) ? raw.data : [])
    .filter((f) => f.isVisible !== false && Array.isArray(f.use_case) && f.use_case.includes('buckle') && f.font_path)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    .map((f) => ({
      id: f.id,
      name: String(f.name).trim(),
      url: f.font_path,
      file: f.file_name || path.basename(new URL(f.font_path).pathname),
      preview: f.preview || null,
      postscriptName: String(f.longName || '').trim(),
    }));
}

/** Fetch the list from the API when the cache is stale. Falls back to the cache when offline. */
async function refreshFontList({ force = false } = {}) {
  const fresh = fs.existsSync(LIST_FILE) && Date.now() - fs.statSync(LIST_FILE).mtimeMs < LIST_MAX_AGE_MS;
  if (fresh && !force) return fontList();
  try {
    const res = await fetch(API, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!normalizeList(raw).length) throw new Error('no buckle fonts in the response');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LIST_FILE, JSON.stringify(raw, null, 2));
  } catch (err) {
    if (!readCachedList()) throw new Error(`Could not load engraving fonts from ${API}: ${err.message}`);
    console.warn(`Engraving font list: using cached copy (${err.message})`);
  }
  return fontList();
}

/** Buckle fonts from the cached list (sync). Empty until refreshFontList() has run once. */
function fontList() {
  return normalizeList(readCachedList());
}

function fontNames() {
  return fontList().map((f) => f.name);
}

/** Map any stored font name onto a font that exists in the list. */
function resolveFontName(name) {
  const list = fontList();
  const want = String(name || '').trim();
  const hit = list.find((f) => f.name.toLowerCase() === want.toLowerCase());
  if (hit) return hit.name;
  const legacy = LEGACY[want];
  if (legacy && list.some((f) => f.name === legacy)) return legacy;
  return list.some((f) => f.name === DEFAULT_FONT) ? DEFAULT_FONT : (list[0] && list[0].name) || DEFAULT_FONT;
}

async function ensureFontFile(entry) {
  const file = path.join(CACHE_DIR, 'files', entry.file);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`Could not download font ${entry.name}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const loaded = new Map();

/** fontkit font for a storefront font name (downloads it on first use). */
async function loadFont(name) {
  if (!fontList().length) await refreshFontList();
  const resolved = resolveFontName(name);
  if (loaded.has(resolved)) return loaded.get(resolved);
  const entry = fontList().find((f) => f.name === resolved);
  if (!entry) throw new Error(`Engraving font "${name}" is not in the storefront list.`);
  let font = fontkit.openSync(await ensureFontFile(entry));
  if (font.fonts) {
    // .ttc collection: pick the face the storefront names, else the first one
    font = font.fonts.find((f) => f.postscriptName === entry.postscriptName) || font.fonts[0];
  }
  loaded.set(resolved, font);
  return font;
}

/** Download every buckle font (server start-up). */
async function warmFonts() {
  await refreshFontList();
  for (const f of fontList()) {
    try { await loadFont(f.name); } catch (err) { console.warn(err.message); }
  }
  return fontList();
}

module.exports = { refreshFontList, fontList, fontNames, resolveFontName, loadFont, warmFonts, PHONE_FONT, DEFAULT_FONT };
