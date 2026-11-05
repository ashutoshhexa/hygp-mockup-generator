/* Template editor: draw straps / metal / engraving faces over the photo, live preview underneath. */
(function () {
  'use strict';

  const S = window.Studio;
  const { el, $, $$ } = S;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    return n;
  };
  const TYPE_LABEL = { strap: 'Strap', hardware: 'Metal', engraving: 'Engrave', keep: 'Keep' };
  const TYPE_COLOR = { strap: '#e2553f', hardware: '#2f7fe0', engraving: '#d9a400', keep: '#3c9a5f' };

  const ed = {
    id: null, tpl: null, saved: null, sel: -1, ring: 0, tool: 'select', mode: 'final', overlay: true,
    zoom: 1, undo: [], pendingTop: null, scale: 1, ready: false,
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const round = (v) => Math.round(v * 10) / 10;
  const layer = () => (ed.tpl && ed.sel >= 0 ? ed.tpl.layers[ed.sel] : null);
  const dirty = () => JSON.stringify(ed.tpl) !== ed.saved;

  function pushUndo() {
    ed.undo.push(JSON.stringify(ed.tpl));
    if (ed.undo.length > 200) ed.undo.shift();
  }
  function undo() {
    if (!ed.undo.length) return;
    ed.tpl = JSON.parse(ed.undo.pop());
    if (ed.sel >= ed.tpl.layers.length) ed.sel = ed.tpl.layers.length - 1;
    changed({ structure: true });
  }

  /* ---------------- load / save ---------------- */
  async function open(id) {
    if (ed.tpl && dirty() && !confirm('Discard unsaved template changes?')) {
      $('#edTemplate').value = ed.id;
      return;
    }
    const t = await S.loadTemplate(id, true);
    ed.id = id; ed.tpl = clone(t); ed.saved = JSON.stringify(ed.tpl); ed.sel = -1; ed.undo = []; ed.pendingTop = null;
    ed.scale = RenderClient.previewScale(ed.tpl, 1600);
    $('#edTemplate').value = id;
    fitZoom();
    changed({ structure: true });
  }

  async function save() {
    try {
      await S.api(`/api/templates/${ed.id}`, ed.tpl);
      ed.saved = JSON.stringify(ed.tpl);
      S.state.templates[ed.id] = clone(ed.tpl);
      S.setStatus(`Saved template ${ed.id}`, 'ok');
      renderLayerList();
      S.scheduleRender();
    } catch (err) {
      S.setStatus(err.message, 'err');
    }
  }

  /* ---------------- render ---------------- */
  let renderBusy = false, renderAgain = false;
  async function renderPreview() {
    if (!ed.tpl) return;
    if (renderBusy) { renderAgain = true; return; }
    renderBusy = true;
    try {
      const canvas = $('#edCanvas');
      let image;
      if (ed.mode === 'photo') {
        image = await RenderClient.photoPixels(ed.tpl, ed.scale);
      } else {
        const frames = S.state.frames.frames;
        const frame = frames.find((f) => f.template === ed.id) || { id: 'edit', label: 'edit', template: ed.id, background: 'photo' };
        const plan = MockupPlan.planFrame(frame, ed.tpl, S.state.decision, S.state.frames.sideOrder);
        const r = await RenderClient.renderPlan(plan, ed.tpl, S.state.decision.patternFile, { mode: ed.mode, scale: ed.scale });
        image = r.image;
      }
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width; canvas.height = image.height;
        applyZoom();
      }
      canvas.getContext('2d').putImageData(image, 0, 0);
    } catch (err) {
      S.setStatus(err.message, 'err');
    } finally {
      renderBusy = false;
      if (renderAgain) { renderAgain = false; renderPreview(); }
    }
  }

  function changed({ structure = false, geometry = true } = {}) {
    if (structure) { renderLayerList(); renderProps(); }
    drawOverlay();
    if (geometry) renderPreview();
    $('#edSave').textContent = dirty() ? 'Save template •' : 'Save template';
  }

  /* ---------------- zoom ---------------- */
  function applyZoom() {
    const stage = $('#edStage');
    const w = ed.tpl.width * ed.zoom, h = ed.tpl.height * ed.zoom;
    const canvas = $('#edCanvas');
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    stage.style.width = `${w}px`; stage.style.height = `${h}px`;
    const svg = $('#edOverlaySvg');
    svg.setAttribute('viewBox', `0 0 ${ed.tpl.width} ${ed.tpl.height}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    $('#zoomVal').textContent = `${Math.round(ed.zoom * 100)}%`;
    drawOverlay();
  }
  function fitZoom() {
    const sc = $('#edScroller');
    const availW = Math.max(200, sc.clientWidth - 60), availH = Math.max(200, sc.clientHeight - 60);
    ed.zoom = Math.min(availW / ed.tpl.width, availH / ed.tpl.height);
    applyZoom();
  }
  function zoomBy(f, cx, cy) {
    const sc = $('#edScroller');
    const before = toTpl(cx, cy);
    ed.zoom = Math.max(0.2, Math.min(12, ed.zoom * f));
    applyZoom();
    if (before && cx != null) {
      const r = $('#edOverlaySvg').getBoundingClientRect();
      sc.scrollLeft += r.left + before[0] * ed.zoom - cx;
      sc.scrollTop += r.top + before[1] * ed.zoom - cy;
    }
  }
  function toTpl(clientX, clientY) {
    if (clientX == null) return null;
    const r = $('#edOverlaySvg').getBoundingClientRect();
    return [(clientX - r.left) / ed.zoom, (clientY - r.top) / ed.zoom];
  }

  /* ---------------- overlay ---------------- */
  function strapOutline(l) {
    const pts = MockupCore.densifyRungs(l.rungs, 4);
    if (pts.length < 2) return null;
    const top = pts.map((p) => `${p.tx},${p.ty}`);
    const bot = pts.slice().reverse().map((p) => `${p.bx},${p.by}`);
    return `M${top.join('L')}L${bot.join('L')}Z`;
  }
  function ringsPath(rings) {
    return rings.filter((r) => r.length).map((r) => `M${r.map((p) => `${p[0]},${p[1]}`).join('L')}Z`).join('');
  }

  function drawOverlay() {
    const svg = $('#edOverlaySvg');
    svg.replaceChildren();
    if (!ed.tpl) return;
    const z = ed.zoom;
    const hr = 5.5 / z, sw = 1.5 / z;
    if (!ed.overlay && ed.sel < 0) return;

    ed.tpl.layers.forEach((l, i) => {
      if (l.hidden) return;
      const selected = i === ed.sel;
      if (!ed.overlay && !selected) return;
      const color = TYPE_COLOR[l.type];
      const g = svgEl('g', { 'data-layer': i });
      let d = null;
      if (l.type === 'strap') d = l.rungs && l.rungs.length >= 2 ? strapOutline(l) : null;
      else if (l.type === 'engraving') d = `M${l.quad.map((p) => p.join(',')).join('L')}Z`;
      else d = ringsPath(l.rings || []);
      if (d) {
        g.append(svgEl('path', {
          d, 'fill-rule': 'evenodd', fill: selected ? `${color}22` : 'transparent', stroke: color,
          'stroke-width': selected ? sw * 1.4 : sw, 'stroke-dasharray': selected ? null : `${4 / z} ${3 / z}`,
          class: 'body', 'data-layer': i, style: 'cursor:pointer',
        }));
      }
      if (l.type === 'strap' && l.rungs && l.rungs.length >= 2 && (selected || ed.mode === 'uv')) {
        // direction arrow along the midline
        const a = l.rungs[0], b = l.rungs[1];
        const m0 = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2], m1 = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        g.append(svgEl('line', { x1: m0[0], y1: m0[1], x2: m0[0] + (m1[0] - m0[0]) * 0.6, y2: m0[1] + (m1[1] - m0[1]) * 0.6, stroke: '#fff', 'stroke-width': sw * 1.5, 'marker-end': 'url(#arrow)' }));
      }
      svg.append(g);
    });

    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto' });
    marker.append(svgEl('path', { d: 'M0,0L10,5L0,10Z', fill: '#fff' }));
    defs.append(marker);
    svg.prepend(defs);

    const l = layer();
    if (!l || l.hidden) return;
    const color = TYPE_COLOR[l.type];
    const handle = (x, y, data, fill = '#fff', stroke = color) => {
      const c = svgEl('circle', { cx: x, cy: y, r: hr, fill, stroke, 'stroke-width': sw, class: 'handle', style: 'cursor:grab' });
      for (const [k, v] of Object.entries(data)) c.dataset[k] = v;
      svg.append(c);
    };
    if (l.type === 'strap') {
      (l.rungs || []).forEach((r, ri) => {
        svg.append(svgEl('line', { x1: r[0], y1: r[1], x2: r[2], y2: r[3], stroke: color, 'stroke-width': sw, 'stroke-dasharray': `${3 / z} ${2 / z}` }));
        handle(r[0], r[1], { kind: 'rung', idx: ri, part: 0 }, '#ffd23f');
        handle(r[2], r[3], { kind: 'rung', idx: ri, part: 1 });
      });
      if (ed.pendingTop) handle(ed.pendingTop[0], ed.pendingTop[1], { kind: 'pending' }, '#ffd23f', '#000');
    } else if (l.type === 'engraving') {
      l.quad.forEach((p, pi) => handle(p[0], p[1], { kind: 'quad', idx: pi }, pi === 0 ? '#ffd23f' : '#fff'));
    } else {
      (l.rings || []).forEach((ring, ri) => ring.forEach((p, pi) => handle(p[0], p[1], { kind: 'pt', ring: ri, idx: pi },
        ri === ed.ring ? '#fff' : '#cfe0ff')));
    }
  }

  /* ---------------- pointer editing ---------------- */
  let drag = null;

  function onPointerDown(e) {
    if (!ed.tpl || e.button === 1) return;
    const pt = toTpl(e.clientX, e.clientY);
    const t = e.target;
    const l = layer();

    // handle drag / delete
    if (t.classList && t.classList.contains('handle') && l) {
      const ds = t.dataset;
      if (e.altKey || e.button === 2) { e.preventDefault(); deletePoint(ds); return; }
      pushUndo();
      drag = { kind: ds.kind, idx: Number(ds.idx), part: Number(ds.part), ring: Number(ds.ring), start: pt, moved: false };
      $('#edOverlaySvg').setPointerCapture(e.pointerId);
      return;
    }

    // add points
    if (ed.tool === 'add' && l && e.button === 0) {
      e.preventDefault();
      addPoint(l, pt);
      return;
    }

    // shift-drag body to move whole layer, click body to select
    const body = t.closest && t.closest('[data-layer]');
    if (body) {
      const i = Number(body.dataset.layer);
      if (i !== ed.sel) { ed.sel = i; ed.ring = 0; ed.pendingTop = null; changed({ structure: true, geometry: false }); }
      if (e.shiftKey) {
        pushUndo();
        drag = { kind: 'move', start: pt, last: pt };
        $('#edOverlaySvg').setPointerCapture(e.pointerId);
      }
      return;
    }
    if (ed.tool === 'select' && ed.sel !== -1) { ed.sel = -1; ed.pendingTop = null; changed({ structure: true, geometry: false }); }
  }

  function onPointerMove(e) {
    if (!drag) return;
    const pt = toTpl(e.clientX, e.clientY);
    const l = layer();
    drag.moved = true;
    const x = round(pt[0]), y = round(pt[1]);
    if (drag.kind === 'rung') { l.rungs[drag.idx][drag.part * 2] = x; l.rungs[drag.idx][drag.part * 2 + 1] = y; }
    else if (drag.kind === 'quad') { l.quad[drag.idx] = [x, y]; }
    else if (drag.kind === 'pt') { l.rings[drag.ring][drag.idx] = [x, y]; }
    else if (drag.kind === 'move') {
      const dx = pt[0] - drag.last[0], dy = pt[1] - drag.last[1];
      drag.last = pt;
      moveLayer(l, dx, dy);
    }
    changed();
  }

  function onPointerUp() {
    if (drag && !drag.moved) ed.undo.pop();
    drag = null;
  }

  function moveLayer(l, dx, dy) {
    if (l.type === 'strap') l.rungs = l.rungs.map((r) => [round(r[0] + dx), round(r[1] + dy), round(r[2] + dx), round(r[3] + dy)]);
    else if (l.type === 'engraving') l.quad = l.quad.map((p) => [round(p[0] + dx), round(p[1] + dy)]);
    else l.rings = l.rings.map((ring) => ring.map((p) => [round(p[0] + dx), round(p[1] + dy)]));
  }

  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  function addPoint(l, pt) {
    const p = [round(pt[0]), round(pt[1])];
    if (l.type === 'strap') {
      if (!ed.pendingTop) { ed.pendingTop = p; drawOverlay(); help(); return; }
      pushUndo();
      const rung = [ed.pendingTop[0], ed.pendingTop[1], p[0], p[1]];
      ed.pendingTop = null;
      l.rungs = l.rungs || [];
      const mid = [(rung[0] + rung[2]) / 2, (rung[1] + rung[3]) / 2];
      if (l.rungs.length >= 2) {
        const m = (r) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
        // insert where it fits best: before first, after last, or between two rungs
        let best = { cost: Math.hypot(mid[0] - m(l.rungs[l.rungs.length - 1])[0], mid[1] - m(l.rungs[l.rungs.length - 1])[1]), at: l.rungs.length };
        const c0 = Math.hypot(mid[0] - m(l.rungs[0])[0], mid[1] - m(l.rungs[0])[1]);
        if (c0 < best.cost) best = { cost: c0, at: 0 };
        for (let i = 0; i < l.rungs.length - 1; i++) {
          const d = distToSeg(mid, m(l.rungs[i]), m(l.rungs[i + 1]));
          if (d < best.cost * 0.6) best = { cost: d, at: i + 1 };
        }
        l.rungs.splice(best.at, 0, rung);
      } else {
        l.rungs.push(rung);
      }
      changed({ structure: true });
      return;
    }
    if (l.type === 'engraving') return;
    pushUndo();
    l.rings = l.rings && l.rings.length ? l.rings : [[]];
    const ring = l.rings[Math.min(ed.ring, l.rings.length - 1)];
    if (ring.length < 3) ring.push(p);
    else {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const d = distToSeg(p, ring[i], ring[(i + 1) % ring.length]);
        if (d < bestD) { bestD = d; best = i; }
      }
      ring.splice(best + 1, 0, p);
    }
    changed({ structure: true });
  }

  function deletePoint(ds) {
    const l = layer();
    pushUndo();
    if (ds.kind === 'rung' && l.rungs.length > 0) l.rungs.splice(Number(ds.idx), 1);
    else if (ds.kind === 'pt') {
      const ring = l.rings[Number(ds.ring)];
      ring.splice(Number(ds.idx), 1);
      if (!ring.length && l.rings.length > 1) l.rings.splice(Number(ds.ring), 1);
    } else if (ds.kind === 'pending') ed.pendingTop = null;
    else { ed.undo.pop(); return; }
    changed({ structure: true });
  }

  /* ---------------- layers ---------------- */
  function newLayer(type) {
    pushUndo();
    const slots = Object.keys(ed.tpl.slots || {});
    const sel = layer();
    const slot = (sel && sel.slot) || slots[0] || 'main';
    const n = ed.tpl.layers.filter((l) => l.type === type).length + 1;
    const l = { id: `${type}-${n}`, type, slot };
    if (type === 'strap') l.rungs = [];
    else if (type === 'engraving') {
      const sc = $('#edScroller');
      const c = toTpl(sc.getBoundingClientRect().left + sc.clientWidth / 2, sc.getBoundingClientRect().top + sc.clientHeight / 2);
      const cx = Math.max(60, Math.min(ed.tpl.width - 60, c[0])), cy = Math.max(50, Math.min(ed.tpl.height - 50, c[1]));
      l.quad = [[cx - 55, cy - 40], [cx + 55, cy - 40], [cx + 55, cy + 40], [cx - 55, cy + 40]].map((p) => p.map(round));
    } else l.rings = [[]];
    const at = ed.sel >= 0 ? ed.sel + 1 : ed.tpl.layers.length;
    ed.tpl.layers.splice(at, 0, l);
    ed.sel = at; ed.ring = 0; ed.pendingTop = null;
    setTool(type === 'engraving' ? 'select' : 'add');
    changed({ structure: true });
  }

  function renderLayerList() {
    const list = $('#layerList');
    if (!ed.tpl) { list.replaceChildren(); return; }
    list.replaceChildren(...ed.tpl.layers.map((l, i) => {
      const count = l.type === 'strap' ? `${(l.rungs || []).length} rungs`
        : l.type === 'engraving' ? 'quad' : `${(l.rings || []).reduce((s, r) => s + r.length, 0)} pts`;
      return el('li', {
        class: `${i === ed.sel ? 'sel' : ''} ${l.hidden ? 'hidden-layer' : ''}`,
        onclick: () => { ed.sel = i; ed.ring = 0; ed.pendingTop = null; changed({ structure: true, geometry: false }); },
      },
      el('span', { class: `t ${l.type}`, title: TYPE_LABEL[l.type] }),
      el('span', { class: 'name', title: count }, l.id),
      el('span', { class: 'slot' }, l.slot || ''),
      el('button', { class: 'mini', title: 'Move up (drawn later)', onclick: (e) => { e.stopPropagation(); reorder(i, 1); } }, '▲'),
      el('button', { class: 'mini', title: 'Move down (drawn earlier)', onclick: (e) => { e.stopPropagation(); reorder(i, -1); } }, '▼'),
      el('button', { class: 'mini', title: 'Show / hide', onclick: (e) => { e.stopPropagation(); pushUndo(); l.hidden = !l.hidden; changed({ structure: true }); } }, l.hidden ? '◌' : '●'));
    }));
  }

  function reorder(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= ed.tpl.layers.length) return;
    pushUndo();
    const [l] = ed.tpl.layers.splice(i, 1);
    ed.tpl.layers.splice(j, 0, l);
    if (ed.sel === i) ed.sel = j;
    changed({ structure: true });
  }

  /* ---------------- properties ---------------- */
  function field(label, input) { return el('label', {}, label, input); }
  function range(label, value, min, max, step, onInput) {
    const out = el('output', {}, String(value));
    const input = el('input', { type: 'range', min, max, step, value });
    input.addEventListener('pointerdown', pushUndo);
    input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); changed(); });
    return el('label', {}, label, el('div', { class: 'range' }, input, out));
  }
  function num(label, value, onChange) {
    const input = el('input', { type: 'number', value: value == null ? '' : value });
    input.addEventListener('change', () => { pushUndo(); onChange(input.value === '' ? null : Number(input.value)); changed(); });
    return field(label, input);
  }
  function check(label, value, onChange) {
    const input = el('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => { pushUndo(); onChange(input.checked); changed(); });
    return el('label', { class: 'inline' }, input, label);
  }

  function renderProps() {
    const panel = $('#propPanel');
    const l = layer();
    if (!ed.tpl) { panel.replaceChildren(); return; }
    if (!l) { panel.replaceChildren(templateProps()); return; }
    const kids = [];
    kids.push(el('h3', {}, `${TYPE_LABEL[l.type]} layer`));
    const idInput = el('input', { type: 'text', value: l.id });
    idInput.addEventListener('change', () => { pushUndo(); l.id = idInput.value.trim() || l.id; changed({ structure: true, geometry: false }); });
    kids.push(field('Name', idInput));
    if (l.type !== 'keep') {
      const slotSel = el('select', {}, Object.entries(ed.tpl.slots).map(([id, s]) => el('option', { value: id, selected: id === l.slot }, `${s.label} (${id})`)));
      slotSel.addEventListener('change', () => { pushUndo(); l.slot = slotSel.value; changed({ structure: true }); });
      kids.push(field('Belongs to', slotSel));
    }
    if (l.type === 'strap') {
      kids.push(el('p', { class: 'note' }, 'Each rung is a pair of points across the webbing. The yellow point is the pattern\'s top edge.'));
      kids.push(check('Flip print (top edge ↔ bottom edge)', l.flip, (v) => { l.flip = v; }));
      kids.push(range('Print offset along strap', l.offset || 0, 0, 1, 0.01, (v) => { l.offset = v; }));
      kids.push(range('Foreshortening', l.foreshorten || 1, 0.3, 2, 0.05, (v) => { l.foreshorten = v; }));
      kids.push(num(`Photo white point (default ${ed.tpl.whiteRef || 235})`, l.whiteRef, (v) => { if (v) l.whiteRef = v; else delete l.whiteRef; }));
      kids.push(el('button', { onclick: () => { pushUndo(); l.rungs = l.rungs.map((r) => [r[2], r[3], r[0], r[1]]); changed(); } }, 'Swap edges of every rung'));
      kids.push(el('button', { onclick: () => { pushUndo(); l.rungs.reverse(); changed(); } }, 'Reverse direction'));
    }
    if (l.type === 'hardware' || l.type === 'keep') {
      const rings = l.rings || [];
      if (rings.length > 1) {
        const rs = el('select', {}, rings.map((r, i) => el('option', { value: i, selected: i === ed.ring }, i === 0 ? `Outline (${r.length} pts)` : `Hole ${i} (${r.length} pts)`)));
        rs.addEventListener('change', () => { ed.ring = Number(rs.value); drawOverlay(); });
        kids.push(field('Add points to', rs));
      }
      kids.push(el('button', { onclick: () => { pushUndo(); l.rings.push([]); ed.ring = l.rings.length - 1; setTool('add'); changed({ structure: true }); } }, '+ Add hole (e.g. inside a D-ring)'));
      if (l.type === 'hardware') kids.push(check('Wipe photo engraving / print on this plate', l.flatten, (v) => { l.flatten = v; }));
    }
    if (l.type === 'engraving') {
      kids.push(el('p', { class: 'note' }, 'Drag the 4 corners onto the buckle face. Yellow is top-left of the text.'));
      kids.push(range('Engraving depth', l.depth == null ? 0.82 : l.depth, 0.3, 1, 0.01, (v) => { l.depth = v; }));
    }
    kids.push(el('hr'));
    kids.push(el('button', { onclick: () => { pushUndo(); const c = clone(l); c.id += '-copy'; moveLayer(c, 12, 12); ed.tpl.layers.splice(ed.sel + 1, 0, c); ed.sel++; changed({ structure: true }); } }, 'Duplicate'));
    kids.push(el('button', { class: 'danger', onclick: deleteLayer }, 'Delete layer'));
    panel.replaceChildren(el('div', { class: 'props' }, kids));
  }

  function templateProps() {
    const t = ed.tpl;
    const kids = [el('h3', {}, 'Template settings'), el('p', { class: 'note' }, 'Select a layer to edit it. These apply to the whole photo.')];
    kids.push(field('Name', (() => { const i = el('input', { type: 'text', value: t.name }); i.addEventListener('change', () => { pushUndo(); t.name = i.value; changed({ geometry: false }); }); return i; })()));
    kids.push(num('Webbing white point', t.whiteRef, (v) => { t.whiteRef = v || 235; }));
    kids.push(num('Background white point', t.bgRef, (v) => { t.bgRef = v || 245; }));
    kids.push(range('Default print scale', t.patternScale || 1, 0.5, 2, 0.05, (v) => { t.patternScale = v; }));
    const nf = el('select', {}, ['silver', 'gold', 'rosegold'].map((f) => el('option', { value: f, selected: f === t.nativeFinish }, `Photo metal is ${f}`)));
    nf.addEventListener('change', () => { pushUndo(); t.nativeFinish = nf.value; changed(); });
    kids.push(field('Hardware in the photo', nf));
    t.metalTone = t.metalTone || { black: 30, white: 250 };
    kids.push(range('Metal shadow point', t.metalTone.black, 0, 120, 1, (v) => { t.metalTone.black = v; }));
    kids.push(range('Metal highlight point', t.metalTone.white, 150, 255, 1, (v) => { t.metalTone.white = v; }));
    kids.push(check('Allow background swap', t.replaceBackground !== false, (v) => { t.replaceBackground = v; }));
    kids.push(el('hr'));
    kids.push(el('h3', {}, 'Slots'));
    kids.push(el('p', { class: 'note' }, 'Role decides the finish: center = model\'s pick (leash too). Collar # picks which name engraves there.'));
    const table = el('div', { class: 'slot-table' }, el('strong', {}, 'Slot'), el('strong', {}, 'Role'), el('strong', {}, 'Collar #'));
    for (const [id, s] of Object.entries(t.slots)) {
      const role = el('select', {}, ['center', 'left', 'right'].map((r) => el('option', { value: r, selected: r === s.role }, r)));
      role.addEventListener('change', () => { pushUndo(); s.role = role.value; changed(); });
      const col = el('select', {}, [['', '—'], ['0', '1 (left)'], ['1', '2 (center)'], ['2', '3 (right)']].map(([v, lab]) => el('option', { value: v, selected: String(s.collar ?? '') === v }, lab)));
      col.addEventListener('change', () => { pushUndo(); if (col.value === '') delete s.collar; else s.collar = Number(col.value); changed(); });
      table.append(el('span', {}, s.label), role, col);
    }
    kids.push(table);
    kids.push(el('button', {
      onclick: () => {
        const id = prompt('Slot id (e.g. collar2)');
        if (!id || t.slots[id]) return;
        pushUndo(); t.slots[id] = { label: id, role: 'center' }; changed({ structure: true });
      },
    }, '+ Add slot'));
    return el('div', { class: 'props' }, kids);
  }

  function deleteLayer() {
    if (!layer()) return;
    pushUndo();
    ed.tpl.layers.splice(ed.sel, 1);
    ed.sel = Math.min(ed.sel, ed.tpl.layers.length - 1);
    changed({ structure: true });
  }

  /* ---------------- tools / help ---------------- */
  function setTool(tool) {
    ed.tool = tool;
    ed.pendingTop = null;
    $$('#edToolSeg button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $('#edStage').classList.toggle('tool-add', tool === 'add');
    help();
    drawOverlay();
  }

  function help() {
    const l = layer();
    let msg;
    if (ed.tool === 'add' && l && l.type === 'strap') {
      msg = ed.pendingTop ? 'Now click the <b>other edge</b> of the webbing to finish this rung.'
        : 'Click the <b>pattern-top edge</b> of the webbing, then the opposite edge. Rungs every ~60–100px along the strap.';
    } else if (ed.tool === 'add' && l && (l.type === 'hardware' || l.type === 'keep')) {
      msg = 'Click around the metal outline. Points insert into the nearest edge. Use “Add hole” for the inside of rings.';
    } else {
      msg = 'Drag handles to adjust · <kbd>Shift</kbd>+drag a shape to move it · <kbd>Alt</kbd>+click a handle to delete it · <kbd>Ctrl</kbd>+wheel to zoom · <kbd>A</kbd> add points · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo';
    }
    $('#edHelp').innerHTML = msg;
  }

  /* ---------------- wiring ---------------- */
  function init() {
    const sel = $('#edTemplate');
    sel.replaceChildren(...S.state.templateList.map((t) => el('option', { value: t.id }, t.name)));
    sel.addEventListener('change', () => open(sel.value));
    $$('#edModeSeg button').forEach((b) => b.addEventListener('click', () => {
      ed.mode = b.dataset.mode;
      $$('#edModeSeg button').forEach((x) => x.classList.toggle('active', x === b));
      drawOverlay();
      renderPreview();
    }));
    $$('#edToolSeg button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $$('[data-add]').forEach((b) => b.addEventListener('click', () => newLayer(b.dataset.add)));
    $('#edOverlay').addEventListener('change', (e) => { ed.overlay = e.target.checked; drawOverlay(); });
    $('#zoomIn').addEventListener('click', () => zoomBy(1.25));
    $('#zoomOut').addEventListener('click', () => zoomBy(0.8));
    $('#zoomFit').addEventListener('click', fitZoom);
    $('#edSave').addEventListener('click', save);
    $('#edUndo').addEventListener('click', undo);
    $('#edRevert').addEventListener('click', () => { if (confirm('Revert to the last saved template?')) { ed.tpl = JSON.parse(ed.saved); ed.sel = -1; changed({ structure: true }); } });

    const svg = $('#edOverlaySvg');
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    $('#edScroller').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });
    // middle-button pan
    let pan = null;
    $('#edScroller').addEventListener('pointerdown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      pan = { x: e.clientX, y: e.clientY, sl: e.currentTarget.scrollLeft, st: e.currentTarget.scrollTop };
    });
    window.addEventListener('pointermove', (e) => {
      if (!pan) return;
      const sc = $('#edScroller');
      sc.scrollLeft = pan.sl - (e.clientX - pan.x); sc.scrollTop = pan.st - (e.clientY - pan.y);
    });
    window.addEventListener('pointerup', () => { pan = null; });

    document.addEventListener('keydown', (e) => {
      if (S.state.view !== 'editor') return;
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'a' || e.key === 'A') setTool('add');
      else if (e.key === 'v' || e.key === 'V' || e.key === 'Escape') setTool('select');
      else if (e.key === 'h' || e.key === 'H') { ed.overlay = !ed.overlay; $('#edOverlay').checked = ed.overlay; drawOverlay(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && layer()) { e.preventDefault(); if (confirm(`Delete layer ${layer().id}?`)) deleteLayer(); }
      else if (e.key === '0') fitZoom();
    });
    window.addEventListener('beforeunload', (e) => { if (ed.tpl && dirty()) { e.preventDefault(); e.returnValue = ''; } });
    help();
  }

  S.on((evt) => {
    if (evt === 'ready') { init(); ed.ready = true; }
    if (evt === 'view' && S.state.view === 'editor' && ed.ready) {
      if (!ed.tpl) open(S.state.templateList[0].id);
      else { applyZoom(); renderPreview(); }
    }
    if (evt === 'decision' && S.state.view === 'editor') renderPreview();
  });
})();
