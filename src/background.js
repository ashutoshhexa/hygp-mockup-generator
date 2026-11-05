'use strict';

/**
 * Backgrounds are empty plates. The product is never painted into them.
 * The compositor multiplies the plate by the template photo's own shadows,
 * so contact shadows under the product survive the swap.
 *
 * Presets are drawn in code. A generated (AI) plate is a file in
 * poc/backgrounds/ and is used the same way.
 */

const PRESETS = {
  'winter-linen': { label: 'Winter linen', top: '#f8f5ef', mid: '#ebe5da', bottom: '#d9d1c3', light: '#fffaf2', grain: 0.06 },
  'frost-blue': { label: 'Frost blue', top: '#f2f6f9', mid: '#dfe8ef', bottom: '#c6d3de', light: '#ffffff', grain: 0.05 },
  'cranberry-blush': { label: 'Cranberry blush', top: '#fbf1ef', mid: '#f1dcd8', bottom: '#e2c3bd', light: '#fff8f6', grain: 0.05 },
  'sage-mist': { label: 'Sage mist', top: '#f3f5ef', mid: '#e1e7da', bottom: '#cbd5c1', light: '#fbfdf6', grain: 0.05 },
  'warm-kraft': { label: 'Warm kraft', top: '#efe3d0', mid: '#e0cfb4', bottom: '#cbb594', light: '#f8efe0', grain: 0.09 },
};

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
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="${colors.grain}"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#ground)"/>
  <rect width="${width}" height="${height}" fill="url(#window)"/>
  <rect width="${width}" height="${height}" fill="url(#vignette)"/>
  <rect width="${width}" height="${height}" filter="url(#grain)"/>
</svg>`;
}

async function paintPreset(name, width, height) {
  const sharp = require('sharp');
  const colors = PRESETS[name] || PRESETS['winter-linen'];
  return sharp(Buffer.from(presetSvg(width, height, colors))).png().toBuffer();
}

// kept for older callers
async function paintEmptyScene(width, height, prompt) {
  const text = String(prompt || '').toLowerCase();
  const name = text.includes('blue') || text.includes('frost') ? 'frost-blue' : 'winter-linen';
  return paintPreset(name, width, height);
}

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, swatch: p.mid }));
}

module.exports = { paintPreset, paintEmptyScene, listPresets, PRESETS };
