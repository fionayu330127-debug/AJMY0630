const status = document.getElementById('status');
const button = document.getElementById('sync');
const autoEnabled = document.getElementById('autoEnabled');
const autoTime = document.getElementById('autoTime');
const scheduleStatus = document.getElementById('scheduleStatus');
let tabId;
let currentSellerUrl = '';

chrome.storage.local.get(['autoEnabled', 'autoTime', 'lastAutoResult'], data => {
  autoEnabled.checked = Boolean(data.autoEnabled);
  autoTime.value = data.autoTime || '09:00';
  if (data.lastAutoResult) scheduleStatus.textContent = data.lastAutoResult;
});

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const tab = tabs[0];
  tabId = tab?.id;
  currentSellerUrl = tab?.url || '';
  if (!currentSellerUrl.startsWith('https://seller-jp.tiktok.com/')) {
    status.textContent = '请先打开 TikTok Seller 热卖商品榜。'; return;
  }
  installAndReadCapture(tabId).then(captured => {
    if (captured?.url && captured?.body) {
      chrome.runtime.sendMessage({ action: 'register-capture', tabId, ...captured }, result => {
        if (result?.ok) { status.textContent = `已识别：${result.type} 榜单`; button.disabled = false; }
        else status.textContent = '捕获的数据无效，请切换一次榜单。';
      });
    } else status.textContent = '监听已启动。请关闭此窗口，切换一次榜单，再打开扩展。';
  }).catch(error => { status.textContent = `页面监听失败：${error.message}`; });
});

async function installAndReadCapture(targetTabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId }, world: 'MAIN',
    func: () => {
      const storageKey = '__ajmyTkTrendLastRequest';
      const endpoint = /\/api\/v1\/pop\/product_growth\/top_selling\/product\/(overall|live|video|prod_card|content|new)/;
      if (!window.__ajmyTkTrendPopupCapture) {
        window.__ajmyTkTrendPopupCapture = true;
        const save = (url, body) => { try { const absoluteUrl = new URL(url, location.href).href; if (endpoint.test(absoluteUrl) && typeof body === 'string') { JSON.parse(body); sessionStorage.setItem(storageKey, JSON.stringify({ url:absoluteUrl, body })); } } catch {} };
        const originalFetch = window.fetch;
        window.fetch = function(input, init={}) { save(typeof input==='string'?input:input?.url, init?.body); return originalFetch.apply(this, arguments); };
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method,url) { this.__ajmyTrendUrl=url; return originalOpen.apply(this,arguments); };
        XMLHttpRequest.prototype.send = function(body) { save(this.__ajmyTrendUrl,body); return originalSend.apply(this,arguments); };
      }
      try { return JSON.parse(sessionStorage.getItem(storageKey)||'null'); } catch { return null; }
    },
  });
  return result;
}

button.onclick = () => {
  button.disabled=true; status.textContent='正在逐页同步，请不要关闭页面...';
  chrome.runtime.sendMessage({action:'sync',tabId}, result => {
    if(result?.ok&&result.downloaded) status.textContent=`已获取 ${result.pages} 页，完整 JSON 已下载，请到 TK trend 页面导入。`;
    else if(result?.ok) status.textContent=`完成：${result.pages} 页，导入 ${result.imported} 条`;
    else {status.textContent=`失败：${result?.error||'未知错误'}`;button.disabled=false;}
  });
};

document.getElementById('saveSchedule').onclick = () => {
  if(autoEnabled.checked&&!currentSellerUrl.startsWith('https://seller-jp.tiktok.com/')) {scheduleStatus.textContent='请在 TikTok Seller 热卖榜页面保存设置。';return;}
  chrome.runtime.sendMessage({action:'save-schedule',enabled:autoEnabled.checked,time:autoTime.value,sellerUrl:currentSellerUrl.startsWith('https://seller-jp.tiktok.com/')?currentSellerUrl:undefined}, result => {
    scheduleStatus.textContent=result?.ok?(autoEnabled.checked?`已保存，每天 ${autoTime.value} 执行`:'已关闭自动同步'):`保存失败：${result?.error||'未知错误'}`;
  });
};
