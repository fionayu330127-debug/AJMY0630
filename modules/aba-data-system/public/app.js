const frame = document.getElementById('abaFrame');
const loading = document.getElementById('abaLoading');
let styleObserver = null;
const embedCss = `
body > .flex.h-screen > aside { display: none !important; }
body > .flex.h-screen > main {
  width: 100% !important;
  flex: 1 1 100% !important;
}
nav[aria-label="pagination"] {
  display: flex !important;
  width: auto !important;
  align-items: center !important;
  margin: 0 !important;
}
nav[aria-label="pagination"] ul {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 4px !important;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none !important;
}
nav[aria-label="pagination"] li {
  display: block !important;
  margin: 0 !important;
  list-style: none !important;
}
nav[aria-label="pagination"] a {
  display: inline-flex !important;
  min-width: 32px !important;
  height: 32px !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 8px !important;
  border-radius: 6px !important;
  text-decoration: none !important;
}
div:has(> nav[aria-label="pagination"]) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: flex-end !important;
  gap: 12px !important;
  white-space: nowrap !important;
}
`;

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
    style.textContent = `${cssText}\n${embedCss}`;
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
