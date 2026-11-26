/* WebP download helper: encode a canvas under 50 KB at a useful web resolution. */
(() => {
  'use strict';

  const MAX_BYTES = 50 * 1024;
  const START_EDGE = 1800; // sharp on the web; full 3000 px rarely fits under 50 KB
  const MIN_EDGE = 960;

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), type, quality);
    });
  }

  function sizedCanvas(src, width, height) {
    if (src.width === width && src.height === height) return src;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, width, height);
    return out;
  }

  /** { blob, canvas, q } — largest practical size under maxBytes. */
  async function encodeUnder(src, maxBytes = MAX_BYTES) {
    let edge = Math.min(Math.max(src.width, src.height), START_EDGE);
    let last = null;
    for (;;) {
      const s = edge / Math.max(src.width, src.height);
      const w = Math.max(1, Math.round(src.width * s));
      const h = Math.max(1, Math.round(src.height * s));
      const canvas = sizedCanvas(src, w, h);
      let lo = 0.42;
      let hi = 0.9;
      let best = null;
      for (let i = 0; i < 8; i++) {
        const q = (lo + hi) / 2;
        const blob = await canvasBlob(canvas, 'image/webp', q);
        last = { blob, canvas, q };
        if (blob.size <= maxBytes) { best = last; lo = q; }
        else hi = q;
      }
      if (best) return best;
      if (edge <= MIN_EDGE) return last;
      edge = Math.max(MIN_EDGE, Math.round(edge * 0.88));
    }
  }

  function formatBytes(n) {
    return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
  }

  window.DownloadWebp = { encodeUnder, formatBytes, MAX_BYTES };
})();
