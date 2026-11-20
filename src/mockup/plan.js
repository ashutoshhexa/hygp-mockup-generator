/*
 * Turns a listing decision (the JSON the model is allowed to return) into
 * per-frame render instructions. Shared by the browser UI, the server export
 * and the CLI so all three place colours and names identically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MockupPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FINISHES = ['gold', 'rosegold', 'silver'];
  const FINISH_LABELS = { gold: 'Gold', rosegold: 'Rose gold', silver: 'Silver' };

  // center = the finish the model thinks sells best; sides keep a fixed order
  function assignFinishes(centerColor, sideOrder) {
    const order = sideOrder || FINISHES;
    const rest = order.filter((f) => f !== centerColor);
    return { center: centerColor, left: rest[0], right: rest[1] };
  }

  // Where a lifestyle scene is drawn behind the fixed collar. The scene first covers the frame,
  // is then enlarged by `scale` (>= 1), and the scene point (x, y) (0-1 of the scene image) is
  // put at the frame centre, slid back only as far as needed to keep the frame covered.
  function placeScene(imgW, imgH, W, H, placement) {
    const p = placement || {};
    const s = Math.max(W / imgW, H / imgH) * Math.max(1, p.scale || 1);
    const dw = imgW * s, dh = imgH * s;
    const fx = p.x != null ? p.x : 0.5, fy = p.y != null ? p.y : 0.5;
    const dx = Math.min(0, Math.max(W - dw, W / 2 - fx * dw));
    const dy = Math.min(0, Math.max(H - dh, H / 2 - fy * dh));
    return { dx, dy, dw, dh };
  }

  function backgroundSpec(frame, listing, template) {
    if (frame.background === 'photo') return null;
    if (frame.background && typeof frame.background === 'object') return frame.background;
    // 'decision': whatever the listing picked
    // lifestyle scenes (lifestyle/<id>.jpg) keep the collar's shadow but not the studio sweep
    if (listing.backgroundFile) return { kind: 'file', file: listing.backgroundFile, ...(/^lifestyle\//.test(listing.backgroundFile) ? sceneSpec(listing.backgroundFile, template) : {}) };
    if (listing.backgroundPreset === 'photo') return null;
    return { kind: 'preset', preset: listing.backgroundPreset || 'winter-linen' };
  }

  // per-view placement from templates/lifestyle/<template>.json (attached as template.lifestyle)
  function sceneSpec(file, template) {
    const id = file.replace(/^lifestyle\//, '').replace(/\.[^.]+$/, '');
    const placement = template && template.lifestyle && template.lifestyle.scenes && template.lifestyle.scenes[id];
    return placement ? { scene: true, placement } : { scene: true };
  }

  // decision.collarPatternScales = [left, center, right]; empty entries use decision.patternScale
  function patternScaleForCollar(decision, index, template) {
    const list = decision.collarPatternScales || [];
    return list[index] || decision.patternScale || (template && template.patternScale) || 1;
  }

  // decision.collarPatterns = [left, center, right]; empty entries use decision.patternFile
  function patternForCollar(decision, index) {
    const list = decision.collarPatterns || [];
    return list[index] || decision.patternFile;
  }

  function planFrame(frame, template, decision, sideOrder) {
    const listing = decision.listing;
    const roles = assignFinishes(listing.centerColor, sideOrder);
    const finishBySlot = {};
    const collarBySlot = {};
    const patternFileBySlot = {};
    const patternScaleBySlot = {};
    for (const [slotId, slot] of Object.entries(template.slots || {})) {
      finishBySlot[slotId] = roles[slot.role] || roles.center;
      if (slot.collar != null) collarBySlot[slotId] = listing.collars[slot.collar];
      // leash and other non-collar slots follow the center collar's pattern
      patternFileBySlot[slotId] = patternForCollar(decision, slot.collar != null ? slot.collar : 1);
      patternScaleBySlot[slotId] = patternScaleForCollar(decision, slot.collar != null ? slot.collar : 1, template);
    }
    return {
      id: frame.id,
      label: frame.label,
      templateId: frame.template,
      finishBySlot,
      collarBySlot,
      patternFileBySlot,
      background: backgroundSpec(frame, listing, template),
      patternScale: decision.patternScale || template.patternScale || 1,
      patternScaleBySlot,
    };
  }

  return { FINISHES, FINISH_LABELS, assignFinishes, planFrame, backgroundSpec, placeScene, patternForCollar, patternScaleForCollar };
});
