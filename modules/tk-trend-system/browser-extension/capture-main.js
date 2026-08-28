(() => {
  if (window.__ajmyTkTrendCapture) return;
  window.__ajmyTkTrendCapture = true;
  const originalFetch = window.fetch;
  const endpoint = /\/api\/v1\/pop\/product_growth\/top_selling\/product\/(overall|live|video|prod_card|content|new)/;

  window.fetch = function(input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const body = init.body;
      if (endpoint.test(String(url || '')) && typeof body === 'string') {
        window.postMessage({
          source: 'ajmy-tk-trend-capture',
          url: new URL(url, location.href).href,
          body,
          headers: { 'Content-Type': 'application/json' },
        }, location.origin);
      }
    } catch {}
    return originalFetch.apply(this, arguments);
  };
})();
