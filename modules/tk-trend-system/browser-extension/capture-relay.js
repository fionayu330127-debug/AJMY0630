window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.source !== 'ajmy-tk-trend-capture') return;
  chrome.runtime.sendMessage({
    action: 'captured-request',
    url: event.data.url,
    body: event.data.body,
    headers: event.data.headers,
  });
});
