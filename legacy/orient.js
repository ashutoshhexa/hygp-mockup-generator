'use strict';

/**
 * Turn a transparent product render so its long axis lies left to right.
 * Used for the leash slot. The collar keeps the camera the GLB renderer chose.
 */

async function majorAxisDegrees(pngBuffer) {
  const sharp = require('sharp');
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const step = 3;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (let y = 0; y < info.height; y += step) {
    for (let x = 0; x < info.width; x += step) {
      const alpha = data[(y * info.width + x) * info.channels + (info.channels - 1)];
      if (alpha < 20) continue;
      n += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }
  if (n < 10) return 0;

  const mx = sx / n;
  const my = sy / n;
  const covXX = sxx / n - mx * mx;
  const covYY = syy / n - my * my;
  const covXY = sxy / n - mx * my;
  const radians = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  return (radians * 180) / Math.PI;
}

async function trimTransparent(pngBuffer) {
  const sharp = require('sharp');
  try {
    return await sharp(pngBuffer).trim().png().toBuffer();
  } catch {
    return pngBuffer;
  }
}

async function layHorizontal(pngBuffer) {
  const sharp = require('sharp');
  const trimmed = await trimTransparent(pngBuffer);
  const axis = await majorAxisDegrees(trimmed);
  // sharp rotates clockwise. The axis angle is counter-clockwise from +x.
  let rotated = await sharp(trimmed)
    .rotate(axis, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const meta = await sharp(rotated).metadata();
  if (meta.height > meta.width) {
    rotated = await sharp(rotated)
      .rotate(90, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }
  return rotated;
}

async function layVertical(pngBuffer) {
  const sharp = require('sharp');
  const horizontal = await layHorizontal(pngBuffer);
  return sharp(horizontal)
    .rotate(90, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function applyRotation(pngBuffer, rotate) {
  const sharp = require('sharp');
  if (rotate === 'horizontal') return layHorizontal(pngBuffer);
  if (rotate === 'vertical') return layVertical(pngBuffer);
  const degrees = Number(rotate) || 0;
  if (!degrees) return pngBuffer;
  return sharp(pngBuffer)
    .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

module.exports = { layHorizontal, applyRotation };
