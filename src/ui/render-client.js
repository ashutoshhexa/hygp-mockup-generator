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

  // Phones on a weak connection drop big downloads now and then, so each image is tried up to
  // 3 times (with a cache-busting query on retries) before the render is reported as failed.
  function fetchImage(url, attempt) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => {
        if (attempt >= 3) { reject(new Error(`Could not load ${url}`)); return; }
        setTimeout(() => fetchImage(url, attempt + 1).then(resolve, reject), 600 * attempt);
      };
      img.src = attempt === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
    });
  }

  function loadImage(url) {
    if (!imagePromises.has(url)) {
      imagePromises.set(url, fetchImage(url, 1).catch((err) => { imagePromises.delete(url); throw err; }));
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
    const data = ctx.getImageData(0, 0, w, h);
    c.width = c.height = 0; // iOS Safari keeps canvas memory until told otherwise
    return data;
  }

  /** Ensure an image (at a size) is in the worker cache. Returns its key. */
  function ensurePixels(url, width, height, fit) {
    const key = `${url}@${width || 'n'}x${height || 'n'}:${fit || 'fill'}`;
    if (sentKeys.has(key)) return Promise.resolve(key);
    if (!pixelPromises.has(key)) {
      pixelPromises.set(key, loadImage(url).then((img) => {
        const data = drawToPixels(img, width, height, fit);
        imagePromises.delete(url); // the pixels live in the worker now; do not keep the decoded bitmap too
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
    const q = new URLSearchParams({ name: collar.name || '', phone: collar.phone || '', font: collar.font || '' });
    if (collar.phoneFont) q.set('phoneFont', collar.phoneFont);
    if (collar.line3 && collar.line3.trim()) q.set('line3', collar.line3.trim());
    return `/api/engraving.png?${q}`;
  }

  function backgroundKey(spec, width, height) {
    if (!spec) return Promise.resolve(null);
    let p;
    if (spec.kind === 'plain') p = ensurePlain(spec.color || '#f5f3ef', width, height);
    else if (spec.kind === 'file') p = ensurePixels(`/files/${spec.file}`, width, height, 'cover');
    else p = ensurePixels(`/api/background.png?preset=${encodeURIComponent(spec.preset)}&w=${width}&h=${height}`, width, height, 'fill');
    return p.then((key) => { keepRecentBackground(key); return key; });
  }

  // full-size backgrounds are ~27 MB each in the worker; keep only the last few
  const recentBackgrounds = [];
  function keepRecentBackground(key) {
    const at = recentBackgrounds.indexOf(key);
    if (at !== -1) recentBackgrounds.splice(at, 1);
    recentBackgrounds.push(key);
    const old = recentBackgrounds.length > 3 ? recentBackgrounds.splice(0, recentBackgrounds.length - 3) : [];
    if (!old.length) return;
    worker.postMessage({ type: 'drop', keys: old });
    for (const k of old) { sentKeys.delete(k); pixelPromises.delete(k); }
  }

  // raw binary assets (layered templates: masks + warp UV maps), sent to the worker once
  const binPromises = new Map();
  function ensureBin(url) {
    const key = `bin:${url}`;
    if (sentKeys.has(key)) return Promise.resolve(key);
    if (!binPromises.has(key)) {
      const attempt = async (n) => {
        try {
          const r = await fetch(n === 1 ? url : `${url}?retry=${n}`);
          if (!r.ok) throw new Error(`Could not load ${url}`);
          return await r.arrayBuffer();
        } catch (err) {
          if (n >= 3) throw err;
          await new Promise((res) => setTimeout(res, 800 * n));
          return attempt(n + 1);
        }
      };
      binPromises.set(key, attempt(1).then((buffer) => {
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
  /*
   * Latest wins, per template: while one render is running, newer requests replace each other
   * and only the newest is rendered next. Superseded requests resolve to null. Without this,
   * every keystroke queued a full render in the worker.
   */
  const lanes = new Map();
  function renderPlan(plan, template, patternFile, opts = {}) {
    const lane = lanes.get(template.id) || lanes.set(template.id, { busy: false, next: null }).get(template.id);
    return new Promise((resolve, reject) => {
      if (lane.next) lane.next.resolve(null);
      lane.next = { args: [plan, template, patternFile, opts], resolve, reject };
      pump(lane);
    });
  }
  function pump(lane) {
    if (lane.busy || !lane.next) return;
    const job = lane.next;
    lane.next = null;
    lane.busy = true;
    renderPlanNow(...job.args).then(job.resolve, job.reject).finally(() => { lane.busy = false; pump(lane); });
  }

  // key order of these maps follows network timing; sort so equal inputs give equal keys
  const sorted = (obj) => Object.entries(obj || {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));

  async function renderPlanNow(plan, template, patternFile, { mode = 'final', scale } = {}) {
    scale = template.layered ? 1 : scale || previewScale(template);
    const W = Math.round(template.width * scale);
    const H = Math.round(template.height * scale);
    const [baseKey, patternKey, bgKey] = await Promise.all([
      // layered (PSD) templates are rebuilt from below.png + layers.bin, so the 4.7 MB photo is not needed
      template.layered ? Promise.resolve(null) : ensurePixels(`/files/${template.base}`, W, H, 'fill'),
      ensurePixels(`/files/${patternFile}`),
      mode === 'mask' ? Promise.resolve(null) : backgroundKey(plan.background, W, H),
    ]);
    const patternKeys = {};
    await Promise.all(Object.entries(plan.patternFileBySlot || {}).map(async ([slot, file]) => {
      if (file) patternKeys[slot] = await ensurePixels(`/files/${file}`);
    }));
    const engravingKeys = {};
    await Promise.all(Object.entries(plan.collarBySlot || {}).map(async ([slot, collar]) => {
      if (collar && (collar.name || collar.phone)) engravingKeys[slot] = await ensurePixels(engravingUrl(collar));
    }));
    let belowKey = null, binKey = null;
    const plateKeys = {};
    if (template.layered) {
      [belowKey, binKey] = await Promise.all([
        ensurePixels(`/files/${template.layered.below}`, W, H, 'fill'),
        ensureBin(`/files/${template.layered.bin}`),
      ]);
      // baked metal plates, only for the finishes in use
      const used = new Set(Object.values(plan.finishBySlot || {}));
      await Promise.all(Object.entries(template.layered.metalPlates || {}).map(async ([fin, file]) => {
        if (used.has(fin)) plateKeys[fin] = await ensurePixels(`/files/${file}`, W, H, 'fill');
      }));
    }
    const id = nextId++;
    // everything except the engraving: when this is unchanged the worker reuses its last stage
    const stageKey = template.layered && mode !== 'mask' ? JSON.stringify([template.id, baseKey, belowKey, binKey, sorted(plateKeys), patternKey, sorted(patternKeys), bgKey, sorted(plan.finishBySlot), mode, plan.patternScale, sorted(plan.patternScaleBySlot)]) : null;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: 'render', id, template, baseKey, belowKey, binKey, plateKeys, patternKey, patternKeys, bgKey, engravingKeys,
        finishBySlot: plan.finishBySlot, mode, patternScale: plan.patternScale, patternScaleBySlot: plan.patternScaleBySlot, stageKey,
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
