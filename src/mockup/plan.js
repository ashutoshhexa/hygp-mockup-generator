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

  function backgroundSpec(frame, listing) {
    if (frame.background === 'photo') return null;
    if (frame.background && typeof frame.background === 'object') return frame.background;
    // 'decision': whatever the listing picked
    if (listing.backgroundFile) return { kind: 'file', file: listing.backgroundFile };
    if (listing.backgroundPreset === 'photo') return null;
    return { kind: 'preset', preset: listing.backgroundPreset || 'winter-linen' };
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
    for (const [slotId, slot] of Object.entries(template.slots || {})) {
      finishBySlot[slotId] = roles[slot.role] || roles.center;
      if (slot.collar != null) collarBySlot[slotId] = listing.collars[slot.collar];
      // leash and other non-collar slots follow the center collar's pattern
      patternFileBySlot[slotId] = patternForCollar(decision, slot.collar != null ? slot.collar : 1);
    }
    return {
      id: frame.id,
      label: frame.label,
      templateId: frame.template,
      finishBySlot,
      collarBySlot,
      patternFileBySlot,
      background: backgroundSpec(frame, listing),
      patternScale: decision.patternScale || template.patternScale || 1,
    };
  }

  return { FINISHES, FINISH_LABELS, assignFinishes, planFrame, backgroundSpec, patternForCollar };
});
