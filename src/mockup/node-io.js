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
const { ensurePatternFile } = require('../catalog');

const layerCache = new Map();

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
  return readJson(path.join('templates', `${id}.json`));
}

async function backgroundPng(spec, width, height) {
  if (!spec) return null;
  if (spec.kind === 'file') {
    return sharp(fromRoot(spec.file)).resize(width, height, { fit: 'cover' }).png().toBuffer();
  }
  if (spec.kind === 'plain') {
    return sharp({ create: { width, height, channels: 4, background: spec.color || '#f5f3ef' } }).png().toBuffer();
  }
  return paintPreset(spec.preset, width, height);
}

async function renderFrame({ templateId, template, scale, background = null, mode = 'final', patternFile, patternFileBySlot, finishBySlot, collarBySlot, patternScale, patternScaleBySlot }) {
  template = template || readTemplate(templateId);
  // layered (PSD) templates are baked at one size
  scale = template.layered ? 1 : scale || template.renderScale || 1;
  const W = Math.round(template.width * scale);
  const H = Math.round(template.height * scale);
  const base = await loadRgba(fromRoot(template.base), W, H);
  let below = null, layerData = null, metalPlates = null;
  if (template.layered) {
    below = await loadRgba(fromRoot(template.layered.below), W, H);
    if (template.layered.metalPlates) {
      metalPlates = {};
      const wanted = new Set(Object.values(finishBySlot || {}));
      for (const [fin, file] of Object.entries(template.layered.metalPlates)) {
        if (!wanted.has(fin) || !fs.existsSync(fromRoot(file))) continue;
        if (!layerCache.has(file)) layerCache.set(file, await loadRgba(fromRoot(file), W, H));
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
  return sharp(Buffer.from(out.data.buffer), { raw: { width: out.width, height: out.height, channels: 4 } })
    .removeAlpha()
    .png()
    .toBuffer();
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

module.exports = { renderFrame, renderListing, readTemplate, readJson, loadRgba, backgroundPng };
