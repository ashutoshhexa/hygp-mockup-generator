'use strict';

const { STOREFRONT_API_BASE_URL: baseUrl } = require('./catalog');

function productImagesApi() {
  return {
    baseUrl,
    async saveDogCollarMetal(productId, files) {
      const form = new FormData();
      for (const { name, data } of files) form.append('dog_collar.metal', new Blob([data], { type: 'image/webp' }), name);
      form.append('mode', 'append');
      const res = await fetch(`${baseUrl}/api/product-images/${encodeURIComponent(productId)}`, {
        method: 'PUT', body: form, redirect: 'error', signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const error = new Error(`Product images API PUT for ${productId} returned HTTP ${res.status}.`);
        error.rejectedBeforeUpload = [401, 403, 404, 405, 413, 415, 429].includes(res.status);
        throw error;
      }
      const result = await res.json();
      const images = result?.data?.images?.dog_collar?.metal;
      if (result?.success !== true || !Array.isArray(images) || images.length < files.length) {
        throw new Error(`Product images API did not confirm all ${files.length} metal collar images for ${productId}.`);
      }
    },
  };
}

module.exports = { productImagesApi };
