'use strict';

const { STOREFRONT_API_BASE_URL: baseUrl } = require('./catalog');

function productImagesApi() {
  async function request(route, method, body, headers = {}) {
    const res = await fetch(`${baseUrl}/api/product-images${route}`, {
      method, body, headers,
      redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const error = new Error(`Product images API ${method} ${route} returned HTTP ${res.status}.`);
      error.rejectedBeforeUpload = [401, 403, 404, 405, 413, 415, 429].includes(res.status);
      throw error;
    }
    const result = await res.json();
    if (result.success !== true) throw new Error(`Product images API ${method} ${route} did not confirm success.`);
    return result.data;
  }

  return {
    baseUrl,
    async upload(files, alt) {
      const form = new FormData();
      for (const { name, data } of files) form.append('files', new Blob([data], { type: 'image/webp' }), name);
      form.append('alt', alt);
      return request('/upload-media', 'POST', form);
    },
    async appendDogCollar(productId, ids) {
      await request(`/${encodeURIComponent(productId)}`, 'PUT',
        JSON.stringify({ mode: 'append', mediaIds: { dog_collar: ids } }),
        { 'Content-Type': 'application/json' });
    },
  };
}

module.exports = { productImagesApi };
