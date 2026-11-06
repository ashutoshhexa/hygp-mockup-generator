/* /listing: the main Etsy photo only. Settings on the right, live photo on the left, download. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
    return node;
  };
  const icon = (svg) => { const s = document.createElement('span'); s.className = 'ico'; s.innerHTML = svg; return s; };

  const FIN_LABEL = { gold: 'Gold', rosegold: 'Rose gold', silver: 'Silver' };
  const ICONS = {
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m13.2 13.2 3.6 3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 8A6 6 0 0 0 4.6 6.3M4.5 12a6 6 0 0 0 10.9 1.7M15.8 3.6v4.6h-4.6M4.2 16.4v-4.6h4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const state = {
    decision: null, frame: null, template: null, sideOrder: null,
    fonts: [], phoneFont: 'Roboto', presets: [], backgroundFiles: [], localPatterns: [],
    collections: [], collection: null, patternsBy: new Map(), search: '', loadingPatterns: false, patternError: '',
    applyTo: 'all', // 'all' | collar index: what pattern clicks and the size slider change
    openFonts: new Set(), // collar indexes whose lettering grid is open
  };
  const patternLabels = new Map();

  /* ---------------- api / status ---------------- */
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let statusTimer = null;
  function setStatus(text, kind = '') {
    const s = $('#status');
    s.textContent = text;
    s.className = `status ${kind} ${text ? 'show' : ''}`;
    clearTimeout(statusTimer);
    if (kind !== 'err') statusTimer = setTimeout(() => { s.className = 'status'; }, 2600);
  }

  /* ---------------- collars, top to bottom as they appear in the photo ---------------- */
  function collars() {
    const roles = MockupPlan.assignFinishes(state.decision.listing.centerColor, state.sideOrder);
    return Object.values(state.template.slots)
      .filter((s) => s.collar != null)
      .map((s) => ({ index: s.collar, label: s.label, short: s.label.replace(/ collar$/i, ''), role: s.role, finish: roles[s.role] }));
  }

  /* ---------------- render ---------------- */
  let inFlight = 0;
  let idleWaiters = [];
  let busyTimer = null;
  let firstDone = false;

  function setBusy(on, text) {
    clearTimeout(busyTimer);
    const b = $('#busy');
    if (!on) { b.classList.remove('on'); return; }
    $('#busyText').textContent = text;
    // quick updates (names, lettering) finish before the loader would even appear
    busyTimer = setTimeout(() => b.classList.add('on'), firstDone ? 280 : 0);
  }

  async function render() {
    inFlight++;
    setBusy(true, firstDone ? 'Updating photo…' : 'Loading photo… the first time takes a moment');
    try {
      const plan = MockupPlan.planFrame(state.frame, state.template, state.decision, state.sideOrder);
      const r = await RenderClient.renderPlan(plan, state.template, state.decision.patternFile, { mode: 'final' });
      if (r) {
        const c = $('#photo');
        if (c.width !== r.image.width) c.width = r.image.width;
        if (c.height !== r.image.height) c.height = r.image.height;
        c.getContext('2d').putImageData(r.image, 0, 0);
        if (!firstDone) $('#stage').classList.add('ready');
        firstDone = true;
        $('#dlPng').disabled = false;
      }
      $('#fail').hidden = true;
    } catch (err) {
      console.error(err);
      // a failed first load leaves an empty stage: say what happened and offer a retry
      if (!firstDone) $('#fail').hidden = false;
      else setStatus('Could not update the photo. Check your connection and try again.', 'err');
    } finally {
      inFlight--;
      if (!inFlight) {
        setBusy(false);
        idleWaiters.splice(0).forEach((fn) => fn());
      }
    }
  }
  const idle = () => (inFlight ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve());

  let saveTimer = null;
  function changed({ rerender = true } = {}) {
    if (rerender) render();
    updateSummaries();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await api('/api/decision', state.decision); } catch (err) { setStatus(err.message, 'err'); }
    }, 700);
  }

  /* ---------------- compare with the original photo (drag the divider) ---------------- */
  let split = 0.5;
  function setView(view) {
    const compare = view === 'compare';
    $$('.seg button').forEach((b) => { const on = b.dataset.view === view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('#compare').hidden = !compare;
    if (compare && !$('#orig').getAttribute('src')) $('#orig').src = `/files/${encodeURI(state.template.base)}`;
    if (compare) setSplit(split);
  }
  function setSplit(f) {
    split = Math.max(0, Math.min(1, f));
    $('#origWrap').style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
    $('#handle').style.left = `${split * 100}%`;
    $('#handle').setAttribute('aria-valuenow', String(Math.round(split * 100)));
    $('#compare').classList.toggle('edge-left', split < 0.14);
    $('#compare').classList.toggle('edge-right', split > 0.86);
  }
  function wireCompare() {
    const cmp = $('#compare');
    let dragging = false;
    const move = (e) => { const r = cmp.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); };
    cmp.addEventListener('pointerdown', (e) => { dragging = true; cmp.setPointerCapture(e.pointerId); cmp.classList.add('dragging'); move(e); });
    cmp.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    const stop = () => { dragging = false; cmp.classList.remove('dragging'); };
    cmp.addEventListener('pointerup', stop);
    cmp.addEventListener('pointercancel', stop);
    $('#handle').addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') { setSplit(split - step); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setSplit(split + step); e.preventDefault(); }
    });
    $$('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  }

  /* ---------------- download ---------------- */
  function slug(text) {
    return String(text || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'listing';
  }

  /*
   * Square version without distorting anything. With template.squareCrop the square is cut so the
   * belt has the same margin on the left and right (the D-ring may be cut on the right), which
   * makes the collars, and the engraving, as large as possible in small listing thumbnails.
   * The crop is centred on the product; where it runs past the photo, the backdrop is continued
   * (extendRows). Without squareCrop the whole photo is kept and the backdrop is added above and
   * below. Works at any size (the 3000 px download and the dialog thumbnail); the result is
   * src.width square.
   */
  function squareCanvas(src) {
    const W = src.width, H = src.height;
    if (W <= H) return src; // already square or portrait
    const crop = state.template && state.template.squareCrop;
    if (!crop) {
      const top = Math.floor((W - H) / 2);
      return extendRows(src, top, W - H - top);
    }
    const k = W / state.template.width;
    const [b0, b1] = crop.beltX.map((v) => v * k);
    const [p0, p1] = crop.productY.map((v) => v * k);
    const m = crop.margin != null ? crop.margin : 0.09;
    const S = Math.min(W, Math.round((b1 - b0) / (1 - 2 * m)));
    const x0 = Math.max(0, Math.min(W - S, Math.round(b0 - m * S)));
    const y0 = Math.round((p0 + p1) / 2 - S / 2);
    const padTop = Math.max(0, -y0), padBottom = Math.max(0, y0 + S - H);
    const tall = padTop || padBottom ? extendRows(src, padTop, padBottom) : src;
    const out = document.createElement('canvas');
    out.width = W; out.height = W;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tall, x0, y0 + padTop, S, S, 0, 0, W, W);
    return out;
  }

  /*
   * Continue the backdrop above and below the photo, which is kept untouched. Each added row is
   * the edge of the photo (averaged over a few rows), blurred sideways a little more the further
   * it is from the photo, so the backdrop fades on with no seam, stretch or repeated detail.
   */
  function extendRows(src, top, bottom) {
    const W = src.width, H = src.height, S = H + top + bottom;
    const out = document.createElement('canvas');
    out.width = W; out.height = S;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, top);
    const img = ctx.getImageData(0, 0, W, S);
    const d = img.data;
    const band = Math.max(2, Math.round(H * 0.01));
    const edgeProfile = (y0) => {
      const row = new Float64Array(W * 3);
      for (let y = y0; y < y0 + band; y++) for (let x = 0; x < W; x++) {
        const j = ((y + top) * W + x) * 4;
        row[x * 3] += d[j]; row[x * 3 + 1] += d[j + 1]; row[x * 3 + 2] += d[j + 2];
      }
      for (let i = 0; i < row.length; i++) row[i] /= band;
      // prefix sums per channel for quick sideways blurs
      const pre = new Float64Array((W + 1) * 3);
      for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) pre[(x + 1) * 3 + c] = pre[x * 3 + c] + row[x * 3 + c];
      return pre;
    };
    const fill = (pre, count, rowAt) => {
      for (let k = 1; k <= count; k++) {
        const r = Math.min(Math.floor(W / 3), Math.round(k * 0.6));
        const y = rowAt(k);
        for (let x = 0; x < W; x++) {
          const a = Math.max(0, x - r), b = Math.min(W, x + r + 1), n = b - a, j = (y * W + x) * 4;
          for (let c = 0; c < 3; c++) d[j + c] = (pre[b * 3 + c] - pre[a * 3 + c]) / n + (Math.random() - 0.5); // +-0.5 dither: no banding
          d[j + 3] = 255;
        }
      }
    };
    fill(edgeProfile(0), top, (k) => top - k);
    fill(edgeProfile(H - band), bottom, (k) => top + H - 1 + k);
    ctx.putImageData(img, 0, 0);
    return out;
  }

  const DL_PREFS = 'listing-download';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(DL_PREFS)) || {}; } catch { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(DL_PREFS, JSON.stringify(p)); } catch { /* private mode: fine */ }
  }

  async function openDownload() {
    const dlg = $('#dlDialog');
    const prefs = loadPrefs();
    const form = dlg.querySelector('form');
    if (prefs.shape) form.elements.shape.value = prefs.shape;
    if (prefs.type) form.elements.type.value = prefs.type;
    await idle(); // thumbnails and file come from the finished photo
    const photo = $('#photo');
    const small = document.createElement('canvas');
    small.width = 240; small.height = Math.round((240 * photo.height) / photo.width);
    small.getContext('2d').drawImage(photo, 0, 0, small.width, small.height);
    $('#thumbOriginal').getContext('2d').drawImage(small, 0, 0, 240, 180);
    $('#thumbSquare').getContext('2d').drawImage(squareCanvas(small), 0, 0, 240, 240);
    dlg.returnValue = '';
    dlg.showModal();
  }

  async function download(shape, type) {
    const btn = $('#dlPng');
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = inFlight ? 'Finishing…' : 'Preparing…';
    try {
      await idle(); // never download a frame that is still being updated
      const photo = $('#photo');
      const canvas = shape === 'square' ? squareCanvas(photo) : photo;
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), type, 0.95));
      const ext = type === 'image/png' ? 'png' : 'jpg';
      const a = el('a', { href: URL.createObjectURL(blob), download: `${slug(state.decision.patternLabel)}-main-photo${shape === 'square' ? '-square' : ''}.${ext}` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`Downloaded ${canvas.width} × ${canvas.height} ${ext.toUpperCase()} · ${(blob.size / 1048576).toFixed(1)} MB`, 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      btn.innerHTML = label;
      btn.disabled = false;
    }
  }

  function wireDownload() {
    const dlg = $('#dlDialog');
    $('#dlPng').addEventListener('click', openDownload);
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'download') return;
      const form = dlg.querySelector('form');
      const prefs = { shape: form.elements.shape.value, type: form.elements.type.value };
      savePrefs(prefs);
      download(prefs.shape, prefs.type);
    });
    // click on the dimmed backdrop closes
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  }

  /* ---------------- 1. pattern ---------------- */
  function patternLabel(file) {
    const d = state.decision;
    return patternLabels.get(file) || (file === d.patternFile && d.patternLabel) || file.split('/').pop().replace(/\.[^.]+$/, '');
  }
  const currentPatternFor = (index) => MockupPlan.patternForCollar(state.decision, index);
  const scaleFor = (index) => MockupPlan.patternScaleForCollar(state.decision, index, state.template);
  const sizeWord = (v) => (Math.abs(v - 1) < 0.025 ? 'Standard' : `${Math.round(v * 100)}%`);

  async function loadCollections() {
    try {
      state.collections = (await api('/api/collections')).collections;
      const def = state.collections.find((c) => c.isDefault) || state.collections[0];
      await selectCollection(def ? def.id : 'local');
    } catch (err) {
      state.patternError = `Store collections unavailable (${err.message}). Showing local files.`;
      await selectCollection('local');
    }
  }

  async function selectCollection(id) {
    state.collection = id;
    state.search = '';
    if (id !== 'local' && !state.patternsBy.has(id)) {
      state.loadingPatterns = true;
      renderPattern();
      try {
        const list = (await api(`/api/collections/${id}/patterns`)).patterns;
        state.patternsBy.set(id, list);
        list.forEach((p) => patternLabels.set(p.file, p.label));
      } catch (err) { state.patternError = err.message; }
      state.loadingPatterns = false;
    }
    renderPattern();
  }

  function visiblePatterns() {
    const list = state.collection === 'local' ? state.localPatterns : state.patternsBy.get(state.collection) || [];
    const q = state.search.trim().toLowerCase();
    return q ? list.filter((p) => p.label.toLowerCase().includes(q)) : list;
  }

  // drop per-collar overrides that no longer differ from the shared value
  function tidyPerCollar() {
    const d = state.decision;
    if (d.collarPatterns && d.collarPatterns.every((f) => !f || f === d.patternFile)) delete d.collarPatterns;
    if (d.collarPatternScales && d.collarPatternScales.every((s) => !s || Math.abs(s - (d.patternScale || 1)) < 0.001)) delete d.collarPatternScales;
  }

  function pickPattern(p) {
    const d = state.decision;
    patternLabels.set(p.file, p.label);
    if (state.applyTo === 'all') {
      d.patternFile = p.file;
      d.patternLabel = p.label;
      delete d.collarPatterns;
    } else {
      const i = state.applyTo;
      d.collarPatterns = d.collarPatterns || [null, null, null];
      // the middle collar names the listing (the leash in the other photos follows it),
      // so the other collars keep what they show now
      if (i === 1) {
        d.collarPatterns = d.collarPatterns.map((f, k) => (k === 1 ? null : f || d.patternFile));
        d.patternFile = p.file; d.patternLabel = p.label;
      } else {
        d.collarPatterns[i] = p.file;
      }
    }
    tidyPerCollar();
    renderPatternGrid();
    renderApplyRow();
    changed();
  }

  function setSize(v) {
    const d = state.decision;
    if (state.applyTo === 'all') {
      d.patternScale = v;
      delete d.collarPatternScales;
    } else {
      d.collarPatternScales = d.collarPatternScales || [null, null, null];
      d.collarPatternScales[state.applyTo] = v;
    }
    tidyPerCollar();
    renderApplyRow();
    renderSizeReset();
    changed();
  }

  function isActivePattern(file) {
    if (state.applyTo === 'all') return !state.decision.collarPatterns && state.decision.patternFile === file;
    return currentPatternFor(state.applyTo) === file;
  }

  function patternTile(p) {
    return el('button', {
      class: `pat ${isActivePattern(p.file) ? 'on' : ''}`, type: 'button', title: p.label, onclick: () => pickPattern(p),
    }, el('span', { class: 'pat-img' }, el('img', { src: p.thumb || `/files/${encodeURI(p.file)}`, alt: '', loading: 'lazy', decoding: 'async' })),
    el('span', { class: 'pat-name' }, p.label));
  }

  function renderPatternGrid() {
    const grid = $('#patGrid');
    if (!grid) return;
    const list = visiblePatterns();
    const note = $('#patCount');
    if (state.loadingPatterns) {
      grid.replaceChildren(...Array.from({ length: 8 }, () => el('span', { class: 'pat skeleton' }, el('span', { class: 'pat-img' }), el('span', { class: 'pat-name' }))));
      if (note) note.textContent = 'Loading…';
      return;
    }
    grid.replaceChildren(...(list.length ? list.map(patternTile) : [el('p', { class: 'empty' }, state.search ? 'No pattern matches that search.' : 'No patterns here.')]));
    if (note) note.textContent = `${list.length} pattern${list.length === 1 ? '' : 's'}`;
  }

  // the target picker: All collars / Top / Middle / Bottom, each showing what it has now
  function renderApplyRow() {
    const row = $('#applyRow');
    if (!row) return;
    const d = state.decision;
    const mixed = !!(d.collarPatterns || d.collarPatternScales);
    const opts = [{ id: 'all', label: 'All collars', sub: mixed ? 'Mixed' : patternLabel(d.patternFile) }]
      .concat(collars().map((c) => ({
        id: c.index, label: c.short, finish: c.finish,
        sub: patternLabel(currentPatternFor(c.index)) + (Math.abs(scaleFor(c.index) - (d.patternScale || 1)) > 0.001 ? ` · ${sizeWord(scaleFor(c.index))}` : ''),
      })));
    row.replaceChildren(...opts.map((o) => el('button', {
      class: `apply ${state.applyTo === o.id ? 'on' : ''}`, type: 'button', 'aria-pressed': String(state.applyTo === o.id),
      onclick: () => { state.applyTo = o.id; renderApplyRow(); renderPatternGrid(); renderSize(); },
    }, el('strong', {}, el('i', { class: `metal ${o.finish || 'all'}` }), o.label), el('small', {}, o.sub))));
  }

  function renderSizeReset() {
    const slot = $('#sizeReset');
    if (!slot) return;
    const d = state.decision;
    const i = state.applyTo;
    const overridden = i !== 'all' && d.collarPatternScales && d.collarPatternScales[i];
    slot.replaceChildren(...(overridden ? [el('button', {
      class: 'link', type: 'button',
      onclick: () => { d.collarPatternScales[i] = null; tidyPerCollar(); renderSize(); renderApplyRow(); changed(); },
    }, 'Match the other collars')] : []));
  }

  function renderSize() {
    const box = $('#sizeBox');
    if (!box) return;
    const d = state.decision;
    const target = state.applyTo === 'all' ? null : collars().find((c) => c.index === state.applyTo);
    const value = target ? scaleFor(target.index) : d.patternScale || 1;
    const out = el('output', {}, sizeWord(value));
    const range = el('input', {
      type: 'range', min: '0.5', max: '2', step: '0.05', value: String(value), 'aria-label': `Pattern size, ${target ? target.label : 'all collars'}`,
      oninput: (e) => { const v = Number(e.target.value); out.textContent = sizeWord(v); setSize(v); },
    });
    box.replaceChildren(
      el('div', { class: 'label-row' },
        el('span', {}, 'Pattern size ', el('em', {}, target ? `· ${target.label}` : '· all collars')),
        el('span', { id: 'sizeReset' })),
      el('div', { class: 'slider-row' }, el('small', {}, 'Smaller'), range, el('small', {}, 'Bigger'), out));
    renderSizeReset();
  }

  function renderPattern() {
    const select = el('select', { 'aria-label': 'Collection', onchange: (e) => selectCollection(e.target.value) },
      state.collections.map((c) => el('option', { value: c.id, selected: c.id === state.collection }, c.title)),
      state.localPatterns.length ? el('option', { value: 'local', selected: state.collection === 'local' }, 'Local files') : null);
    const search = el('div', { class: 'search' }, icon(ICONS.search), el('input', {
      type: 'search', placeholder: 'Search patterns', value: state.search, 'aria-label': 'Search patterns',
      oninput: (e) => { state.search = e.target.value; renderPatternGrid(); },
    }));
    $('#patternBody').replaceChildren(...[
      el('div', { class: 'field' }, el('span', {}, 'Change'), el('div', { class: 'apply-row', id: 'applyRow' })),
      el('div', { class: 'field-row' },
        el('label', { class: 'field grow' }, el('span', {}, 'Collection'), select),
        el('label', { class: 'field grow' }, el('span', {}, 'Search'), search)),
      el('div', { class: 'pat-head' }, el('span', { id: 'patCount', class: 'muted' }), state.patternError ? el('span', { class: 'err' }, state.patternError) : null),
      el('div', { class: 'pat-grid', id: 'patGrid' }),
      el('div', { class: 'field size', id: 'sizeBox' }),
    ].filter(Boolean));
    renderApplyRow();
    renderPatternGrid();
    renderSize();
  }

  /* ---------------- 2. buckle colors ---------------- */
  function renderFinish() {
    const center = state.decision.listing.centerColor;
    const pick = (f) => { state.decision.listing.centerColor = f; renderFinish(); renderNames(); renderApplyRow(); changed(); };
    const options = el('div', { class: 'finish-opts', role: 'radiogroup', 'aria-label': 'Featured color' },
      MockupPlan.FINISHES.map((f) => el('button', {
        class: `finish ${f === center ? 'on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(f === center), onclick: () => pick(f),
      }, el('span', { class: `swatch ${f}` }), el('strong', {}, FIN_LABEL[f]), el('small', {}, f === center ? '★ Featured' : 'Feature this'))));
    const map = el('ol', { class: 'collar-map' }, collars().map((c) => el('li', { class: c.role === 'center' ? 'feat' : '' },
      el('span', { class: 'pos' }, c.label), el('span', { class: 'line' }), el('i', { class: `metal ${c.finish}` }), el('strong', {}, FIN_LABEL[c.finish]),
      c.role === 'center' ? el('em', {}, 'Featured') : null)));
    $('#finishBody').replaceChildren(
      el('p', { class: 'help' }, 'The photo always shows all three buckle colors. Pick the one to feature: it goes on the middle collar, where shoppers look first.'),
      options,
      el('p', { class: 'label' }, 'Where each color goes'),
      map);
  }

  /* ---------------- 3. names ---------------- */
  function fontPreviewUrl(collar, font, w = 360) {
    const linked = collar.phoneFont === collar.font;
    const q = new URLSearchParams({
      name: collar.name || 'Name', phone: collar.phone || '', font, phoneFont: linked ? font : collar.phoneFont, w: String(w),
    });
    return `/api/engraving.png?${q}`;
  }

  function setFont(collar, font) {
    const linked = collar.phoneFont === collar.font;
    collar.font = font;
    if (linked) collar.phoneFont = font;
  }

  function nameCard(c) {
    const collar = state.decision.listing.collars[c.index];
    const id = `c${c.index}`;
    let card = null;
    const refreshPreviews = debounce(() => {
      card.querySelectorAll('img[data-font]').forEach((img) => { img.src = fontPreviewUrl(collar, img.dataset.font, img.dataset.w); });
    }, 450);
    const nameInput = el('input', {
      id: `${id}-name`, type: 'text', value: collar.name || '', maxlength: '14', autocomplete: 'off', placeholder: 'e.g. Biscuit',
      oninput: (e) => { collar.name = e.target.value; changed(); refreshPreviews(); },
    });
    const phoneInput = el('input', {
      id: `${id}-phone`, type: 'text', value: collar.phone || '', inputmode: 'tel', autocomplete: 'off', placeholder: '419-555-0148',
      oninput: (e) => { collar.phone = e.target.value; changed(); refreshPreviews(); },
    });
    const newNumber = el('button', {
      class: 'btn small icon', type: 'button', title: 'Make up a new 419-555 number', 'aria-label': 'New phone number',
      onclick: async () => {
        try { collar.phone = (await api('/api/phone')).phone; phoneInput.value = collar.phone; changed(); refreshPreviews(); } catch (err) { setStatus(err.message, 'err'); }
      },
    }, icon(ICONS.refresh));

    const open = state.openFonts.has(c.index);
    const current = el('button', {
      class: `font-current ${open ? 'open' : ''}`, type: 'button', 'aria-expanded': String(open),
      onclick: () => { if (open) state.openFonts.delete(c.index); else state.openFonts.add(c.index); renderNames(); },
    }, el('img', { src: fontPreviewUrl(collar, collar.font), 'data-font': collar.font, 'data-w': '360', alt: '' }),
    el('span', { class: 'fc-text' }, el('strong', {}, collar.font), el('small', {}, open ? 'Close' : 'Change lettering')),
    el('span', { class: 'chev', 'aria-hidden': 'true' }));

    const grid = open ? el('div', { class: 'font-grid' }, state.fonts.map((f) => el('button', {
      class: `font-tile ${f.name === collar.font ? 'on' : ''}`, type: 'button', title: f.name,
      onclick: () => { setFont(collar, f.name); state.openFonts.delete(c.index); renderNames(); changed(); },
    }, el('img', { src: fontPreviewUrl(collar, f.name, 300), 'data-font': f.name, 'data-w': '300', alt: '', loading: 'lazy' }), el('span', {}, f.name)))) : null;

    const linked = collar.phoneFont === collar.font;
    const phoneStyle = el('select', {
      id: `${id}-pf`,
      onchange: (e) => { collar.phoneFont = e.target.value === '__same' ? collar.font : e.target.value; renderNames(); changed(); },
    }, el('option', { value: '__same', selected: linked }, 'Same as the name'),
    state.fonts.filter((f) => f.name !== collar.font).map((f) => el('option', { value: f.name, selected: !linked && f.name === collar.phoneFont }, f.name)));

    const sameForAll = el('button', {
      class: 'link', type: 'button',
      onclick: () => {
        for (const other of state.decision.listing.collars) { other.font = collar.font; other.phoneFont = collar.phoneFont; }
        renderNames(); changed(); setStatus('Lettering copied to all collars', 'ok');
      },
    }, 'Use on all collars');

    card = el('div', { class: `collar ${c.role === 'center' ? 'feat' : ''}` },
      el('div', { class: 'collar-head' }, el('i', { class: `metal ${c.finish}` }), el('strong', {}, c.label), el('span', { class: 'chip' }, `${FIN_LABEL[c.finish]} buckle`)),
      el('div', { class: 'field-row' },
        el('label', { class: 'field grow', for: `${id}-name` }, el('span', {}, 'Pet name'), nameInput),
        el('div', { class: 'field grow phone' }, el('label', { for: `${id}-phone` }, 'Phone number'), el('div', { class: 'inline' }, phoneInput, newNumber))),
      el('div', { class: 'field' }, el('div', { class: 'label-row' }, el('span', {}, 'Lettering'), sameForAll), current, grid),
      el('label', { class: 'field', for: `${id}-pf` }, el('span', {}, 'Phone number lettering'), phoneStyle));
    return card;
  }

  function renderNames() {
    $('#namesBody').replaceChildren(
      el('p', { class: 'help' }, 'Made-up names and 419-555 numbers, laser engraved on each buckle. The lettering previews use your pet name.'),
      ...collars().map(nameCard));
  }

  /* ---------------- 4. background ---------------- */
  function currentBgId() {
    const l = state.decision.listing;
    if (l.backgroundFile) return `file:${l.backgroundFile}`;
    return `preset:${l.backgroundPreset || 'winter-linen'}`;
  }

  function bgLabel() {
    const id = currentBgId();
    if (id === 'preset:photo') return 'Studio photo';
    const p = state.presets.find((x) => `preset:${x.id}` === id);
    if (p) return p.label;
    const f = state.backgroundFiles.find((x) => `file:${x.file}` === id);
    return f ? f.label : '';
  }

  function renderBg() {
    const active = currentBgId();
    const l = state.decision.listing;
    const chip = (id, label, style, set) => el('button', {
      class: `bg ${id === active ? 'on' : ''}`, type: 'button', title: label, 'aria-pressed': String(id === active),
      onclick: () => { set(); renderBg(); changed(); },
    }, el('span', { class: 'sw', style }), el('span', { class: 'bg-name' }, label));
    const presetChip = (p) => chip(`preset:${p.id}`, p.label, `background:linear-gradient(170deg, ${p.top}, ${p.swatch} 55%, ${p.bottom})`,
      () => { delete l.backgroundFile; l.backgroundPreset = p.id; });
    const groups = [...new Set(state.presets.map((p) => p.group || 'More'))];
    const upload = el('label', { class: 'upload' },
      el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: uploadBg }),
      el('span', {}, '+ Upload your own background'));
    $('#bgBody').replaceChildren(...[
      el('p', { class: 'help' }, 'An empty surface behind the collars. Their real shadows are kept.'),
      el('div', { class: 'bg-group' }, el('p', { class: 'label' }, 'Original'),
        el('div', { class: 'bg-grid' }, chip('preset:photo', 'Studio photo', 'background:linear-gradient(170deg,#ffffff,#f1f0ee 60%,#e4e2df)', () => { delete l.backgroundFile; l.backgroundPreset = 'photo'; }))),
      ...groups.map((g) => el('div', { class: 'bg-group' }, el('p', { class: 'label' }, g),
        el('div', { class: 'bg-grid' }, state.presets.filter((p) => (p.group || 'More') === g).map(presetChip)))),
      state.backgroundFiles.length ? el('div', { class: 'bg-group' }, el('p', { class: 'label' }, 'Your uploads'),
        el('div', { class: 'bg-grid' }, state.backgroundFiles.map((b) => chip(`file:${b.file}`, b.label, `background-image:url("/files/${encodeURI(b.file)}")`, () => { l.backgroundFile = b.file; })))) : null,
      upload,
    ].filter(Boolean));
  }

  async function uploadBg(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      const r = await api('/api/backgrounds', { name: file.name.replace(/\.[^.]+$/, ''), dataUrl });
      state.backgroundFiles = (await api('/api/state')).backgroundFiles;
      state.decision.listing.backgroundFile = r.file;
      renderBg();
      changed();
    } catch (err) { setStatus(err.message, 'err'); }
  }

  /* ---------------- summaries (collapsed steps) + facts under the photo ---------------- */
  function updateSummaries() {
    const d = state.decision;
    const pat = d.collarPatterns ? 'Mixed patterns' : patternLabel(d.patternFile);
    $('#sumPattern').textContent = pat;
    $('#sumFinish').textContent = `${FIN_LABEL[d.listing.centerColor]} featured`;
    $('#sumNames').textContent = d.listing.collars.map((c) => c.name).filter(Boolean).join(' · ');
    $('#sumBg').textContent = bgLabel();
    $('#facts').replaceChildren(
      el('span', { class: 'fact' }, el('i', { class: `metal ${d.listing.centerColor}` }), `${FIN_LABEL[d.listing.centerColor]} featured`),
      el('span', { class: 'fact' }, pat),
      el('span', { class: 'fact' }, bgLabel()),
      el('span', { class: 'fact dim' }, 'Downloads square or original'));
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ---------------- start ---------------- */
  async function init() {
    try {
      wireCompare();
      const s = await api('/api/state');
      state.decision = s.decision;
      state.fonts = s.fonts;
      state.phoneFont = s.phoneFont;
      state.presets = s.presets;
      state.backgroundFiles = s.backgroundFiles;
      state.localPatterns = s.patterns;
      state.localPatterns.forEach((p) => patternLabels.set(p.file, p.label));
      state.sideOrder = s.frames.sideOrder;
      state.frame = s.frames.frames[0];
      state.template = await api(`/api/templates/${state.frame.template}`);
      const names = state.fonts.map((f) => f.name);
      for (const c of state.decision.listing.collars) {
        if (names.length && !names.includes(c.font)) c.font = names[0];
        if (!c.phoneFont) c.phoneFont = s.phoneFont; // what the buckle uses when none is set
        if (names.length && !names.includes(c.phoneFont)) c.phoneFont = c.font;
      }
      const l = state.decision.listing;
      if (l.backgroundFile && !state.backgroundFiles.some((b) => b.file === l.backgroundFile)) delete l.backgroundFile;
      if (l.backgroundPreset && l.backgroundPreset !== 'photo' && !state.presets.some((p) => p.id === l.backgroundPreset)) l.backgroundPreset = 'winter-linen';
      state.collection = 'local';
      renderPattern();
      renderFinish();
      renderNames();
      renderBg();
      updateSummaries();
      wireDownload();
      $('#retry').addEventListener('click', () => { $('#fail').hidden = true; render(); });
      render();
      loadCollections();
    } catch (err) {
      console.error(err);
      $('#fail').hidden = false;
    }
  }

  init();
})();
