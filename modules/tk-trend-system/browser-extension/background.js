const requests = new Map();
const endpointPattern = /\/api\/v1\/pop\/product_growth\/top_selling\/product\/(overall|live|video|prod_card|content|new)/;
const pendingHeaders = new Map();
let automaticRun = null;

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'tk-trend-daily-sync') startAutomaticRun();
});

chrome.runtime.onStartup.addListener(() => restoreSchedule());
chrome.runtime.onInstalled.addListener(() => restoreSchedule());

chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (!endpointPattern.test(details.url)) return;
    const allowed = new Set(['content-type', 'accept', 'tt-csrf-token', 'x-secsdk-csrf-token', 'x-tt-env']);
    const headers = {};
    for (const item of details.requestHeaders || []) {
      if (allowed.has(item.name.toLowerCase()) && item.value) headers[item.name] = item.value;
    }
    pendingHeaders.set(details.requestId, headers);
    const captured = requests.get(details.tabId);
    if (captured?.requestId === details.requestId) requests.set(details.tabId, { ...captured, headers });
  },
  { urls: ['https://seller-jp.tiktok.com/api/v1/pop/product_growth/top_selling/product/*'] },
  ['requestHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    const match = details.url.match(endpointPattern);
    if (!match || !details.tabId || !details.requestBody?.raw?.[0]?.bytes) return;
    try {
      const body = new TextDecoder().decode(details.requestBody.raw[0].bytes);
      JSON.parse(body);
      requests.set(details.tabId, {
        url: details.url, body, type: match[1], capturedAt: Date.now(),
        requestId: details.requestId,
        headers: pendingHeaders.get(details.requestId) || { 'Content-Type': 'application/json' },
      });
      continueAutomaticRun(details.tabId);
    } catch {}
  },
  { urls: ['https://seller-jp.tiktok.com/api/v1/pop/product_growth/top_selling/product/*'] },
  ['requestBody']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'save-schedule') {
    saveSchedule(message).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.action === 'register-capture' && message.tabId) {
    const match = String(message.url || '').match(endpointPattern);
    try {
      if (match && message.body) {
        JSON.parse(message.body);
        requests.set(message.tabId, {
          url: message.url, body: message.body, type: match[1], capturedAt: Date.now(),
          headers: { 'Content-Type': 'application/json' },
        });
        continueAutomaticRun(message.tabId);
        sendResponse({ ok: true, type: match[1] });
      } else sendResponse({ ok: false });
    } catch { sendResponse({ ok: false }); }
    return;
  }
  if (message.action === 'captured-request' && sender.tab?.id) {
    const match = String(message.url || '').match(endpointPattern);
    try {
      if (match && message.body) {
        JSON.parse(message.body);
        requests.set(sender.tab.id, {
          url: message.url, body: message.body, type: match[1], capturedAt: Date.now(),
          headers: message.headers || { 'Content-Type': 'application/json' },
        });
        continueAutomaticRun(sender.tab.id);
      }
    } catch {}
    sendResponse({ ok: true });
    return;
  }
  if (message.action === 'status') {
    const captured = requests.get(message.tabId);
    sendResponse(captured ? { ok: true, type: captured.type, capturedAt: captured.capturedAt } : { ok: false });
    return;
  }
  if (message.action !== 'sync') return;
  const captured = requests.get(message.tabId);
  if (!captured) { sendResponse({ ok: false, error: '尚未捕获榜单请求，请刷新榜单页面。' }); return; }
  syncAll(message.tabId, captured).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function syncAll(tabId, captured) {
  const payload = JSON.parse(captured.body);
  let first;
  try { first = await requestPage(tabId, captured.url, captured.headers, payload, 1); }
  catch (error) { throw new Error(`TikTok 第 1 页获取失败：${error.message}`); }
  const pagination = first.data?.pagination;
  if (!Array.isArray(first.data?.rows)) throw new Error(first.message || 'TikTok 返回内容中没有榜单数据');
  const pageSize = Number(pagination?.page_size || payload.pagination?.page_size || 10);
  const total = Number(pagination?.total_count || first.data.rows.length);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pages = [first];
  for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
    try { pages.push(await requestPage(tabId, captured.url, captured.headers, payload, pageNo)); }
    catch (error) { throw new Error(`TikTok 第 ${pageNo} 页获取失败：${error.message}`); }
  }
  const selector = payload.time_selector || {};
  const importPayload = {
    pages,
    rankingType: captured.type,
    beginTime: selector.begin_time || 0,
    endTime: selector.end_time || 0,
    categoryKey: JSON.stringify(payload.filter?.lv1_cate_ids || []),
  };
  let response;
  let connectionError;
  for (const origin of ['http://127.0.0.1:3111', 'http://localhost:3111']) {
    try {
      response = await fetch(`${origin}/tk-trend/api/import-pages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(importPayload),
      });
      break;
    } catch (error) { connectionError = error; }
  }
  if (!response) {
    const json = JSON.stringify({ format: 'ajmy-tk-trend-pages-v1', ...importPayload });
    const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    const filename = `tk-trend-${captured.type}-all-pages-${new Date().toISOString().slice(0, 10)}.json`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: !automaticRun });
    return { ok: true, type: captured.type, imported: 0, total, pages: pages.length, downloaded: true, filename };
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本地导入失败');
  return { ok: true, type: captured.type, ...result };
}

async function saveSchedule(message) {
  const enabled = Boolean(message.enabled);
  const time = /^\d{2}:\d{2}$/.test(message.time || '') ? message.time : '09:00';
  const current = await chrome.storage.local.get(['sellerUrl']);
  const sellerUrl = message.sellerUrl || current.sellerUrl;
  if (enabled && !sellerUrl) throw new Error('请在 TikTok Seller 热卖榜页面保存设置');
  await chrome.storage.local.set({ autoEnabled: enabled, autoTime: time, sellerUrl });
  await chrome.alarms.clear('tk-trend-daily-sync');
  if (enabled) await createDailyAlarm(time);
  return { ok: true };
}

async function restoreSchedule() {
  const settings = await chrome.storage.local.get(['autoEnabled', 'autoTime']);
  if (settings.autoEnabled) await createDailyAlarm(settings.autoTime || '09:00');
}

async function createDailyAlarm(time) {
  const [hour, minute] = time.split(':').map(Number);
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('tk-trend-daily-sync', { when: next.getTime(), periodInMinutes: 1440 });
}

async function startAutomaticRun() {
  if (automaticRun) return;
  const settings = await chrome.storage.local.get(['autoEnabled', 'sellerUrl']);
  if (!settings.autoEnabled || !settings.sellerUrl) return;
  const tab = await chrome.tabs.create({ url: settings.sellerUrl, active: false });
  automaticRun = { tabId: tab.id, startedAt: Date.now() };
  setTimeout(() => {
    if (automaticRun?.tabId === tab.id) finishAutomaticRun(false, '自动同步超时，请检查 TikTok 是否需要重新登录');
  }, 90000);
}

async function continueAutomaticRun(tabId) {
  if (!automaticRun || automaticRun.tabId !== tabId || automaticRun.syncing) return;
  const captured = requests.get(tabId);
  if (!captured) return;
  automaticRun.syncing = true;
  try {
    const result = await syncAll(tabId, captured);
    const text = result.downloaded
      ? `已获取 ${result.pages} 页并下载数据文件，本机连接仍被 HubStudio 阻止`
      : `自动同步完成：${result.pages} 页，${result.imported} 条`;
    await finishAutomaticRun(true, text);
  } catch (error) { await finishAutomaticRun(false, `自动同步失败：${error.message}`); }
}

async function finishAutomaticRun(success, message) {
  const run = automaticRun;
  automaticRun = null;
  await chrome.storage.local.set({ lastAutoResult: `${new Date().toLocaleString()} ${message}` });
  try {
    await chrome.notifications.create({
      type: 'basic', iconUrl: 'icon128.png', title: success ? 'TK trend 自动同步完成' : 'TK trend 需要处理', message,
    });
  } catch {}
  if (run?.tabId) try { await chrome.tabs.remove(run.tabId); } catch {}
}

async function requestPage(tabId, url, originalHeaders, originalPayload, pageNo) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (requestUrl, requestHeaders, payload, nextPage) => {
      const body = structuredClone(payload);
      body.pagination = { ...(body.pagination || {}), page_no: nextPage };
      const response = await fetch(requestUrl, {
        method: 'POST', credentials: 'include', headers: requestHeaders, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`第 ${nextPage} 页请求失败 (${response.status})`);
      return response.json();
    },
    args: [url, originalHeaders, originalPayload, pageNo],
  });
  if (!result) throw new Error(`第 ${pageNo} 页没有返回数据`);
  return result;
}
