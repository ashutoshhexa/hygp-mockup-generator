/* Runs MockupCore off the main thread. Assets are sent once and cached by key. */
self.importScripts('/mockup/core.js');

const cache = new Map();

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'asset') {
    cache.set(msg.key, { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) });
    return;
  }
  if (msg.type === 'bin') {
    cache.set(msg.key, new Uint8Array(msg.buffer));
    return;
  }
  if (msg.type === 'drop') {
    for (const key of msg.keys) cache.delete(key);
    return;
  }
  if (msg.type === 'render') {
    const t0 = performance.now();
    try {
      const get = (key) => {
        if (!key) return null;
        const a = cache.get(key);
        if (!a) throw new Error(`Asset not loaded: ${key}`);
        return a;
      };
      const patternBySlot = {};
      for (const [slot, key] of Object.entries(msg.patternKeys || {})) patternBySlot[slot] = get(key);
      const engravingBySlot = {};
      for (const [slot, key] of Object.entries(msg.engravingKeys || {})) engravingBySlot[slot] = get(key);
      const out = self.MockupCore.render({
        template: msg.template,
        base: get(msg.baseKey),
        below: get(msg.belowKey),
        layerData: get(msg.binKey),
        pattern: get(msg.patternKey),
        patternBySlot,
        background: get(msg.bgKey),
        finishBySlot: msg.finishBySlot,
        engravingBySlot,
        mode: msg.mode,
        patternScale: msg.patternScale,
      });
      self.postMessage({ id: msg.id, width: out.width, height: out.height, buffer: out.data.buffer, ms: performance.now() - t0 }, [out.data.buffer]);
    } catch (err) {
      self.postMessage({ id: msg.id, error: err.message || String(err) });
    }
  }
};
