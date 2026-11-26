'use strict';

/**
 * Node side of the mockup core: decode/encode with sharp, engraving (font outlines) with resvg.
 * The browser UI runs the same core.js and plan.js with canvas instead.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const core = require('./core');
const plan = require('./plan');
const { fromRoot } = require('../paths');
const { rasterizeEngraving } = require('../engraving');
const { paintPreset } = require('../background');
const { isLifestyleFile, lifestylePath } = require('../lifestyle');
const { ensurePatternFile } = require('../catalog');

const layerCache = new Map();
const WEBP_MAX_BYTES = 50 * 1024;

async function encodeWebpUnder(image, width, height) {
  // Match the Studio's starting size and quality range. Keep reducing the
  // dimensions if a detailed image still exceeds the cap at the lowest quality.
  let edge = Math.min(Math.max(width, height), 1800);
  for (;;) {
    const { data, info } = await image.clone().resize(edge, edge, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true });
    // The resized RGB buffer has no alpha channel. Reusing Sharp's output info
    // would also pass its premultiplied flag and treat blue as alpha.
    const raw = { width: info.width, height: info.height, channels: info.channels };
    const encode = (quality) => sharp(data, { raw }).webp({ quality }).toBuffer();
    let low = 42, high = 90;
    let best = await encode(low);
    if (best.length <= WEBP_MAX_BYTES) {
      const highest = await encode(high);
      if (highest.length <= WEBP_MAX_BYTES) return highest;
      while (high - low > 1) {
        const quality = Math.floor((low + high) / 2);
        const candidate = await encode(quality);
        if (candidate.length <= WEBP_MAX_BYTES) {
          best = candidate;
          low = quality;
        } else {
          high = quality;
        }
      }
      return best;
    }
    if (edge === 1) throw new Error('Could not encode WebP within 50 KB.');
    edge = Math.max(1, Math.min(edge - 1, Math.round(edge * 0.88)));
  }
}

function toRgba({ data, info }) {
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

async function loadRgba(file, width, height) {
  let img = sharp(file).ensureAlpha();
  if (width && height) img = img.resize(width, height, { fit: 'cover', kernel: 'lanczos3' });
  return toRgba(await img.raw().toBuffer({ resolveWithObject: true }));
}

async function bufferToRgba(buf) {
  return toRgba(await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(fromRoot(rel), 'utf8'));
}

function readTemplate(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Bad template id ${id}`);
  const template = readJson(path.join('templates', `${id}.json`));
  // lifestyle scene placement for this view (scale and position of each scene behind the collar)
  const lf = path.join('templates', 'lifestyle', `${id}.json`);
  if (fs.existsSync(fromRoot(lf))) template.lifestyle = readJson(lf);
  return template;
}

async function backgroundPng(spec, width, height) {
  if (!spec) return null;
  if (spec.kind === 'file') {
    const src = isLifestyleFile(spec.file) ? await lifestylePath(spec.file) : fromRoot(spec.file);
    if (spec.placement) {
      const { width: iw, height: ih } = await sharp(src).metadata();
      const r = plan.placeScene(iw, ih, width, height, spec.placement);
      const img = await sharp(src).resize(Math.round(r.dw), Math.round(r.dh), { fit: 'fill' }).toBuffer();
      return sharp(img).extract({ left: Math.round(-r.dx), top: Math.round(-r.dy), width, height }).png().toBuffer();
    }
    return sharp(src).resize(width, height, { fit: 'cover' }).png().toBuffer();
  }
  if (spec.kind === 'plain') {
    return sharp({ create: { width, height, channels: 4, background: spec.color || '#f5f3ef' } }).png().toBuffer();
  }
  return paintPreset(spec.preset, width, height);
}

async function renderFrame({ templateId, template, scale, background = null, mode = 'final', patternFile, patternFileBySlot, finishBySlot, collarBySlot, patternScale, patternScaleBySlot, format = 'png', square = false }) {
  template = template || readTemplate(templateId);
  // layered (PSD) templates are baked at one size
  scale = template.layered ? 1 : scale || template.renderScale || 1;
  const W = Math.round(template.width * scale);
  const H = Math.round(template.height * scale);
  const base = template.layered ? null : await loadRgba(fromRoot(template.base), W, H);
  let below = null, layerData = null, metalPlates = null;
  if (template.layered) {
    const [sourceWidth, sourceHeight] = template.layered.repeat?.sourceSize || [W, H];
    below = await loadRgba(fromRoot(template.layered.below), sourceWidth, sourceHeight);
    if (template.layered.metalPlates) {
      metalPlates = {};
      const wanted = new Set(Object.values(finishBySlot || {}));
      for (const [fin, file] of Object.entries(template.layered.metalPlates)) {
        if (!wanted.has(fin) || !fs.existsSync(fromRoot(file))) continue;
        if (!layerCache.has(file)) layerCache.set(file, await loadRgba(fromRoot(file), sourceWidth, sourceHeight));
        metalPlates[fin] = layerCache.get(file);
      }
    }
    layerData = layerCache.get(template.layered.bin);
    if (!layerData) {
      layerData = new Uint8Array(fs.readFileSync(fromRoot(template.layered.bin)));
      layerCache.set(template.layered.bin, layerData);
    }
  }
  const loaded = new Map();
  const loadPattern = async (file) => {
    if (!loaded.has(file)) {
      const local = (await ensurePatternFile(file)) || (path.isAbsolute(file) ? file : fromRoot(file));
      loaded.set(file, await loadRgba(local));
    }
    return loaded.get(file);
  };
  const pattern = await loadPattern(patternFile);
  const patternBySlot = {};
  for (const [slot, file] of Object.entries(patternFileBySlot || {})) if (file) patternBySlot[slot] = await loadPattern(file);
  const engravingBySlot = {};
  for (const [slot, collar] of Object.entries(collarBySlot || {})) {
    if (collar && (collar.name || collar.phone)) {
      const png = await rasterizeEngraving({ name: collar.name, phone: collar.phone, line3: collar.line3, font: collar.font, phoneFont: collar.phoneFont || collar.font });
      if (png) engravingBySlot[slot] = await bufferToRgba(png);
    }
  }
  const bgPng = await backgroundPng(background, W, H);
  const bg = bgPng ? await bufferToRgba(bgPng) : null;
  const out = core.render({ template, base, below, layerData, metalPlates, pattern, patternBySlot, finishBySlot, engravingBySlot, background: bg, mode, patternScale, patternScaleBySlot });
  const crop = square && out.width !== out.height ? core.squareFrame(out.width, out.height, template) : null;
  const source = crop && (crop.padTop || crop.padBottom) ? core.extendPhotoRows(out, crop.padTop, crop.padBottom) : out;
  const raw = { width: source.width, height: source.height, channels: 4 };
  const image = sharp(Buffer.from(source.data.buffer), { raw }).removeAlpha();
  if (crop) image.extract({ left: crop.left, top: crop.top, width: crop.size, height: crop.size });
  return format === 'webp' ? encodeWebpUnder(image, crop?.size ?? out.width, crop?.size ?? out.height) : image.png().toBuffer();
}

/** Render every frame in frames.json for one decision. Returns [{frame, png}] */
async function renderListing(decision, { exportScale = 2, mode = 'final' } = {}) {
  const framesCfg = readJson('frames.json');
  const results = [];
  for (const frame of framesCfg.frames) {
    const template = readTemplate(frame.template);
    const p = plan.planFrame(frame, template, decision, framesCfg.sideOrder);
    const scale = Math.max(template.renderScale || 1, exportScale * (1024 / Math.max(template.width, template.height)));
    const png = await renderFrame({ ...p, template, scale, mode, patternFile: decision.patternFile });
    results.push({ frame, plan: p, png });
  }
  return results;
}

module.exports = { renderFrame, renderListing, readTemplate, readJson, loadRgba, backgroundPng, WEBP_MAX_BYTES };
