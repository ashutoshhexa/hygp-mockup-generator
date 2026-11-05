'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Buckle engraving SVG.
 * Fit math is the same as
 * B2B-portal-lambda/src/order/utils/engraving-svg.util.ts
 * so a name and phone land in the buckle the way production already draws them.
 * The image model does not invent the letters.
 */

const BUCKLE_DIMENSIONS = {
  XS: { widthMm: 14.0, heightMm: 11.0, viewBoxW: 2800, viewBoxH: 2200 },
  SM: { widthMm: 16.0, heightMm: 13.0, viewBoxW: 3200, viewBoxH: 2600 },
  MN: { widthMm: 16.0, heightMm: 13.0, viewBoxW: 3200, viewBoxH: 2600 },
  MW: { widthMm: 19.0, heightMm: 16.0, viewBoxW: 3800, viewBoxH: 3200 },
  LG: { widthMm: 19.0, heightMm: 16.0, viewBoxW: 3800, viewBoxH: 3200 },
  XL: { widthMm: 20.0, heightMm: 21.0, viewBoxW: 4000, viewBoxH: 4200 },
  XXL: { widthMm: 20.0, heightMm: 21.0, viewBoxW: 4000, viewBoxH: 4200 },
};

const FONT_FILES = {
  Arial: 'arialbd.ttf',
  Georgia: 'georgiab.ttf',
  Calibri: 'calibrib.ttf',
  'Segoe UI': 'segoeuib.ttf',
};

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function estimateTextUnits(text) {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/[MW]/.test(char)) units += 1.05;
    else if (/[mw]/.test(char)) units += 0.8;
    else if (/[CDGNOQU]/.test(char)) units += 0.85;
    else if (/[ABEFHKPRSTVXYZ]/.test(char)) units += 0.78;
    else if (/[ijlrtfI]/.test(char)) units += 0.38;
    else if (/[a-z]/.test(char)) units += 0.54;
    else units += 0.56;
  }
  return units;
}

function fontFile(fontName) {
  const file = FONT_FILES[fontName] || FONT_FILES.Arial;
  const full = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', file);
  if (!fs.existsSync(full)) {
    const fallback = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arialbd.ttf');
    if (!fs.existsSync(fallback)) {
      throw new Error(`Engraving font file not found for ${fontName}.`);
    }
    return fallback;
  }
  return full;
}

function generateEngravingSvg({ line1, line2, fontName, fontUrl, sizeName = 'MN' }) {
  const defaultFont = (fontName || 'Arial').trim();
  const rawLines = [
    { text: (line1 || '').trim(), font: defaultFont, fontUrl: fontUrl || null, lineIndex: 1 },
    { text: (line2 || '').trim(), font: defaultFont, fontUrl: fontUrl || null, lineIndex: 2 },
  ].filter((line) => line.text.length > 0);
  if (rawLines.length === 0) return null;

  const dim = BUCKLE_DIMENSIONS[sizeName] || BUCKLE_DIMENSIONS.MN;
  const numLines = rawLines.length;
  const H = dim.viewBoxH;
  const W = dim.viewBoxW;
  const maxW = Math.round(W * 0.88);

  let baseFs1 = 0;
  let baseFsSecondary = 0;
  if (numLines === 1) {
    baseFs1 = Math.round(H * 0.52);
  } else {
    baseFs1 = Math.round(H * 0.44);
    baseFsSecondary = Math.round(H * 0.26);
  }

  const getLineHeight = (fs) => Math.round(fs * 1.0);
  const gap = numLines > 1 ? Math.round(baseFsSecondary * 0.12) : 0;

  const lineFontSizes = rawLines.map((item, idx) => {
    const targetFs = idx === 0 ? baseFs1 : baseFsSecondary;
    const textUnits = item.text.length <= 3 ? item.text.length * 0.56 : estimateTextUnits(item.text);
    const estWidth = textUnits * targetFs;
    if (estWidth > maxW) return Math.max(Math.round(maxW / textUnits), 14);
    return targetFs;
  });

  const lineHeights = lineFontSizes.map((fs) => getLineHeight(fs));
  let totalBlockH = lineHeights.reduce((sum, lh) => sum + lh, 0) + (numLines - 1) * gap;
  const maxAllowedH = Math.round(H * 0.86);
  let effectiveGap = gap;
  if (totalBlockH > maxAllowedH) {
    const scale = maxAllowedH / totalBlockH;
    for (let i = 0; i < lineFontSizes.length; i++) {
      lineFontSizes[i] = Math.max(Math.round(lineFontSizes[i] * scale), 14);
      lineHeights[i] = getLineHeight(lineFontSizes[i]);
    }
    effectiveGap = Math.round(gap * scale);
    totalBlockH = lineHeights.reduce((sum, lh) => sum + lh, 0) + (numLines - 1) * effectiveGap;
  }

  let currentY = Math.round((H - totalBlockH) / 2);
  const centerX = Math.round(W / 2);

  const fontFaces = [];
  if (fontUrl) {
    fontFaces.push(`    @font-face {
      font-family: "${escapeXml(defaultFont)}";
      src: url("${escapeXml(fontUrl)}") format("truetype");
      font-weight: 700;
      font-style: normal;
    }`);
  }

  const textElements = rawLines.map((item, idx) => {
    const fs = lineFontSizes[idx];
    const lh = lineHeights[idx];
    const centerY = Math.round(currentY + lh / 2);
    currentY += lh + effectiveGap;
    return `  <text class="engraving-text" font-family="${escapeXml(item.font)}, Arial, sans-serif" x="${centerX}" y="${centerY}" font-size="${fs}">${escapeXml(item.text)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
${fontFaces.join('\n')}
    .engraving-text {
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: central;
      fill: #1a1a1a;
    }
    </style>
  </defs>
${textElements.join('\n')}
</svg>`;
}

function rasterizeEngraving({ name, phone, font }) {
  const { Resvg } = require('@resvg/resvg-js');
  const file = fontFile(font);
  const svg = generateEngravingSvg({
    line1: name,
    line2: phone,
    fontName: font,
    fontUrl: null,
    sizeName: 'MN',
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 800 },
    font: {
      fontFiles: [file],
      loadSystemFonts: false,
      defaultFontFamily: font,
    },
  });
  return Buffer.from(resvg.render().asPng());
}

module.exports = { generateEngravingSvg, rasterizeEngraving, fontFile };
