'use strict';

/**
 * Lifestyle scenes: AI-generated empty surfaces in "lifestyle images/" (project root), offered
 * as backgrounds on the /single-collar* pages only.
 *
 * The browser loads them as /files/lifestyle/<id>.jpg (full size) and <id>.thumb.jpg (picker).
 * Locally the Studio converts the source images on first request (cached in cache/lifestyle/);
 * the Vercel build writes the same files into public/files/lifestyle/. The serverless function
 * has no image folder, so stage-vercel.js leaves the list in templates/lifestyle.json.
 */
const fs = require('fs');
const path = require('path');
const { fromRoot } = require('./paths');

const DIR = 'lifestyle images';
const MANIFEST = path.join('templates', 'lifestyle.json');

// display names for the generated files (anything else is named after its file)
const LABELS = {
  'Gemini_Generated_Image_17ymay17ymay17ym': 'Oak table',
  'Gemini_Generated_Image_z2qs5z2qs5z2qs5z': 'Travertine',
  'Gemini_Generated_Image_4slles4slles4sll': 'Linen bench',
  'Gemini_Generated_Image_ju4caiju4caiju4c': 'Stone tiles',
  'Gemini_Generated_Image_2ldzli2ldzli2ldz': 'River pebbles',
  'Gemini_Generated_Image_lxu4x2lxu4x2lxu4': 'Fine gravel',
  'Gemini_Generated_Image_dm45jtdm45jtdm45': 'Sofa fabric',
  'Warm Minimalist Living Room Staging Surface': 'Warm wood',
  'Serene Coastal Zen Sandscape': 'Coastal sand',
  'Gemini_Generated_Image_5e6to75e6to75e6t': 'Zen sand tray',
  'Warm Rustic Wooden Tabletop': 'Rustic wood',
  'Gemini_Generated_Image_haua6whaua6whaua': 'Walnut table',
};
const ORDER = Object.keys(LABELS);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** [{ id, label, source, file, thumb }] in picker order. file/thumb are relative to /files/. */
function listLifestyle() {
  const dir = fromRoot(DIR);
  if (!fs.existsSync(dir)) {
    const m = fromRoot(MANIFEST);
    return fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : [];
  }
  return fs.readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .map((n) => {
      const base = n.replace(/\.[^.]+$/, '');
      const label = LABELS[base] || base.replace(/[_-]+/g, ' ');
      const id = LABELS[base] ? slug(label) : slug(base);
      return { id, label, source: `${DIR}/${n}`, file: `lifestyle/${id}.jpg`, thumb: `lifestyle/${id}.thumb.jpg`, rank: ORDER.indexOf(base) };
    })
    .sort((a, b) => (a.rank === -1 ? 1e9 : a.rank) - (b.rank === -1 ? 1e9 : b.rank) || a.label.localeCompare(b.label))
    .map(({ rank, ...s }) => s);
}

const isLifestyleFile = (file) => typeof file === 'string' && file.startsWith('lifestyle/');

/** JPEG bytes for lifestyle/<id>.jpg or lifestyle/<id>.thumb.jpg. Full size keeps the source pixels. */
async function lifestyleJpeg(file) {
  const m = /^lifestyle\/([a-z0-9-]+)(\.thumb)?\.jpg$/.exec(file);
  const scene = m && listLifestyle().find((s) => s.id === m[1]);
  if (!scene || !scene.source) return null;
  const sharp = require('sharp');
  const img = sharp(fromRoot(scene.source)).rotate();
  return m[2]
    ? img.resize(240, 180, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer()
    : img.jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Local path of a converted file, written to cache/lifestyle/ on first use. */
async function lifestylePath(file) {
  const out = fromRoot('cache', file);
  const scene = listLifestyle().find((s) => file === s.file || file === s.thumb);
  if (!scene) return null;
  const src = fromRoot(scene.source);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  const buf = await lifestyleJpeg(file);
  if (!buf) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return out;
}

module.exports = { listLifestyle, isLifestyleFile, lifestyleJpeg, lifestylePath, MANIFEST };
