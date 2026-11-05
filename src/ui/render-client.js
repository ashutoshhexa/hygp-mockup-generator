/* Browser side of the renderer: loads pixels, ships them to the worker once, renders plans. */
(function () {
  'use strict';

  const worker = new Worker('/ui/worker.js');
  const pending = new Map();
  const sentKeys = new Set();
  const pixelPromises = new Map();
  const imagePromises = new Map();
  let nextId = 1;

  worker.onmessage = (event) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve({ image: new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), ms: msg.ms });
  };

  function loadImage(url) {
    if (!imagePromises.has(url)) {
      imagePromises.set(url, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { imagePromises.delete(url); reject(new Error(`Could not load ${url}`)); };
        img.src = url;
      }));
    }
    return imagePromises.get(url);
  }

  function drawToPixels(img, width, height, fit) {
    const w = width || img.naturalWidth;
    const h = height || img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    if (fit === 'cover' && width && height) {
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
    return ctx.getImageData(0, 0, w, h);
  }

  /** Ensure an image (at a size) is in the worker cache. Returns its key. */
  function ensurePixels(url, width, height, fit) {
    const key = `${url}@${width || 'n'}x${height || 'n'}:${fit || 'fill'}`;
    if (sentKeys.has(key)) return Promise.resolve(key);
    if (!pixelPromises.has(key)) {
      pixelPromises.set(key, loadImage(url).then((img) => {
        const data = drawToPixels(img, width, height, fit);
        const buffer = data.data.buffer;
        worker.postMessage({ type: 'asset', key, width: data.width, height: data.height, buffer }, [buffer]);
        sentKeys.add(key);
        return key;
      }).catch((err) => { pixelPromises.delete(key); throw err; }));
    }
    return pixelPromises.get(key);
  }

  function ensurePlain(color, width, height) {
    const key = `plain:${color}@${width}x${height}`;
    if (sentKeys.has(key)) return Promise.resolve(key);
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height);
    worker.postMessage({ type: 'asset', key, width, height, buffer: data.data.buffer }, [data.data.buffer]);
    sentKeys.add(key);
    return Promise.resolve(key);
  }

  function engravingUrl(collar) {
    const q = new URLSearchParams({ name: collar.name || '', phone: collar.phone || '', font: collar.font || 'Arial' });
    return `/api/engraving.png?${q}`;
  }

  function backgroundKey(spec, width, height) {
    if (!spec) return Promise.resolve(null);
    if (spec.kind === 'plain') return ensurePlain(spec.color || '#f5f3ef', width, height);
    if (spec.kind === 'file') return ensurePixels(`/files/${spec.file}`, width, height, 'cover');
    return ensurePixels(`/api/background.png?preset=${encodeURIComponent(spec.preset)}&w=${width}&h=${height}`, width, height, 'fill');
  }

  // raw binary assets (layered templates: masks + warp UV maps), sent to the worker once
  const binPromises = new Map();
  function ensureBin(url) {
    const key = `bin:${url}`;
    if (sentKeys.has(key)) return Promise.resolve(key);
    if (!binPromises.has(key)) {
      binPromises.set(key, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Could not load ${url}`);
        return r.arrayBuffer();
      }).then((buffer) => {
        worker.postMessage({ type: 'bin', key, buffer }, [buffer]);
        sentKeys.add(key);
        return key;
      }).catch((err) => { binPromises.delete(key); throw err; }));
    }
    return binPromises.get(key);
  }

  function previewScale(template, maxDim) {
    if (template.layered) return 1;
    const big = Math.max(template.width, template.height);
    return Math.min(template.renderScale || 1, (maxDim || 1400) / big);
  }

  /**
   * plan: from MockupPlan.planFrame. Returns {image: ImageData, ms}
   */
  async function renderPlan(plan, template, patternFile, { mode = 'final', scale } = {}) {
    scale = template.layered ? 1 : scale || previewScale(template);
    const W = Math.round(template.width * scale);
    const H = Math.round(template.height * scale);
    const [baseKey, patternKey, bgKey] = await Promise.all([
      ensurePixels(`/files/${template.base}`, W, H, 'fill'),
      ensurePixels(`/files/${patternFile}`),
      mode === 'mask' ? Promise.resolve(null) : backgroundKey(plan.background, W, H),
    ]);
    const patternKeys = {};
    await Promise.all(Object.entries(plan.patternFileBySlot || {}).map(async ([slot, file]) => {
      if (file) patternKeys[slot] = await ensurePixels(`/files/${file}`);
    }));
    const engravingKeys = {};
    await Promise.all(Object.entries(plan.collarBySlot || {}).map(async ([slot, collar]) => {
      if (collar && collar.name) engravingKeys[slot] = await ensurePixels(engravingUrl(collar));
    }));
    let belowKey = null, binKey = null;
    if (template.layered) {
      [belowKey, binKey] = await Promise.all([
        ensurePixels(`/files/${template.layered.below}`, W, H, 'fill'),
        ensureBin(`/files/${template.layered.bin}`),
      ]);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: 'render', id, template, baseKey, belowKey, binKey, patternKey, patternKeys, bgKey, engravingKeys,
        finishBySlot: plan.finishBySlot, mode, patternScale: plan.patternScale,
      });
    });
  }

  async function photoPixels(template, scale) {
    const W = Math.round(template.width * scale);
    const H = Math.round(template.height * scale);
    const img = await loadImage(`/files/${template.base}`);
    return drawToPixels(img, W, H, 'fill');
  }

  window.RenderClient = { renderPlan, photoPixels, previewScale, loadImage };
})();
