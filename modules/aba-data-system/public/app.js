const frame = document.getElementById('abaFrame');
const loading = document.getElementById('abaLoading');
let styleObserver = null;

async function preserveAbaStyles() {
  const doc = frame.contentDocument;
  if (!doc?.head) return;

  let cssText = doc.querySelector('[data-aba-proxy-css]')?.textContent || '';
  if (!cssText) {
    const stylesheet = doc.querySelector('link[rel="stylesheet"][href*="/_next/static/css/"]');
    if (stylesheet) {
      const response = await fetch(stylesheet.href, { cache: 'no-store' });
      if (response.ok) cssText = await response.text();
    }
  }
  if (!cssText) return;

  const ensureStyle = () => {
    if (doc.getElementById('aba-persistent-styles')) return;
    const style = doc.createElement('style');
    style.id = 'aba-persistent-styles';
    style.textContent = cssText;
    doc.head.appendChild(style);
  };

  styleObserver?.disconnect();
  styleObserver = new MutationObserver(ensureStyle);
  styleObserver.observe(doc.head, { childList: true });
  ensureStyle();
}

frame.addEventListener('load', async () => {
  await preserveAbaStyles();
  loading.classList.add('is-hidden');
});
