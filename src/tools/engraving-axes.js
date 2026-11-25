'use strict';

/**
 * Text axes of an engraving slot on the photo, and the rule every slot has to meet.
 *
 * A slot maps the engraving image (content px: u to the right along the text, v down from the
 * name to the phone line) onto the buckle plate in the photo. Two directions on the photo
 * decide how the text looks there:
 *   reading - where +u goes: the direction the name reads in
 *   lines   - where +v goes: the direction from the name down to the phone number
 * Their angles are in degrees on the photo (x right, y down, so positive is clockwise; 0 means
 * the text reads straight to the right). The pair is mirrored when lines is anticlockwise of
 * reading instead of clockwise.
 *
 * The plate in the photo can be tilted (the top collar of "Two collars, angled" is about 27
 * degrees), but text that reads sideways, upside down or mirrored is always wrong.
 */
const MAX_TILT = 60;

/** Axes from a slot mapper's forward map (content u,v -> photo x,y). */
function axesFromMapper(forward, cw, ch) {
  const [x0, y0] = forward(cw * 0.25, ch / 2), [x1, y1] = forward(cw * 0.75, ch / 2);
  const [x2, y2] = forward(cw / 2, ch * 0.25), [x3, y3] = forward(cw / 2, ch * 0.75);
  return axes([x1 - x0, y1 - y0], [x3 - x2, y3 - y2]);
}

/**
 * Axes from a baked slot: per-pixel content (u, v) over the slot's pixels. A least-squares
 * plane u = a*x + b*y + c (and v likewise) gives the Jacobian; its inverse holds the photo
 * directions of +u and +v.
 */
function axesFromUV(points) {
  // points: [{x, y, u, v}]
  let n = 0, sx = 0, sy = 0, su = 0, sv = 0, sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
  for (const p of points) {
    n++; sx += p.x; sy += p.y; su += p.u; sv += p.v;
    sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
    sxu += p.x * p.u; syu += p.y * p.u; sxv += p.x * p.v; syv += p.y * p.v;
  }
  const cxx = sxx - (sx * sx) / n, cxy = sxy - (sx * sy) / n, cyy = syy - (sy * sy) / n;
  const cxu = sxu - (sx * su) / n, cyu = syu - (sy * su) / n, cxv = sxv - (sx * sv) / n, cyv = syv - (sy * sv) / n;
  const det = cxx * cyy - cxy * cxy;
  const a = (cxu * cyy - cyu * cxy) / det, b = (cyu * cxx - cxu * cxy) / det; // du/dx, du/dy
  const d = (cxv * cyy - cyv * cxy) / det, e = (cyv * cxx - cxv * cxy) / det; // dv/dx, dv/dy
  const j = a * e - b * d;
  return axes([e / j, -d / j], [-b / j, a / j]);
}

function axes(reading, lines) {
  const deg = (v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const cross = reading[0] * lines[1] - reading[1] * lines[0];
  return { reading: deg(reading), lines: deg(lines), mirrored: cross < 0 };
}

/** Problems with a slot's axes, as text; empty when the text reads correctly. */
function axesProblems(ax) {
  const out = [];
  if (ax.mirrored) out.push('mirrored');
  if (Math.abs(ax.reading) > 120) out.push(`upside down (reads at ${ax.reading.toFixed(0)} deg)`);
  else if (Math.abs(ax.reading) > MAX_TILT) out.push(`sideways (reads at ${ax.reading.toFixed(0)} deg)`);
  return out;
}

module.exports = { axesFromMapper, axesFromUV, axesProblems, MAX_TILT };
