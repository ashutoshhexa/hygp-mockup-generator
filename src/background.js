'use strict';

/**
 * Backgrounds are empty plates. The product is never painted into them.
 * The compositor multiplies the plate by the template photo's own shadows,
 * so contact shadows under the product survive the swap.
 *
 * Presets are drawn in code: a soft vertical gradient, a window-light glow,
 * a light vignette and a fine paper grain. Painted plates are cached in
 * cache/backgrounds/ so a preset is only drawn once per size.
 */
const fs = require('fs');
const path = require('path');
const { cachePath } = require('./paths');

// group: how the Studio groups the swatches
const PRESETS = {
  'studio-white': { label: 'Studio white', group: 'Light', top: '#fbfbfa', mid: '#f3f2f0', bottom: '#e6e4e1', light: '#ffffff', grain: 0.025 },
  'winter-linen': { label: 'Linen', group: 'Light', top: '#f8f5ef', mid: '#ebe5da', bottom: '#d9d1c3', light: '#fffaf2', grain: 0.04 },
  'soft-grey': { label: 'Soft grey', group: 'Light', top: '#f1f1f1', mid: '#e1e1e2', bottom: '#cdcdcf', light: '#ffffff', grain: 0.03 },
  'warm-sand': { label: 'Warm sand', group: 'Light', top: '#f6eee3', mid: '#e9dccb', bottom: '#d6c4ad', light: '#fff8ee', grain: 0.04 },
  'warm-kraft': { label: 'Kraft paper', group: 'Light', top: '#efe3d0', mid: '#e0cfb4', bottom: '#cbb594', light: '#f8efe0', grain: 0.06 },

  'blush-pink': { label: 'Blush pink', group: 'Pastel', top: '#fcf1f1', mid: '#f5dfe0', bottom: '#e8c9cb', light: '#fff8f8', grain: 0.03 },
  'cranberry-blush': { label: 'Rose', group: 'Pastel', top: '#fbf1ef', mid: '#f1dcd8', bottom: '#e2c3bd', light: '#fff8f6', grain: 0.03 },
  'peach-sorbet': { label: 'Peach', group: 'Pastel', top: '#fdf3ec', mid: '#f8e1d2', bottom: '#eccab4', light: '#fffaf5', grain: 0.03 },
  'butter-cream': { label: 'Butter', group: 'Pastel', top: '#fcf8ea', mid: '#f4ecd0', bottom: '#e6dab3', light: '#fffdf4', grain: 0.03 },
  'sage-mist': { label: 'Sage', group: 'Pastel', top: '#f3f5ef', mid: '#e1e7da', bottom: '#cbd5c1', light: '#fbfdf6', grain: 0.03 },
  'mint-cream': { label: 'Mint', group: 'Pastel', top: '#f0f7f3', mid: '#dcede4', bottom: '#c3dccf', light: '#f9fffc', grain: 0.03 },
  'frost-blue': { label: 'Frost blue', group: 'Pastel', top: '#f2f6f9', mid: '#dfe8ef', bottom: '#c6d3de', light: '#ffffff', grain: 0.03 },
  'lavender-haze': { label: 'Lavender', group: 'Pastel', top: '#f6f3fa', mid: '#e7e0f1', bottom: '#d3c9e4', light: '#fdfbff', grain: 0.03 },

  'evergreen': { label: 'Evergreen', group: 'Deep', top: '#5d7465', mid: '#475e50', bottom: '#33473b', light: '#7d9584', grain: 0.04 },
  'cranberry': { label: 'Cranberry', group: 'Deep', top: '#99505a', mid: '#7f3c47', bottom: '#632c36', light: '#b46a73', grain: 0.04 },
  'midnight': { label: 'Midnight', group: 'Deep', top: '#56627a', mid: '#414c63', bottom: '#2f384b', light: '#75819a', grain: 0.04 },
  'charcoal': { label: 'Charcoal', group: 'Deep', top: '#6a6a6c', mid: '#545456', bottom: '#3f3f42', light: '#87878a', grain: 0.04 },
};

const DEFAULT_PRESET = 'winter-linen';

// Fine grain is added in code: an SVG noise filter at 3000 x 2250 took ~6.5 s per plate.
function presetSvg(width, height, colors) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${colors.top}"/>
      <stop offset="0.55" stop-color="${colors.mid}"/>
      <stop offset="1" stop-color="${colors.bottom}"/>
    </linearGradient>
    <radialGradient id="window" cx="28%" cy="16%" r="60%">
      <stop offset="0" stop-color="${colors.light}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${colors.light}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="45%" r="75%">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.10"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#ground)"/>
  <rect width="${width}" height="${height}" fill="url(#window)"/>
  <rect width="${width}" height="${height}" fill="url(#vignette)"/>
</svg>`;
}

// deterministic grey grain, +-amount of full scale (seeded so a plate is identical every time)
function addGrain(rgb, amount) {
  let s = 0x9e3779b9;
  const amp = amount * 255;
  for (let i = 0; i < rgb.length; i += 3) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const n = ((s >>> 0) / 4294967296 - 0.5) * amp;
    rgb[i] = Math.max(0, Math.min(255, rgb[i] + n));
    rgb[i + 1] = Math.max(0, Math.min(255, rgb[i + 1] + n));
    rgb[i + 2] = Math.max(0, Math.min(255, rgb[i + 2] + n));
  }
}

async function paintPreset(name, width, height) {
  const sharp = require('sharp');
  const id = PRESETS[name] ? name : DEFAULT_PRESET;
  const colors = PRESETS[id];
  const file = cachePath('backgrounds', `${id}-${width}x${height}-${hashColors(colors)}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const raw = await sharp(Buffer.from(presetSvg(width, height, colors))).removeAlpha().raw().toBuffer();
  addGrain(raw, colors.grain || 0);
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 3 }).toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return png;
}

// cache name changes when a preset's colours are edited
function hashColors(c) {
  const s = JSON.stringify(c);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// kept for older callers
async function paintEmptyScene(width, height, prompt) {
  const text = String(prompt || '').toLowerCase();
  const name = text.includes('blue') || text.includes('frost') ? 'frost-blue' : DEFAULT_PRESET;
  return paintPreset(name, width, height);
}

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, group: p.group, swatch: p.mid, top: p.top, bottom: p.bottom }));
}

module.exports = { paintPreset, paintEmptyScene, listPresets, PRESETS, DEFAULT_PRESET };
