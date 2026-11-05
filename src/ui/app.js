/* Listing view: decision controls on the left, live frames on the right. */
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
    for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(c));
    return node;
  };

  const state = {
    patterns: [], templates: {}, frames: null, decision: null, fonts: [], presets: [], backgroundFiles: [],
    mode: 'final', view: 'listing',
  };
  const listeners = new Set();

  /* ---------------- api ---------------- */
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
    s.className = `status ${kind}`;
    clearTimeout(statusTimer);
    if (kind === 'ok') statusTimer = setTimeout(() => { s.textContent = ''; }, 3500);
  }

  async function loadTemplate(id, force) {
    if (!state.templates[id] || force) state.templates[id] = await api(`/api/templates/${id}`);
    return state.templates[id];
  }

  /* ---------------- decision helpers ---------------- */
  function assignment() {
    return MockupPlan.assignFinishes(state.decision.listing.centerColor, state.frames.sideOrder);
  }

  // collar index -> role, using the hero template's slots (all frames share the rule)
  const COLLAR_ROLE = ['left', 'center', 'right'];
  const ROLE_LABEL = { left: 'Left', center: 'Center', right: 'Right' };

  function decisionChanged({ renderNow = true } = {}) {
    $('#decisionJson').textContent = JSON.stringify(state.decision, null, 2);
    if (renderNow) scheduleRender();
    scheduleSave();
    listeners.forEach((fn) => fn('decision'));
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await api('/api/decision', state.decision); setStatus('Decision saved', 'ok'); } catch (err) { setStatus(err.message, 'err'); }
    }, 700);
  }

  /* ---------------- sidebar ---------------- */
  const POSITION = ['Left', 'Middle', 'Right'];
  let patternMode = 'same';

  function patternTile(p, active, onPick) {
    return el('button', { class: `pattern-tile ${active ? 'active' : ''}`, title: p.label, onclick: onPick },
      el('div', { class: 'sw', style: `background-image:url("/files/${encodeURI(p.file)}")` }), el('span', {}, p.label));
  }

  function renderPatternPicker() {
    const d = state.decision;
    $$('#patternModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.pmode === patternMode));
    if (patternMode === 'same') {
      $('#patternPicker').replaceChildren(el('div', { class: 'pattern-grid' }, state.patterns.map((p) => patternTile(p, d.patternFile === p.file, () => {
        d.patternFile = p.file;
        d.patternLabel = p.label;
        renderPatternPicker();
        decisionChanged();
      }))));
      return;
    }
    const a = assignment();
    d.collarPatterns = d.collarPatterns || [null, null, null];
    const rows = [0, 1, 2].map((i) => {
      const current = MockupPlan.patternForCollar(d, i);
      return el('div', { class: 'row' },
        el('span', {}, el('span', { class: `dot ${a[COLLAR_ROLE[i]]}`, style: 'width:12px;height:12px;border-radius:50%;display:inline-block' }), POSITION[i]),
        el('div', { class: 'tiles' }, state.patterns.map((p) => patternTile(p, current === p.file, () => {
          d.collarPatterns[i] = p.file;
          if (i === 1) { d.patternFile = p.file; d.patternLabel = p.label; }
          renderPatternPicker();
          decisionChanged();
        }))));
    });
    $('#patternPicker').replaceChildren(el('div', { class: 'per-collar' }, rows,
      el('p', { class: 'hint', style: 'margin:0' }, 'The leash uses the middle collar\'s pattern.')));
  }

  function setPatternMode(mode) {
    patternMode = mode;
    if (mode === 'same') delete state.decision.collarPatterns;
    renderPatternPicker();
    decisionChanged();
  }

  function renderFinishChips() {
    const center = state.decision.listing.centerColor;
    $('#finishChips').replaceChildren(...MockupPlan.FINISHES.map((f) => el('button', {
      class: `finish-chip ${f === center ? 'active' : ''}`,
      onclick: () => { state.decision.listing.centerColor = f; renderFinishChips(); renderCollarCards(); renderPatternPicker(); decisionChanged(); },
    }, el('span', { class: `dot ${f}` }), MockupPlan.FINISH_LABELS[f], el('small', {}, f === center ? 'Best seller' : ''))));
  }

  function renderCollarCards() {
    const a = assignment();
    const cards = state.decision.listing.collars.map((collar, i) => {
      const role = COLLAR_ROLE[i];
      const finish = a[role];
      const input = (key, placeholder) => el('input', {
        type: 'text', value: collar[key] || '', placeholder, 'aria-label': `${POSITION[i]} collar ${placeholder}`,
        oninput: (e) => { collar[key] = e.target.value; decisionChanged(); },
      });
      // storefront buckle fonts; the preview image is the storefront's own sample
      const fontPicker = (key, label, fallback) => {
        const current = collar[key] || fallback;
        const info = state.fonts.find((f) => f.name === current);
        const preview = el('img', { class: 'font-preview', alt: '', src: (info && info.preview) || '' });
        const select = el('select', {
          'aria-label': `${POSITION[i]} collar ${label.toLowerCase()}`,
          onchange: (e) => {
            collar[key] = e.target.value;
            const f = state.fonts.find((x) => x.name === collar[key]);
            preview.src = (f && f.preview) || '';
            decisionChanged();
          },
        }, state.fonts.map((f) => el('option', { value: f.name, selected: f.name === current }, `${label}: ${f.name}`)));
        return el('div', { class: 'font-pick' }, select, preview);
      };
      const phone = el('div', { class: 'phone-row' }, input('phone', '419-555-0148'),
        el('button', {
          class: 'mini-btn', title: 'New 419-555-XXXX number', 'aria-label': `${POSITION[i]} collar new phone number`,
          onclick: async () => { collar.phone = (await api('/api/phone')).phone; renderCollarCards(); decisionChanged(); },
        }, '↻'));
      return el('div', { class: `collar-row ${role === 'center' ? 'center' : ''}` },
        el('div', { class: 'head' }, el('span', { class: `dot ${finish}` }), `${POSITION[i]} collar`,
          el('small', {}, role === 'center' ? `${MockupPlan.FINISH_LABELS[finish]} · same as leash` : MockupPlan.FINISH_LABELS[finish])),
        input('name', 'Name'), phone,
        fontPicker('font', 'Name font', state.fonts[0] && state.fonts[0].name),
        fontPicker('phoneFont', 'Phone font', state.phoneFont));
    });
    $('#collarCards').replaceChildren(...cards);
  }

  function currentBgId() {
    const l = state.decision.listing;
    if (l.backgroundFile) return `file:${l.backgroundFile}`;
    return `preset:${l.backgroundPreset || 'winter-linen'}`;
  }

  function renderBgChips() {
    const active = currentBgId();
    const chips = [
      { id: 'preset:photo', label: 'Studio photo', style: 'background:#fbfbfa', set: () => { delete state.decision.listing.backgroundFile; state.decision.listing.backgroundPreset = 'photo'; } },
      ...state.presets.map((p) => ({
        id: `preset:${p.id}`, label: p.label, style: `background-image:url(/api/background.png?preset=${p.id}&w=120&h=60)`,
        set: () => { delete state.decision.listing.backgroundFile; state.decision.listing.backgroundPreset = p.id; },
      })),
      ...state.backgroundFiles.map((b) => ({
        id: `file:${b.file}`, label: b.label, style: `background-image:url("/files/${encodeURI(b.file)}")`,
        set: () => { state.decision.listing.backgroundFile = b.file; },
      })),
    ];
    $('#bgChips').replaceChildren(...chips.map((c) => el('button', {
      class: `bg-chip ${c.id === active ? 'active' : ''}`, title: c.label,
      onclick: () => { c.set(); renderBgChips(); decisionChanged(); },
    }, el('div', { class: 'sw', style: c.style }), el('span', {}, c.label))));
  }

  function renderSidebar() {
    patternMode = (state.decision.collarPatterns || []).some(Boolean) ? 'each' : 'same';
    renderPatternPicker();
    renderFinishChips();
    renderCollarCards();
    renderBgChips();
    const ps = state.decision.patternScale || 1;
    $('#patternScale').value = ps;
    $('#patternScaleOut').textContent = `${ps.toFixed(2)}×`;
    $('#decisionJson').textContent = JSON.stringify(state.decision, null, 2);
  }

  /* ---------------- frames ---------------- */
  const frameEls = {};
  function buildFrames() {
    const wrap = $('#frames');
    wrap.replaceChildren();
    state.frames.frames.forEach((frame, n) => {
      const canvas = el('canvas', { title: 'Click to compare with the original photo' });
      const tags = el('span', { class: 'tags' });
      const card = el('div', { class: `frame ${n === 0 ? 'hero' : ''}` },
        el('div', { class: 'frame-head' }, el('span', { class: 'fnum' }, String(n + 1)), el('strong', {}, frame.label),
          el('span', { class: 'cap' }, frame.caption || ''), el('span', { class: 'spacer' }), tags),
        el('div', { class: 'canvas-wrap' }, canvas));
      canvas.addEventListener('click', () => openLightbox(frame));
      wrap.append(card);
      frameEls[frame.id] = { card, canvas, tags, wrap: card.querySelector('.canvas-wrap') };
    });
  }

  function updateTags(frame, plan) {
    const seen = new Map();
    const template = state.templates[frame.template];
    for (const [slot, finish] of Object.entries(plan.finishBySlot)) {
      const label = template.slots[slot].label;
      seen.set(slot, el('span', { class: 'tag' }, el('span', { class: `dot ${finish}` }), label));
    }
    frameEls[frame.id].tags.replaceChildren(...seen.values());
  }

  let renderSeq = 0;
  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 60);
  }

  async function renderAll() {
    const seq = ++renderSeq;
    const t0 = performance.now();
    let total = 0;
    try {
      await Promise.all(state.frames.frames.map(async (frame) => {
        const template = await loadTemplate(frame.template);
        const plan = MockupPlan.planFrame(frame, template, state.decision, state.frames.sideOrder);
        updateTags(frame, plan);
        const { canvas, wrap } = frameEls[frame.id];
        wrap.classList.add('busy');
        let image;
        if (state.mode === 'photo') {
          image = await RenderClient.photoPixels(template, RenderClient.previewScale(template));
        } else {
          const r = await RenderClient.renderPlan(plan, template, state.decision.patternFile, { mode: state.mode });
          image = r.image; total += r.ms;
        }
        if (seq !== renderSeq) return;
        canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').putImageData(image, 0, 0);
        wrap.classList.remove('busy');
      }));
      if (seq === renderSeq) {
        $('#renderInfo').textContent = state.mode === 'photo'
          ? 'These are the original template photos before any changes.'
          : `Updated in ${(Math.round(performance.now() - t0) / 1000).toFixed(1)} s. The pattern, metal color and engraving are applied by code onto real photos; the AI never draws the product.`;
      }
    } catch (err) {
      setStatus(err.message, 'err');
    }
  }

  /* ---------------- lightbox (before / after) ---------------- */
  async function openLightbox(frame) {
    const src = frameEls[frame.id].canvas;
    const template = state.templates[frame.template];
    const after = $('#lbAfter');
    const before = $('#lbBefore');
    after.width = src.width; after.height = src.height;
    after.getContext('2d').drawImage(src, 0, 0);
    const photo = await RenderClient.photoPixels(template, src.width / template.width);
    before.width = photo.width; before.height = photo.height;
    before.getContext('2d').putImageData(photo, 0, 0);
    $('#lbTitle').textContent = `${frame.label} — ${template.name}`;
    $('#lightbox').hidden = false;
    setSplit(0.5);
  }
  function setSplit(f) {
    f = Math.max(0, Math.min(1, f));
    $('#lbBeforeWrap').style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
    $('#lbHandle').style.left = `${f * 100}%`;
  }
  (function wireLightbox() {
    const cmp = $('#lbCompare');
    let dragging = false;
    const move = (e) => { const r = cmp.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); };
    cmp.addEventListener('pointerdown', (e) => { dragging = true; cmp.setPointerCapture(e.pointerId); move(e); });
    cmp.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    cmp.addEventListener('pointerup', () => { dragging = false; });
    $('#lbClose').addEventListener('click', () => { $('#lightbox').hidden = true; });
    $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });
  })();

  /* ---------------- export ---------------- */
  async function exportListing() {
    const btn = $('#exportBtn');
    btn.disabled = true;
    btn.textContent = 'Saving full-size images…';
    $('#exportResult').replaceChildren();
    try {
      const r = await api('/api/export', state.decision);
      $('#exportResult').replaceChildren(
        el('div', { class: 'ok-line' }, 'Saved. Upload these to Etsy:'), el('code', {}, r.folder),
        el('div', { style: 'display:flex;gap:10px;margin-top:6px;flex-wrap:wrap' },
          r.files.map((f) => el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.label))));
      setStatus('Saved 3 images', 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
      $('#exportResult').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save 3 Etsy images';
    }
  }

  /* ---------------- wiring ---------------- */
  function switchView(view) {
    state.view = view;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    listeners.forEach((fn) => fn('view'));
    if (view === 'listing') scheduleRender();
  }

  async function init() {
    try {
      const s = await api('/api/state');
      Object.assign(state, {
        patterns: s.patterns, frames: s.frames, decision: s.decision, fonts: s.fonts, phoneFont: s.phoneFont,
        presets: s.presets, backgroundFiles: s.backgroundFiles, templateList: s.templates,
      });
      const names = state.fonts.map((f) => f.name);
      state.decision.listing.collars.forEach((c) => { if (names.length && !names.includes(c.font)) c.font = names[0]; });
      buildFrames();
      renderSidebar();
      $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
      $('#modeSelect').addEventListener('change', (e) => { state.mode = e.target.value; scheduleRender(); });
      $$('#patternModeSeg button').forEach((b) => b.addEventListener('click', () => setPatternMode(b.dataset.pmode)));
      $('#patternScale').addEventListener('input', (e) => {
        state.decision.patternScale = Number(e.target.value);
        $('#patternScaleOut').textContent = `${state.decision.patternScale.toFixed(2)}×`;
        decisionChanged();
      });
      $('#exportBtn').addEventListener('click', exportListing);
      $('#bgUpload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file); });
        try {
          const r = await api('/api/backgrounds', { name: file.name.replace(/\.[^.]+$/, ''), dataUrl });
          const s2 = await api('/api/state');
          state.backgroundFiles = s2.backgroundFiles;
          state.decision.listing.backgroundFile = r.file;
          renderBgChips();
          decisionChanged();
        } catch (err) { setStatus(err.message, 'err'); }
        e.target.value = '';
      });
      await renderAll();
      listeners.forEach((fn) => fn('ready'));
    } catch (err) {
      setStatus(err.message, 'err');
      console.error(err);
    }
  }

  window.Studio = { state, api, setStatus, loadTemplate, el, $, $$, on: (fn) => listeners.add(fn), scheduleRender };
  init();
})();
