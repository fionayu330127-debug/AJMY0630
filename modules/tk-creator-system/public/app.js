// app.js — 前端逻辑，所有数据来自后端 API（/api/...），不再使用假数据

// ════ STATE ════
let SHOPS = [];
let BD_LIST = [];
let PRODUCTS = [];
let curStore = 'oku';
let curPage = 'invite';
let curTab = 'all';
let sSearch = '';
let sType = '';
let samplePage = 1;
let samplePageSize = 20;
let lSearch = '';
let lStar = '';
let lBD = '';
let lSort = 'latest_desc';
let libPage = 1;
let libPageSize = 20;
let lOrderRange = '90d';
let lOrderMonth = new Date().toISOString().slice(0, 7);
let assignTgt = null;
let collabTgt = null;
let sampleStats = { total: 0, byStatus: {}, assignedBD: 0 };
let AGENT_SETTINGS = null;
let INVITE_SOURCE = 'shop_pool';
let INVITE_CANDIDATES = [];
let INVITE_SELECTED = new Set();
let INVITE_IMPORTED = [];
let INVITE_TEMPLATES = [];
let INVITE_PRODUCTS = [];
let INVITE_PRODUCT_SELECTED = new Set();
let INVITE_PRODUCT_SHOP = '';
let AGENT_WORKFLOW = null;
let AGENT_WORKFLOWS = [];
let automationPage = 1;
let automationPageSize = 10;
let selectedWorkflowId = null;
let editingWorkflowId = null;
let PRODUCT_PICKER_CONTEXT = 'invite';
let WORKFLOW_PRODUCT_SELECTED = new Set();
let WORKFLOW_PRODUCT_SHOP = '';
let WORKFLOW_BD_SELECTED = new Set();
let inviteFilterTimer = null;

// ════ API HELPERS ════
async function api(path, opts = {}) {
  if (path.startsWith('/api/')) path = '/tk' + path;
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `请求失败 (${res.status})`);
  }
  return res.json();
}

// ════ HELPERS ════
function avatarSVG(seed, sz = 36) {
  seed = String(seed || '?');
  const cols = ['#fe2c55', '#0958d9', '#722ed1', '#d46b08', '#52c41a', '#08979c', '#eb2f96'];
  const chars = Array.from(seed);
  const c = cols[chars.reduce((a, x) => a + x.codePointAt(0), 0) % cols.length];
  const l = (chars[0] || '?').toUpperCase();
  const fallback = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}"><rect width="${sz}" height="${sz}" rx="${sz / 2}" fill="#95a3b8"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="white" font-size="${Math.round(sz * .4)}" font-family="sans-serif">?</text></svg>`;
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}"><rect width="${sz}" height="${sz}" rx="${sz / 2}" fill="${c}"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="white" font-size="${Math.round(sz * .4)}" font-family="sans-serif">${esc(l)}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  } catch (_) {
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(fallback)}`;
  }
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function jsStr(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}
function avatarUrl(entity, size = 36) {
  return entity?.creator_avatar_url || entity?.avatar_url || avatarSVG(entity?.creator_name || entity?.name || entity?.bd_name || '?', size);
}
function productThumbHtml(entity, size = 34) {
  const url = entity?.product_image_url || entity?.image_url;
  const emoji = entity?.product_emoji || entity?.emoji || '样';
  const fallback = `<div class="pe" style="width:${size}px;height:${size}px">${esc(emoji)}</div>`;
  if (url) return `<img src="${esc(url)}" class="product-thumb" style="width:${size}px;height:${size}px" data-fallback="${esc(emoji)}" onerror="productImageFallback(this, ${size})">`;
  return fallback;
}
function productImageFallback(img, size = 34) {
  const div = document.createElement('div');
  div.className = 'pe';
  div.style.width = `${size}px`;
  div.style.height = `${size}px`;
  div.textContent = img?.dataset?.fallback || '样';
  img.replaceWith(div);
}
function fmtF(n) { n = n || 0; if (n >= 10000000) return (n / 10000000).toFixed(1) + '千万'; if (n >= 10000) return (n / 10000).toFixed(1) + '万'; return String(n); }
function fmtPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '-';
}
function fmtMoney(amount, currency = 'JPY') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  const symbol = currency === 'JPY' ? '¥' : `${currency || ''} `;
  return `${symbol}${Math.round(n).toLocaleString()}`;
}
function fmtCommission(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return `${(n <= 1 ? n * 100 : n).toFixed(0)}%`;
}
function paginate(list, page, pageSize) {
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), total, totalPages, page: safePage, pageSize };
}
function pagerHtml(kind, meta) {
  const start = meta.total ? (meta.page - 1) * meta.pageSize + 1 : 0;
  const end = Math.min(meta.total, meta.page * meta.pageSize);
  const sizes = [20, 50, 100].map(size => `<option value="${size}" ${meta.pageSize === size ? 'selected' : ''}>每页 ${size}</option>`).join('');
  return `
    <div class="pager-row">
      <div class="pager-info">共 ${meta.total} 条，显示 ${start}-${end}</div>
      <div class="pager-ctrls">
        <select class="fi" onchange="setPageSize('${kind}', this.value)">${sizes}</select>
        <button class="btn btn-outline" ${meta.page <= 1 ? 'disabled' : ''} onclick="setPage('${kind}', 1)">首页</button>
        <button class="btn btn-outline" ${meta.page <= 1 ? 'disabled' : ''} onclick="setPage('${kind}', ${meta.page - 1})">上一页</button>
        <span class="pager-page">第 ${meta.page} / ${meta.totalPages} 页</span>
        <button class="btn btn-outline" ${meta.page >= meta.totalPages ? 'disabled' : ''} onclick="setPage('${kind}', ${meta.page + 1})">下一页</button>
        <button class="btn btn-outline" ${meta.page >= meta.totalPages ? 'disabled' : ''} onclick="setPage('${kind}', ${meta.totalPages})">末页</button>
      </div>
    </div>`;
}
function setPage(kind, page) {
  if (kind === 'sample') { samplePage = Number(page) || 1; renderSampleTable(); }
  if (kind === 'lib') { libPage = Number(page) || 1; renderLibPage(); }
  if (kind === 'automation') { automationPage = Number(page) || 1; renderAutomationCenter(); }
}
function setPageSize(kind, pageSize) {
  const size = Number(pageSize) || 20;
  if (kind === 'sample') { samplePageSize = size; samplePage = 1; renderSampleTable(); }
  if (kind === 'lib') { libPageSize = size; libPage = 1; renderLibPage(); }
  if (kind === 'automation') { automationPageSize = size; automationPage = 1; renderAutomationCenter(); }
}
function remainingDaysText(value) {
  if (!value) return '-';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '-';
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
  if (days < 0) return '已过期';
  return `剩余 ${days} 天`;
}
function collabLabel(v) {
  const raw = String(v || '').trim();
  const s = raw.toLowerCase();
  if (!raw) return '';
  if (s === 'service_provider' || s.includes('service') || s.includes('provider') || s.includes('partner') || raw.includes('服务商')) return '服务商合作';
  if (s === 'open' || s.includes('open') || raw.includes('公开')) return '公开合作';
  if (s === 'targeted' || s.includes('target') || raw.includes('定向')) return '定向合作';
  if (s === 'affiliate' || s.includes('affiliate') || raw.includes('联盟')) return '联盟合作';
  return raw;
}
function shopInfo(id) { return SHOPS.find(s => s.id === id) || { name: id, color: '#999' }; }
function shopTagHtml(shop) {
  const s = shopInfo(shop);
  const cls = shop === 'oku' ? 'st-oku' : (shop === 'mir' ? 'st-mir' : 'st-both');
  return `<span class="shop-tag ${cls}">${s.name}</span>`;
}
function collabTagHtml(ct, id) {
  const label = collabLabel(ct);
  if (label === '公开合作') return '<span class="tag tag-open">公开合作</span>';
  if (label === '服务商合作') return '<span class="tag tag-targeted">服务商合作</span>';
  if (label === '定向合作') return '<span class="tag tag-targeted">定向合作</span>';
  if (label === '联盟合作') return '<span class="tag tag-affiliate">联盟合作</span>';
  if (label) return `<span class="tag tag-open" onclick="openCollabModal(event,'${id}')">${esc(label)}</span>`;
  return `<span class="tag tag-unset" onclick="openCollabModal(event,'${id}')">＋ 标记类型</span>`;
}
function statusBadge(s) {
  const M = { pending: ['s-pending', '待审核'], approved: ['s-approved', '已通过'], rejected: ['s-rejected', '已拒绝'], assigned: ['s-assigned', '已分配'], shipped: ['s-shipped', '已寄出'], published: ['s-published', '已发布'], cancelled: ['s-rejected', '已取消'] };
  const [c, l] = M[s] || ['s-pending', '未知'];
  return `<span class="status ${c}"><span class="sdot"></span>${l}</span>`;
}
function starBadgeHtml(n) {
  const M = { 5: 'sb-5', 4: 'sb-4', 3: 'sb-3', 2: 'sb-2', 1: 'sb-1' };
  return n > 0 ? `<span class="sb ${M[n]}">${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${n}星</span>` : '';
}
function bdColorStyle(id) {
  if (!id) return 'background:#f1f5f9;color:#64748b;border-color:#d8e0ea';
  const palette = [
    ['#e0f2fe', '#075985', '#7dd3fc'],
    ['#dcfce7', '#166534', '#86efac'],
    ['#fef3c7', '#92400e', '#fcd34d'],
    ['#fce7f3', '#9d174d', '#f9a8d4'],
    ['#ede9fe', '#5b21b6', '#c4b5fd'],
    ['#ccfbf1', '#115e59', '#5eead4'],
    ['#fee2e2', '#991b1b', '#fca5a5'],
  ];
  const chars = Array.from(String(id));
  const index = chars.reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % palette.length;
  const [bg, fg, border] = palette[index];
  return `background:${bg};color:${fg};border-color:${border}`;
}
function bdStatSelectHtml(c, uidsAttr) {
  const options = `<option value="">未分配</option>${BD_LIST.map(b => `<option value="${b.id}" ${String(c.bd_id || '') === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}`;
  return `<select class="bd-stat-select" style="${bdColorStyle(c.bd_id)}" onclick="event.stopPropagation()" onchange="saveLibBD('${c.uid}', this.value, '${uidsAttr}', this)">${options}</select>`;
}
function attrJson(value) {
  return esc(JSON.stringify(value || []));
}
function parseAttrJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}
function progressLabel(s) { return { approved: '待安排发货', assigned: 'BD跟进中', shipped: '样品已寄出', published: '视频已发布', pending: '审核中', rejected: '已拒绝', cancelled: '申请已取消' }[s] || ''; }
function sampleRawStatus(s) {
  try {
    const raw = typeof s.raw_json === 'string' ? JSON.parse(s.raw_json) : s.raw_json;
    return raw?.status || raw?.application_status || raw?.sample_status || raw?.request_status || '';
  } catch (_) {
    return '';
  }
}
function sampleExternalMeta(s) {
  const parts = [];
  if (s.external_sample_id) parts.push(`申请ID ${esc(s.external_sample_id)}`);
  if (s.external_product_id) parts.push(`商品ID ${esc(s.external_product_id)}`);
  const rawStatus = sampleRawStatus(s);
  if (rawStatus) parts.push(`TikTok ${esc(rawStatus)}`);
  return parts.length ? `<div class="ps">${parts.join(' · ')}</div>` : '';
}

// ════ INIT LOAD ════
async function loadShopsAndBD() {
  SHOPS = await api('/api/shops');
  BD_LIST = await api('/api/bd');
  renderStoreSwitchers();
  populateBDFilter();
}

function renderStoreSwitchers() {
  const html = (suffix) => `
    ${SHOPS.map(s => `
      <button class="sw-btn ${curStore === s.id ? 'active' : ''}" onclick="switchStore('${s.id}')">
        <div class="sw-dot" style="background:${s.color}"></div>${s.name}
        <span class="sw-cnt" id="scnt-${s.id}${suffix}">-</span>
      </button>`).join('')}
    <button class="sw-btn ${curStore === 'all' ? 'active' : ''}" onclick="switchStore('all')">全部 <span class="sw-cnt" id="scnt-all${suffix}">-</span></button>
  `;
  const targets = [
    ['store-switcher-invite', '-invite'],
    ['store-switcher-sample', ''],
    ['store-switcher-lib', '-lib'],
    ['store-switcher-data', '-data'],
    ['store-switcher-automation', '-automation'],
    ['store-switcher-agent', '-agent'],
  ];
  targets.forEach(([id, suffix]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html(suffix);
  });
  updateStoreCounts();
}

async function updateStoreCounts() {
  const libraryStats = await api('/api/library/stats').catch(() => ({ total: 0, byShop: {} }));
  for (const s of SHOPS) {
    const stats = await api(`/api/samples/stats?shop=${s.id}`);
    ['', '-invite', '-data', '-automation', '-agent'].forEach(suf => {
      const el = document.getElementById(`scnt-${s.id}${suf}`);
      if (el) el.textContent = stats.total;
    });
    const libEl = document.getElementById(`scnt-${s.id}-lib`);
    if (libEl) libEl.textContent = libraryStats.byShop?.[s.id] ?? 0;
  }
  const allSamples = await api('/api/samples/stats?shop=all').catch(() => ({ total: 0 }));
  ['', '-invite', '-data', '-automation', '-agent'].forEach(suf => {
    const el = document.getElementById(`scnt-all${suf}`);
    if (el) el.textContent = allSamples.total;
  });
  const allLib = document.getElementById('scnt-all-lib');
  if (allLib) allLib.textContent = libraryStats.total || 0;
}

// ════ STORE / PAGE SWITCH ════
function switchStore(store) {
  curStore = store;
  INVITE_PRODUCT_SELECTED.clear();
  INVITE_PRODUCT_SHOP = store === 'all' ? (SHOPS[0]?.id || '') : store;
  samplePage = 1;
  libPage = 1;
  renderStoreSwitchers();
  if (curPage === 'invite') renderInviteCenter();
  if (curPage === 'sample') renderSamplePage();
  if (curPage === 'lib') renderLibPage();
  if (curPage === 'data') renderDataCenter();
  if (curPage === 'automation') renderAutomationCenter();
  if (curPage === 'agent') renderAgentCenter();
}

function showPage(page) {
  curPage = page;
  ['invite', 'sample', 'lib', 'data', 'automation', 'agent'].forEach(p => {
    document.getElementById('page-' + p)?.classList.toggle('visible', p === page);
    document.getElementById('nav-' + p)?.classList.toggle('active', p === page);
  });
  if (page === 'invite') renderInviteCenter();
  if (page === 'sample') renderSamplePage();
  if (page === 'lib') renderLibPage();
  if (page === 'data') renderDataCenter();
  if (page === 'automation') {
    selectedWorkflowId = null;
    automationPage = 1;
    renderAutomationCenter();
  }
  if (page === 'agent') renderAgentCenter();
}

// ════ INVITE CENTER ════
async function renderInviteCenter() {
  const box = document.getElementById('invite-kpis');
  if (!box) return;
  const params = curStore !== 'all' ? `?shop=${curStore}` : '?shop=all';
  const [stats, templates, records] = await Promise.all([
    api('/api/samples/stats' + params),
    api('/api/invitations/templates').catch(() => []),
    api('/api/invitations/records' + params).catch(() => []),
  ]);
  INVITE_TEMPLATES = templates;
  const pending = stats.byStatus.pending || 0;
  const active = (stats.byStatus.approved || 0) + (stats.byStatus.assigned || 0) + (stats.byStatus.shipped || 0) + (stats.byStatus.published || 0);
  const sent = records.filter(r => r.status === 'sent').length;
  const waiting = records.filter(r => r.status === 'pending').length;
  box.innerHTML = [
    { title: '候选达人', value: stats.total, meta: '当前店铺范围', tone: 'hl' },
    { title: '待邀约线索', value: pending, meta: '来自店铺后台达人池', tone: '' },
    { title: '合作达人库', value: active, meta: '可复邀和加佣', tone: 'ok' },
    { title: '已发送私信', value: sent, meta: '最近80条记录', tone: 'ok' },
    { title: '待后台私信', value: waiting, meta: '缺少 open_id 或未开启发送', tone: 'warn' },
    { title: '已选择', value: INVITE_SELECTED.size, meta: '本次邀约目标', tone: 'hl' },
  ].map(item => `
    <div class="stat-card invite-stat ${item.tone}">
      <div class="stat-lbl">${item.title}</div>
      <div class="stat-val">${item.value || 0}</div>
      <div class="stat-delta">${item.meta}</div>
    </div>
  `).join('');

  renderInviteSourceTabs();
  renderInviteTemplates();
  await loadInviteProducts();
  onInviteTemplateChange();
  renderInviteRecords(records);
  await loadInviteCandidates();
}

function renderInviteSourceTabs() {
  ['shop_pool', 'library', 'import'].forEach((source) => {
    document.getElementById(`invite-source-${source}`)?.classList.toggle('active', INVITE_SOURCE === source);
  });
  document.getElementById('invite-import-box')?.classList.toggle('show', INVITE_SOURCE === 'import');
}

function renderInviteTemplates() {
  const select = document.getElementById('invite-template-select');
  if (!select) return;
  select.innerHTML = INVITE_TEMPLATES.map(t => `<option value="${t.id}">${t.type === 'collab' ? '合作邀约' : '私信消息'} · ${esc(t.name)}</option>`).join('');
}

async function loadInviteProducts() {
  const shop = INVITE_PRODUCT_SHOP || (curStore === 'all' ? (SHOPS[0]?.id || '') : curStore);
  INVITE_PRODUCT_SHOP = shop;
  INVITE_PRODUCTS = shop ? await api(`/api/products?shop=${shop}`).catch(() => []) : [];
  const available = new Set(INVITE_PRODUCTS.map(p => String(p.id)));
  INVITE_PRODUCT_SELECTED = new Set([...INVITE_PRODUCT_SELECTED].filter(id => available.has(String(id))));
  renderInviteProductSummary();
}

async function setInviteProductShop(shop) {
  if (PRODUCT_PICKER_CONTEXT === 'workflow') {
    WORKFLOW_PRODUCT_SHOP = shop;
    WORKFLOW_PRODUCT_SELECTED.clear();
    INVITE_PRODUCTS = shop ? await api(`/api/products?shop=${shop}`).catch(() => []) : [];
  } else {
    INVITE_PRODUCT_SHOP = shop;
    INVITE_PRODUCT_SELECTED.clear();
    await loadInviteProducts();
  }
  renderInviteProductModalList();
}

function inviteSelectedProducts() {
  const selected = new Set([...INVITE_PRODUCT_SELECTED].map(String));
  return INVITE_PRODUCTS.filter(p => selected.has(String(p.id)));
}

function renderInviteProductSummary() {
  const btn = document.getElementById('invite-product-button');
  const summary = document.getElementById('invite-product-summary');
  if (btn) btn.textContent = INVITE_PRODUCT_SELECTED.size ? `已选 ${INVITE_PRODUCT_SELECTED.size} 件商品` : '添加商品';
  if (summary) {
    const products = inviteSelectedProducts();
    const shopName = SHOPS.find(s => s.id === INVITE_PRODUCT_SHOP)?.name || '未选择店铺';
    summary.textContent = products.length
      ? `${shopName} · ` + products.slice(0, 3).map(p => p.name).join(' / ') + (products.length > 3 ? ` 等 ${products.length} 件` : '')
      : '先选择店铺，再添加该店铺商品';
  }
}

function renderInviteProductModalList() {
  const list = document.getElementById('invite-product-list');
  if (!list) return;
  const selected = PRODUCT_PICKER_CONTEXT === 'workflow' ? WORKFLOW_PRODUCT_SELECTED : INVITE_PRODUCT_SELECTED;
  const shopId = PRODUCT_PICKER_CONTEXT === 'workflow' ? WORKFLOW_PRODUCT_SHOP : INVITE_PRODUCT_SHOP;
  const shopName = SHOPS.find(s => s.id === shopId)?.name || '当前店铺';
  const title = document.getElementById('invite-product-modal-title');
  if (title) title.textContent = `选择商品 · ${shopName}`;
  list.innerHTML = INVITE_PRODUCTS.length ? INVITE_PRODUCTS.map((p) => `
    <label class="product-picker-row">
      <input type="checkbox" class="checkbox" value="${p.id}" ${selected.has(String(p.id)) ? 'checked' : ''}>
      ${productThumbHtml({ product_image_url: p.image_url, product_emoji: p.emoji }, 42)}
      <span class="product-picker-info"><b>${esc(p.name)}</b><em>${esc(p.sku || '-')}</em></span>
    </label>
  `).join('') : '<div class="empty-state">当前店铺暂无商品，请先同步店铺商品</div>';
}

async function openInviteProductModal() {
  PRODUCT_PICKER_CONTEXT = 'invite';
  const select = document.getElementById('invite-product-shop');
  select?.closest('.form-row')?.style && (select.closest('.form-row').style.display = '');
  const defaultShop = INVITE_PRODUCT_SHOP || (curStore === 'all' ? (SHOPS[0]?.id || '') : curStore);
  INVITE_PRODUCT_SHOP = defaultShop;
  if (select) {
    select.innerHTML = SHOPS.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    select.value = INVITE_PRODUCT_SHOP;
  }
  await loadInviteProducts();
  renderInviteProductModalList();
  const modal = document.getElementById('m-invite-products');
  if (modal) modal.style.zIndex = '';
  document.getElementById('m-invite-products')?.classList.add('show');
}

function saveInviteProducts() {
  const checks = document.querySelectorAll('#invite-product-list input[type="checkbox"]:checked');
  if (PRODUCT_PICKER_CONTEXT === 'workflow') {
    WORKFLOW_PRODUCT_SELECTED = new Set([...checks].map(el => String(el.value)));
    renderWorkflowProductSummary();
  } else {
    INVITE_PRODUCT_SELECTED = new Set([...checks].map(el => String(el.value)));
    renderInviteProductSummary();
  }
  closeModal('m-invite-products');
}

function selectedInviteTemplate() {
  const id = Number(document.getElementById('invite-template-select')?.value || 0);
  return INVITE_TEMPLATES.find(t => Number(t.id) === id) || null;
}

function onInviteTemplateChange() {
  const tpl = selectedInviteTemplate();
  const isCollab = tpl?.type === 'collab';
  document.querySelectorAll('.invite-collab-only').forEach(el => { el.style.display = isCollab ? '' : 'none'; });
  renderInviteProductSummary();
}

function renderInviteRecords(records = []) {
  const box = document.getElementById('invite-record-list');
  if (!box) return;
  box.innerHTML = records.slice(0, 6).map((row) => `
    <div class="record-row">
      <div class="record-main"><b>${esc(row.creator_name || row.uid)}</b><span>${esc(row.creator_handle || row.uid)} · ${esc(row.template_name || '邀约模板')} · ${esc(row.provider_message || '')}</span></div>
      <div class="record-status ${esc(row.status)}">${row.status === 'sent' ? '已发送' : row.status === 'failed' ? '失败' : '待发送'}</div>
      ${row.status === 'failed' ? `<button class="btn btn-outline" onclick="retryInvitationRecord(${row.id})">重试</button>` : ''}
      <div class="module-meta">${esc((row.created_at || '').slice(0, 16))}</div>
    </div>`).join('') || '<div class="module-meta">暂无邀约记录</div>';
}

async function retryInvitationRecord(id) {
  try {
    const res = await api(`/api/invitations/records/${id}/retry`, { method: 'POST' });
    toast(res.status === 'sent' ? '私信已发送成功' : (res.provider_message || '重试完成，仍未发送成功'));
    await renderInviteCenter();
  } catch (error) {
    toast(error.message || '重试发送失败');
  }
}

function inviteFilterPayload() {
  return {
    source: INVITE_SOURCE,
    shop: curStore,
    search: document.getElementById('invite-search')?.value || '',
    min_fans: document.getElementById('invite-min-fans')?.value || 0,
    min_fulfillment: document.getElementById('invite-min-fulfillment')?.value || 0,
    min_avg_view: document.getElementById('invite-min-view')?.value || 0,
    min_orders: document.getElementById('invite-min-orders')?.value || 0,
    min_star: document.getElementById('invite-min-star')?.value || 0,
    category: document.getElementById('invite-category')?.value || '',
    imported: INVITE_IMPORTED,
  };
}

async function loadInviteCandidates() {
  const tbody = document.getElementById('invite-candidate-tbody');
  const meta = document.getElementById('invite-candidate-meta');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">正在筛选达人...</div></td></tr>';
  try {
    const data = await api('/api/invitations/candidates', { method: 'POST', body: JSON.stringify(inviteFilterPayload()) });
    INVITE_CANDIDATES = data.candidates || [];
    const keys = new Set(INVITE_CANDIDATES.map(inviteKey));
    INVITE_SELECTED = new Set([...INVITE_SELECTED].filter(key => keys.has(key)));
    if (meta) meta.textContent = `共 ${INVITE_CANDIDATES.length} 位候选达人，已选择 ${INVITE_SELECTED.size} 位`;
    renderInviteCandidateRows();
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">${esc(error.message || '候选达人加载失败')}</div></td></tr>`;
  }
}

function inviteKey(c) {
  return `${c.source || INVITE_SOURCE}:${c.uid || ''}:${c.creator_handle || ''}`;
}

function sourceLabel(source) {
  return { shop_pool: '联盟中心达人池', library: '合作达人库', import: 'Excel导入' }[source] || source;
}

function renderInviteCandidateRows() {
  const tbody = document.getElementById('invite-candidate-tbody');
  const meta = document.getElementById('invite-candidate-meta');
  if (!tbody) return;
  if (!INVITE_CANDIDATES.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">没有符合条件的达人</div></td></tr>';
    if (meta) meta.textContent = '共 0 位候选达人';
    return;
  }
  tbody.innerHTML = INVITE_CANDIDATES.map((c) => {
    const key = inviteKey(c);
    return `<tr>
      <td><input type="checkbox" class="checkbox invite-check" data-key="${esc(key)}" ${INVITE_SELECTED.has(key) ? 'checked' : ''} onchange="setInviteSelected('${jsStr(key)}', this.checked)"></td>
      <td><div class="creator-cell"><img class="av" src="${avatarSVG(c.creator_name || c.uid, 32)}"><div><div class="cn">${esc(c.creator_name || c.uid)}</div><div class="cm">${esc(c.creator_handle || c.uid)} · ${esc(c.category || '-')}</div></div></div></td>
      <td>${sourceLabel(c.source)}${c.shop_name ? `<div class="cm">${esc(c.shop_name)}</div>` : ''}</td>
      <td>${fmtF(c.fans)}</td>
      <td>${fmtPercent(c.fulfillment_rate)}</td>
      <td>${fmtF(c.avg_view)}</td>
      <td>${c.total_orders || 0}</td>
      <td>${c.star ? `${c.star} 星` : '-'}</td>
      <td>${c.last_invited_at ? esc(c.last_invited_at.slice(0, 10)) : '-'}</td>
    </tr>`;
  }).join('');
  if (meta) meta.textContent = `共 ${INVITE_CANDIDATES.length} 位候选达人，已选择 ${INVITE_SELECTED.size} 位`;
}

function setInviteSource(source) {
  INVITE_SOURCE = source;
  INVITE_SELECTED.clear();
  renderInviteSourceTabs();
  loadInviteCandidates();
}

function onInviteFilterChange() {
  clearTimeout(inviteFilterTimer);
  inviteFilterTimer = setTimeout(loadInviteCandidates, 250);
}

function setInviteSelected(key, checked) {
  if (checked) INVITE_SELECTED.add(key);
  else INVITE_SELECTED.delete(key);
  renderInviteCandidateRows();
  renderInviteCenterKpiSelectionOnly();
}

function renderInviteCenterKpiSelectionOnly() {
  const values = document.querySelectorAll('#invite-kpis .stat-val');
  if (values[5]) values[5].textContent = INVITE_SELECTED.size;
}

function toggleInviteSelection(checked) {
  if (checked) INVITE_CANDIDATES.forEach(c => INVITE_SELECTED.add(inviteKey(c)));
  else INVITE_SELECTED.clear();
  renderInviteCandidateRows();
  renderInviteCenterKpiSelectionOnly();
}

function parseDelimitedInviteText(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map(h => h.trim());
  const uidIndex = headers.findIndex(h => /uid|达人uid|达人 uid/i.test(h));
  const nameIndex = headers.findIndex(h => /name|昵称|达人名称|达人昵称/i.test(h));
  const handleIndex = headers.findIndex(h => /handle|tiktok|id/i.test(h));
  const fansIndex = headers.findIndex(h => /fans|followers|粉丝/i.test(h));
  const categoryIndex = headers.findIndex(h => /category|分类/i.test(h));
  return lines.slice(1).map((line) => {
    const cols = line.split(delimiter).map(v => v.trim());
    return {
      uid: cols[uidIndex >= 0 ? uidIndex : 0],
      creator_name: nameIndex >= 0 ? cols[nameIndex] : '',
      creator_handle: handleIndex >= 0 ? cols[handleIndex] : '',
      fans: fansIndex >= 0 ? Number(cols[fansIndex] || 0) : 0,
      category: categoryIndex >= 0 ? cols[categoryIndex] : '',
    };
  }).filter(row => row.uid);
}

function updateInviteImportPreview() {
  const box = document.getElementById('invite-import-preview');
  if (!box) return;
  box.textContent = INVITE_IMPORTED.length
    ? `已解析 ${INVITE_IMPORTED.length} 位达人。字段会读取 UID、达人昵称、TikTok ID、粉丝量、分类。`
    : '支持 CSV、制表符文本，或从 Excel 复制后粘贴。';
}

function parseInvitePaste() {
  INVITE_IMPORTED = parseDelimitedInviteText(document.getElementById('invite-import-text')?.value || '');
  INVITE_SELECTED.clear();
  updateInviteImportPreview();
  loadInviteCandidates();
}

function importInviteFile(file) {
  if (!file) return;
  if (/\.xlsx?$/i.test(file.name)) {
    toast('请先将 Excel 另存为 CSV，或直接复制表格内容粘贴解析');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    INVITE_IMPORTED = parseDelimitedInviteText(reader.result || '');
    INVITE_SELECTED.clear();
    updateInviteImportPreview();
    loadInviteCandidates();
  };
  reader.readAsText(file, 'utf-8');
}

async function sendInvitations() {
  const selected = INVITE_CANDIDATES.filter(c => INVITE_SELECTED.has(inviteKey(c)));
  const templateId = document.getElementById('invite-template-select')?.value;
  const tpl = selectedInviteTemplate();
  const productIds = [...INVITE_PRODUCT_SELECTED];
  const commissionRate = document.getElementById('invite-commission-rate')?.value || '';
  const sendMode = document.getElementById('invite-send-mode')?.value || 'auto';
  const sampleApprovalMode = document.getElementById('invite-sample-approval-mode')?.value || 'manual';
  if (!selected.length) return toast('请先选择要邀约的达人');
  if (!templateId) return toast('请先选择邀约模板');
  if (tpl?.type === 'collab' && !productIds.length) return toast('合作邀约需要选择一个或多个产品');
  if (tpl?.type === 'collab' && curStore !== 'all' && INVITE_PRODUCT_SHOP && INVITE_PRODUCT_SHOP !== curStore) return toast('商品店铺与当前邀约店铺不一致，请先切换店铺');
  if (tpl?.type === 'collab' && commissionRate && (Number(commissionRate) < 0 || Number(commissionRate) > 100)) return toast('佣金比例需在 0-100 之间');
  try {
    toast('正在创建邀约任务...');
    const result = await api('/api/invitations/send', {
      method: 'POST',
      body: JSON.stringify({
        source: INVITE_SOURCE,
        shop: curStore,
        template_id: templateId,
        product_ids: productIds,
        commission_rate: commissionRate || null,
        send_mode: sendMode,
        sample_approval_mode: sampleApprovalMode,
        channel: 'im',
        creators: selected,
      }),
    });
    INVITE_SELECTED.clear();
    await renderInviteCenter();
    toast(`邀约任务完成：${result.sent} 条已发送，${result.pending} 条待后台私信，${result.failed} 条失败`);
  } catch (error) {
    toast(error.message || '发送邀约失败');
  }
}

// ════ SAMPLE CENTER ════
async function renderSamplePage() {
  await renderStats();
  await renderTabs();
  await renderSampleTable();
}

async function renderStats() {
  const stats = await api(`/api/samples/stats?shop=${curStore}`);
  sampleStats = stats;
  const data = [
    { lbl: '待审核申请', val: stats.byStatus.pending || 0, hl: true, d: '需要处理' },
    { lbl: '申请总数', val: stats.total, d: '当前店铺范围' },
    { lbl: '已分配 BD', val: stats.assignedBD },
    { lbl: '已寄出样品', val: stats.byStatus.shipped || 0 },
    { lbl: '已发布视频', val: stats.byStatus.published || 0 },
  ];
  document.getElementById('stats-row').innerHTML = data.map(d => `
    <div class="stat-card ${d.hl ? 'hl' : ''}">
      <div class="stat-lbl">${d.lbl}</div>
      <div class="stat-val">${d.val}</div>
      ${d.d ? `<div class="stat-delta">${d.d}</div>` : ''}
    </div>`).join('');
  document.getElementById('sample-badge').textContent = stats.byStatus.pending || 0;
}

async function renderTabs() {
  const stats = sampleStats;
  const tabs = [
    { id: 'all', lbl: '全部申请', cnt: stats.total },
    { id: 'pending', lbl: '待审核', cnt: stats.byStatus.pending || 0 },
    { id: 'assigned', lbl: '已分配', cnt: stats.byStatus.assigned || 0 },
    { id: 'shipped', lbl: '已寄出', cnt: stats.byStatus.shipped || 0 },
    { id: 'published', lbl: '已发布', cnt: stats.byStatus.published || 0 },
    { id: 'rejected', lbl: '已拒绝', cnt: stats.byStatus.rejected || 0 },
    { id: 'cancelled', lbl: '已取消', cnt: stats.byStatus.cancelled || 0 },
  ];
  document.getElementById('tab-bar').innerHTML = tabs.map(t => `
    <div class="tab-item ${t.id === curTab ? 'active' : ''}" onclick="switchTab('${t.id}')">
      ${t.lbl} <span class="tab-cnt">${t.cnt}</span>
    </div>`).join('');
}

function switchTab(tab) {
  curTab = tab;
  samplePage = 1;
  renderTabs();
  const tbody = document.getElementById('sample-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="15"><div class="empty-state"><div>正在加载...</div></div></td></tr>';
  renderSampleTable();
}

async function renderSampleTable() {
  const params = new URLSearchParams();
  if (curStore !== 'all') params.set('shop', curStore);
  if (curTab !== 'all') params.set('status', curTab);
  if (sSearch) params.set('search', sSearch);
  if (sType) params.set('collab_type', sType);

  let list = [];
  try {
    list = await api('/api/samples?' + params.toString());
  } catch (error) {
    document.getElementById('sample-tbody').innerHTML = `<tr><td colspan="15"><div class="empty-state"><div>${esc(error.message || '样品列表加载失败')}</div></div></td></tr>`;
    return;
  }
  const showShop = curStore === 'all';
  const thead = document.getElementById('sample-thead');
  const existing = thead.querySelector('.th-shop');
  if (showShop && !existing) {
    const th = document.createElement('th');
    th.className = 'th-shop'; th.textContent = '店铺';
    thead.insertBefore(th, thead.children[10]);
  } else if (!showShop && existing) {
    existing.remove();
  }

  const tbody = document.getElementById('sample-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${showShop ? 15 : 14}"><div class="empty-state"><div class="empty-icon">📭</div><div>暂无申请数据</div></div></td></tr>`;
    document.getElementById('pager-info').innerHTML = pagerHtml('sample', { total: 0, page: 1, pageSize: samplePageSize, totalPages: 1 });
    return;
  }

  const groups = [];
  const groupMap = new Map();
  list.forEach((s) => {
    const key = s.uid || s.creator_handle || s.creator_name || s.id;
    if (!groupMap.has(key)) {
      const group = { key, items: [] };
      groupMap.set(key, group);
      groups.push(group);
    }
    groupMap.get(key).items.push(s);
  });
  groups.forEach(group => {
    group.items.sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')));
  });
  groups.sort((a, b) => {
    return String(b.items[0]?.applied_at || '').localeCompare(String(a.items[0]?.applied_at || ''));
  });
  const pageMeta = paginate(groups, samplePage, samplePageSize);
  samplePage = pageMeta.page;
  document.getElementById('pager-info').innerHTML = pagerHtml('sample', pageMeta);

  const badRows = [];
  const rowsHtml = pageMeta.items.map((group) => group.items.map((s, groupIndex) => {
    try {
    const sid = jsStr(s.id);
    const creatorName = esc(s.creator_name || '-');
    const creatorHandle = esc(s.creator_handle || '');
    const category = esc(s.category || '');
    const productName = esc(s.product_name || '-');
    const productSku = esc(s.product_sku || '');
    const av = avatarUrl(s, 36);
    const productThumb = productThumbHtml(s, 34);
    const rowSpan = group.items.length;
    const groupBadge = rowSpan > 1 ? `<span class="group-count">${rowSpan} 个申请</span>` : '';
    const creatorCell = groupIndex === 0
      ? `<td rowspan="${rowSpan}" class="creator-group-cell"><div class="cc"><img src="${av}" class="av" onclick="openCreatorModal('${sid}')"><div><div class="cn" onclick="openCreatorModal('${sid}')">${creatorName}</div><div class="cm">${creatorHandle} · ${category}</div>${groupBadge}</div></div></td>`
      : '';
    const fansCell = groupIndex === 0
      ? `<td rowspan="${rowSpan}" class="creator-group-cell" style="font-weight:500">${fmtF(s.fans)}</td>`
      : '';
    const fulfillmentCell = groupIndex === 0 ? `<td rowspan="${rowSpan}" class="creator-group-cell metric-cell">${fmtPercent(s.fulfillment_rate)}</td>` : '';
    const avgViewCell = groupIndex === 0 ? `<td rowspan="${rowSpan}" class="creator-group-cell metric-cell">${fmtF(Number(s.avg_view) || 0)}</td>` : '';
    const salesCell = groupIndex === 0 ? `<td rowspan="${rowSpan}" class="creator-group-cell metric-cell">${fmtMoney(s.sales_amount, s.sales_currency)}</td>` : '';
    const salesCountCell = groupIndex === 0 ? `<td rowspan="${rowSpan}" class="creator-group-cell metric-cell">${s.sales_count ?? '-'}</td>` : '';
    const remainingClass = remainingDaysText(s.approve_expiration_at).includes('1 天') || remainingDaysText(s.approve_expiration_at) === '已过期' ? 'remain-warn' : '';
    const bdHtml = s.bd_id
      ? `<div style="display:flex;align-items:center;gap:6px"><img src="${avatarSVG(s.bd_name, 22)}" style="width:22px;height:22px;border-radius:50%"><span style="font-size:12px;color:#555">${esc(s.bd_name || '')}</span></div>`
      : `<button class="assign-btn" onclick="openAssignModal(event,'${sid}')">分配 BD</button>`;
    const actHtml = s.status === 'pending'
      ? `<div class="abtns"><button class="abtn ok" onclick="doApprove('${sid}')">通过</button><button class="abtn ng" onclick="doReject('${sid}')">拒绝</button><button class="abtn bl" onclick="openCreatorModal('${sid}')">详情</button></div>`
      : s.status === 'assigned'
        ? `<div class="abtns"><button class="abtn ok" onclick="doApprove('${sid}')">审核通过</button><button class="abtn ng" onclick="doReject('${sid}')">拒绝</button><button class="abtn bl" onclick="openCreatorModal('${sid}')">详情</button></div>`
        : s.status === 'rejected'
          ? `<div class="abtns"><button class="abtn ok" onclick="restoreSample('${sid}')">恢复</button><button class="abtn bl" onclick="openCreatorModal('${sid}')">详情</button></div>`
          : `<div class="abtns"><button class="abtn bl" onclick="openCreatorModal('${sid}')">达人</button><button class="abtn" onclick="toast('物流记录暂未接入')">物流</button></div>`;
    return `<tr class="${groupIndex === 0 ? 'sample-group-start' : 'sample-group-sub'}">
      <td><input type="checkbox" class="checkbox"></td>
      ${creatorCell}
      ${fansCell}
      ${fulfillmentCell}
      ${avgViewCell}
      ${salesCell}
      ${salesCountCell}
      <td><div class="pc">${productThumb}<div><div class="pn">${productName}</div><div class="ps">${productSku}</div>${sampleExternalMeta(s)}</div></div></td>
      ${showShop ? `<td>${shopTagHtml(s.shop_id)}</td>` : ''}
      <td class="metric-cell">${fmtCommission(s.commission_rate)}</td>
      <td class="remain-cell ${remainingClass}">${remainingDaysText(s.approve_expiration_at)}</td>
      <td onclick="openCollabModal(event,'${sid}')">${collabTagHtml(s.collab_type, sid)}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${bdHtml}</td>
      <td>${actHtml}</td>
    </tr>`;
    } catch (error) {
      console.error('render sample row failed', s, error);
      badRows.push(s.id || group.key);
      return '';
    }
  }).join('')).filter(Boolean).join('');
  try {
  tbody.innerHTML = rowsHtml || `<tr><td colspan="${showShop ? 15 : 14}"><div class="empty-state"><div>暂无可显示数据</div></div></td></tr>`;
  } catch (error) {
    console.error('renderSampleTable failed', error);
    tbody.innerHTML = `<tr><td colspan="${showShop ? 15 : 14}"><div class="empty-state"><div>列表渲染失败，请刷新后重试</div></div></td></tr>`;
  }
  if (badRows.length) toast(`有 ${badRows.length} 条数据暂时无法显示`);
}

function onSampleSearch(v) { sSearch = v.toLowerCase(); samplePage = 1; renderSampleTable(); }
function setTypeFilter(v) { sType = v; samplePage = 1; renderSampleTable(); }
function resetFilters() {
  sSearch = ''; sType = ''; samplePage = 1;
  document.querySelectorAll('#page-sample .fi').forEach(el => { if (el.type === 'text') el.value = ''; else if (el.tagName === 'SELECT') el.selectedIndex = 0; });
  renderSampleTable();
}
function selAll(cb) { document.querySelectorAll('#sample-tbody .checkbox').forEach(c => c.checked = cb.checked); }

async function doApprove(id) {
  await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
  toast('已通过审核，已进入合作达人库');
  renderSamplePage();
}
async function doReject(id) {
  await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) });
  toast('❌ 已拒绝该申请');
  renderSamplePage();
}
async function restoreSample(id) {
  await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
  toast('已恢复到待审核');
  renderSamplePage();
}

// ════ NEW SAMPLE MODAL ════
function openNewSampleModal() {
  const shopSel = document.getElementById('ns-shop');
  shopSel.innerHTML = SHOPS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  updateNewSampleProducts();
  shopSel.onchange = updateNewSampleProducts;
  ['ns-uid','ns-name','ns-handle','ns-fans','ns-category'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('m-new-sample').classList.add('show');
}
async function updateNewSampleProducts() {
  const shop = document.getElementById('ns-shop').value;
  const prods = await api(`/api/products?shop=${shop}`);
  document.getElementById('ns-product').innerHTML = prods.map(p => `<option value="${p.id}">${p.emoji} ${p.name}</option>`).join('');
}
async function submitNewSample() {
  const body = {
    shop_id: document.getElementById('ns-shop').value,
    uid: document.getElementById('ns-uid').value.trim(),
    creator_name: document.getElementById('ns-name').value.trim(),
    creator_handle: document.getElementById('ns-handle').value.trim(),
    fans: parseInt(document.getElementById('ns-fans').value) || 0,
    category: document.getElementById('ns-category').value.trim(),
    product_id: parseInt(document.getElementById('ns-product').value),
    status: 'pending',
    collab_type: ''
  };
  if (!body.uid || !body.creator_name) { toast('⚠️ 请填写 UID 和达人昵称'); return; }
  await api('/api/samples', { method: 'POST', body: JSON.stringify(body) });
  closeModal('m-new-sample');
  toast('✅ 样品申请已创建');
  renderSamplePage();
  updateStoreCounts();
}

// ════ CREATOR LIBRARY ════
async function renderLibPage() {
  populateBDFilter();
  const monthInput = document.getElementById('lib-order-month');
  if (monthInput) {
    monthInput.value = lOrderMonth;
    monthInput.style.display = lOrderRange === 'month' ? '' : 'none';
  }
  const params = new URLSearchParams();
  if (curStore !== 'all') params.set('shop', curStore);
  if (lSearch) params.set('search', lSearch);
  if (lStar) params.set('star', lStar);
  if (lBD) params.set('bd', lBD);
  if (lSort) params.set('sort', lSort);
  params.set('order_range', lOrderRange);
  if (lOrderRange === 'month') params.set('order_month', lOrderMonth);

  const creators = await api('/api/library?' + params.toString());
  const grid = document.getElementById('lib-grid');
  let libPager = document.getElementById('lib-pager');
  if (!libPager && grid) {
    libPager = document.createElement('div');
    libPager.className = 'pager';
    libPager.id = 'lib-pager';
    grid.insertAdjacentElement('afterend', libPager);
  }

  if (!creators.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><div>暂无合作达人数据<br><span style="font-size:12px;color:#bbb">已通过审核的样品申请会自动出现在这里</span></div></div>`;
    if (libPager) libPager.innerHTML = pagerHtml('lib', { total: 0, page: 1, pageSize: libPageSize, totalPages: 1 });
    return;
  }

  const pageMeta = paginate(creators, libPage, libPageSize);
  libPage = pageMeta.page;
  if (libPager) libPager.innerHTML = pagerHtml('lib', pageMeta);

  grid.innerHTML = pageMeta.items.map(c => {
    const shops = c.shops;
    const shopDisplay = shops.length > 1 ? 'both' : shops[0];
    const av = avatarSVG(c.name, 44);
    const totalOrders = c.totalOrders ?? 0;
    const salesAmount = c.affiliateSalesAmount ?? 0;
    const salesCurrency = c.affiliateCurrency || 'JPY';
    const orderLabel = c.orderRangeLabel || orderRangeText();
    const uidsAttr = attrJson(c.uids || [c.uid]);
    const bdSelect = bdStatSelectHtml(c, uidsAttr);

    const subRows = c.samples.map(s => `
      <tr>
        <td>${shopTagHtml(s.shop_id)}</td>
        <td><div style="display:flex;align-items:center;gap:6px">${productThumbHtml(s, 30)}<div><div style="font-size:12px">${esc(s.product_name || '-')}</div><div style="font-size:11px;color:#999">${esc(s.product_sku || '')}</div></div></div></td>
        <td style="color:#999">${(s.applied_at || '').slice(0, 10)}</td>
        <td>${collabTagHtml(s.collab_type, s.id)}</td>
        <td>${statusBadge(s.status)}</td>
        <td style="font-size:11px;color:#999">${progressLabel(s.status)}</td>
      </tr>`).join('');

    return `<div class="lib-card" id="lc-${c.uid}">
      <div class="lib-head" onclick="toggleCard('${c.uid}')">
        <img src="${avatarUrl(c.samples?.[0] || c, 44)}" style="width:44px;height:44px;border-radius:50%;flex-shrink:0;border:1.5px solid #f0f0f0;object-fit:cover">
        <div class="lib-info">
          <div class="lib-name">
            ${c.name}
            ${shopDisplay === 'both' ? '<span class="shop-tag st-both">双店铺合作</span>' : shopTagHtml(shops[0])}
            ${c.star > 0 ? starBadgeHtml(c.star) : ''}
          </div>
          <div class="lib-meta">
            <div class="lib-meta-line"><span>${esc(c.handle || '')}</span><span>粉丝 ${fmtF(c.fans)}</span></div>
            <div class="lib-meta-line lib-meta-controls">
              <span>加入达人库 ${(c.latestCoopAt || c.firstCoopAt || '-').slice(0, 10)}</span>
            </div>
          </div>
        </div>
        <div class="lib-stats">
          <div><div class="lib-stat-val">${bdSelect}</div><div class="lib-stat-lbl">负责BD</div></div>
          <div><div class="lib-stat-val">${c.cooperationCount ?? c.samples.length}</div><div class="lib-stat-lbl">合作次数</div></div>
          <div><div class="lib-stat-val">${totalOrders}</div><div class="lib-stat-lbl">累计出单<br>${esc(orderLabel)}</div></div>
          <div><div class="lib-stat-val">${fmtMoney(salesAmount, salesCurrency)}</div><div class="lib-stat-lbl">联盟销售额<br>${esc(orderLabel)}</div></div>
        </div>
        <div class="stars" onclick="event.stopPropagation()" id="stars-${c.uid}">
          ${[1,2,3,4,5].map(n => `<span class="star ${n <= c.star ? 'on' : 'off'}" onclick="setStar('${c.uid}',${n},'${uidsAttr}')">${n <= c.star ? '★' : '☆'}</span>`).join('')}
        </div>
        <div class="lib-expand">▼</div>
      </div>
      <div class="lib-body">
        <table class="sub-table">
          <thead><tr><th>店铺</th><th>样品商品</th><th>申请日期</th><th>合作类型</th><th>状态</th><th>合作进度</th></tr></thead>
          <tbody>${subRows}</tbody>
        </table>
        <div class="bd-note">
          <div class="bd-note-lbl">BD / 管理员备注（达人介绍、联系方式、出单情况等）</div>
          <textarea class="bd-note-ta" id="note-${c.uid}" placeholder="记录达人沟通情况、联系方式、出单详情...">${esc(c.libNote || '')}</textarea>
          <button class="bd-note-save" onclick="saveNote('${c.uid}', '${uidsAttr}')">保存备注</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleCard(uid) { document.getElementById('lc-' + uid)?.classList.toggle('open'); }

async function setStar(uid, n, uids = [uid]) {
  if (typeof uids === 'string') uids = parseAttrJson(uids, [uid]);
  await api(`/api/library/${uid}/star`, { method: 'PUT', body: JSON.stringify({ star: n, uids }) });
  toast(`⭐ 已标记 ${n} 星`);
  renderLibPage();
}
async function saveNote(uid, uids = [uid]) {
  if (typeof uids === 'string') uids = parseAttrJson(uids, [uid]);
  const note = document.getElementById('note-' + uid)?.value || '';
  await api(`/api/library/${uid}/note`, { method: 'PUT', body: JSON.stringify({ note, uids }) });
  toast('📝 备注已保存');
}
function onLibSearch(v) { lSearch = v.toLowerCase(); libPage = 1; renderLibPage(); }
function filterLibStar(v) { lStar = v; libPage = 1; renderLibPage(); }
function filterLibBD(v) { lBD = v; libPage = 1; renderLibPage(); }
function sortLib(v) { lSort = v; libPage = 1; renderLibPage(); }
function orderRangeText() {
  if (lOrderRange === '7d') return '近7天';
  if (lOrderRange === 'month') return `${lOrderMonth || new Date().toISOString().slice(0, 7)} 月`;
  if (lOrderRange === 'all') return '历史所有订单';
  return '近90天';
}
function setLibOrderRange(v) {
  lOrderRange = v || '90d';
  libPage = 1;
  const monthInput = document.getElementById('lib-order-month');
  if (monthInput) monthInput.style.display = lOrderRange === 'month' ? '' : 'none';
  renderLibPage();
}
function setLibOrderMonth(v) {
  lOrderMonth = v || new Date().toISOString().slice(0, 7);
  libPage = 1;
  renderLibPage();
}
async function runAutoStarAgent() {
  try {
    toast('自动标星 Agent 正在按近90天订单计算...');
    const params = curStore !== 'all' ? `?shop=${encodeURIComponent(curStore)}` : '';
    const result = await api('/api/library/auto-star' + params, { method: 'POST', body: JSON.stringify({}) });
    await renderLibPage();
    toast(`自动标星完成：${result.creators} 位达人，5星 ${result.by_star?.[5] || 0}，4星 ${result.by_star?.[4] || 0}，3星 ${result.by_star?.[3] || 0}`);
  } catch (error) {
    toast(error.message || '自动标星失败');
  }
}
async function saveLibBD(uid, bdId, uids = [uid], selectEl = null) {
  if (typeof uids === 'string') uids = parseAttrJson(uids, [uid]);
  await api(`/api/library/${uid}/bd`, { method: 'PUT', body: JSON.stringify({ bd_id: bdId || null, uids }) });
  if (selectEl) {
    const bd = BD_LIST.find(item => String(item.id) === String(bdId));
    selectEl.style.cssText = bdColorStyle(bdId);
    selectEl.title = bd ? `负责 BD：${bd.name}` : '负责 BD：未分配';
  }
  toast('负责 BD 已更新');
  await loadShopsAndBD();
  renderLibPage();
}

function populateBDFilter() {
  const sel = document.getElementById('lib-bd-sel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 BD</option>' + BD_LIST.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  sel.value = cur || '';
}

// ════ DATA CENTER ════
const STATUS_LABELS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  assigned: '已分配',
  shipped: '已寄出',
  published: '已发布',
  cancelled: '已取消'
};
const COLLAB_LABELS = {
  open: '公开合作',
  service_provider: '服务商合作',
  targeted: '定向合作',
  affiliate: '联盟合作',
  unset: '未标记'
};

function pct(value, total) {
  if (!total) return 0;
  return Math.round((Number(value || 0) / Number(total || 1)) * 100);
}

function money(n) {
  const num = Number(n || 0);
  return num ? num.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function renderMiniBars(rows, labels) {
  const max = Math.max(...rows.map(r => Number(r.count || 0)), 1);
  return rows.map(r => {
    const key = r.status || r.type;
    const count = Number(r.count || 0);
    return `<div class="dc-bar-row">
      <div class="dc-bar-label">${labels[key] || key}</div>
      <div class="dc-bar-track"><div class="dc-bar-fill" style="width:${Math.round(count / max * 100)}%"></div></div>
      <div class="dc-bar-num">${count}</div>
    </div>`;
  }).join('');
}

async function renderDataCenter() {
  const box = document.getElementById('data-center');
  if (!box) return;
  box.innerHTML = '<div class="empty-state"><div>正在加载数据...</div></div>';

  try {
    const data = await api(`/api/data/overview?shop=${curStore}`);
    const s = data.sampleStats || {};
    const o = data.orderStats || {};
    const total = Number(s.total || 0);

    box.innerHTML = `
      <div class="dc-kpis">
        <div class="stat-card hl"><div class="stat-lbl">合作转化率</div><div class="stat-val">${pct(s.published, total)}%</div><div class="stat-delta">${s.published || 0} 个已发布 / ${total} 个申请</div></div>
        <div class="stat-card"><div class="stat-lbl">活跃合作达人</div><div class="stat-val">${s.active || 0}</div><div class="stat-delta">通过、分配、寄出、发布</div></div>
        <div class="stat-card"><div class="stat-lbl">待处理申请</div><div class="stat-val">${s.pending || 0}</div><div class="stat-delta">${s.unset_type || 0} 个未标记类型</div></div>
        <div class="stat-card"><div class="stat-lbl">同步订单金额</div><div class="stat-val">${money(o.amount)}</div><div class="stat-delta">${o.total || 0} 个订单 / ${o.buyers || 0} 个买家</div></div>
      </div>

      <div class="dc-grid">
        <section class="dc-panel">
          <div class="dc-panel-title">样品状态分布</div>
          ${renderMiniBars(data.statusRows || [], STATUS_LABELS)}
        </section>
        <section class="dc-panel">
          <div class="dc-panel-title">合作类型分布</div>
          ${renderMiniBars(data.collabRows || [], COLLAB_LABELS)}
        </section>
      </div>

      <div class="dc-grid">
        <section class="dc-panel">
          <div class="dc-panel-title">BD 月报</div>
          <table class="dc-table">
            <thead><tr><th>BD</th><th>负责达人</th><th>样品申请</th><th>已发布</th></tr></thead>
            <tbody>${(data.bdRows || []).map(b => `<tr><td>${b.name}</td><td>${b.creators || 0}</td><td>${b.samples || 0}</td><td>${b.published || 0}</td></tr>`).join('') || '<tr><td colspan="4">暂无 BD 数据</td></tr>'}</tbody>
          </table>
        </section>
        <section class="dc-panel">
          <div class="dc-panel-title">重点达人</div>
          <table class="dc-table">
            <thead><tr><th>达人</th><th>粉丝</th><th>合作</th><th>星级</th></tr></thead>
            <tbody>${(data.topCreators || []).map(c => `<tr><td><div class="dc-creator">${c.creator_name}<span>${c.creator_handle || c.uid}</span></div></td><td>${fmtF(c.fans)}</td><td>${c.samples || 0}</td><td>${c.star ? `${c.star} 星` : '-'}</td></tr>`).join('') || '<tr><td colspan="4">暂无达人数据</td></tr>'}</tbody>
          </table>
        </section>
      </div>

      <section class="dc-panel">
        <div class="dc-panel-title">最近同步记录</div>
        <table class="dc-table">
          <thead><tr><th>时间</th><th>店铺</th><th>来源</th><th>状态</th><th>结果</th></tr></thead>
          <tbody>${(data.syncLogs || []).map(l => `<tr><td>${l.created_at || '-'}</td><td>${l.shop_name || l.shop_id || '-'}</td><td>${l.source}</td><td>${l.status}</td><td>${l.message || ''}</td></tr>`).join('') || '<tr><td colspan="5">暂无同步记录</td></tr>'}</tbody>
        </table>
      </section>`;
  } catch (error) {
    box.innerHTML = `<div class="empty-state"><div>${error.message || '数据加载失败'}</div></div>`;
  }
}

// ════ MODALS ════
async function openCreatorModal(sid) {
  const list = await api('/api/samples');
  const s = list.find(x => x.id === sid);
  if (!s) return;
  const av = avatarUrl(s, 68);
  document.getElementById('m-creator-body').innerHTML = `
    <div class="cpt">
      <img src="${av}" class="cpa">
      <div style="flex:1">
        <div class="cpn">${s.creator_name}</div>
        <div class="cph">${s.creator_handle || ''} · ${s.category || ''} · ${shopTagHtml(s.shop_id)}</div>
        <div class="cpstats">
          <div><div class="cpstat-val">${fmtF(s.fans)}</div><div class="cpstat-lbl">粉丝</div></div>
          <div><div class="cpstat-val">${s.videos || 0}</div><div class="cpstat-lbl">视频数</div></div>
          <div><div class="cpstat-val">${s.avg_view || '-'}</div><div class="cpstat-lbl">均播放</div></div>
        </div>
      </div>
      <button class="btn btn-outline" style="font-size:12px;flex-shrink:0" onclick="toast('🔗 跳转 TikTok 主页（演示）')">↗ TikTok</button>
    </div>
    <div class="info-sec">
      <div class="info-sec-t">达人信息</div>
      <div class="info-grid">
        <div><div class="info-lbl">UID（唯一标识）</div><div class="info-val" style="font-family:monospace;font-size:12px">${s.uid}</div></div>
        <div><div class="info-lbl">TikTok Handle</div><div class="info-val">${s.creator_handle || '-'}</div></div>
        <div><div class="info-lbl">履约率</div><div class="info-val">${fmtPercent(s.fulfillment_rate)}</div></div>
        <div><div class="info-lbl">平均播放量</div><div class="info-val">${fmtF(Number(s.avg_view) || 0)}</div></div>
        <div><div class="info-lbl">销量</div><div class="info-val">${fmtMoney(s.sales_amount, s.sales_currency)}</div></div>
        <div><div class="info-lbl">成交件数</div><div class="info-val">${s.sales_count ?? '-'}</div></div>
        <div><div class="info-lbl">佣金</div><div class="info-val">${fmtCommission(s.commission_rate)}</div></div>
        <div><div class="info-lbl">剩余天数</div><div class="info-val">${remainingDaysText(s.approve_expiration_at)}</div></div>
        <div><div class="info-lbl">合作类型</div><div class="info-val">${collabLabel(s.collab_type) || '未标记'}</div></div>
        <div><div class="info-lbl">申请样品</div><div class="info-val"><div style="display:flex;align-items:center;gap:8px">${productThumbHtml(s, 34)}<span>${esc(s.product_name || '-')}</span></div></div></div>
        <div><div class="info-lbl">来源店铺</div><div class="info-val">${shopTagHtml(s.shop_id)}</div></div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" style="flex:1" onclick="doApprove('${s.id}');closeModal('m-creator')">✅ 通过审核</button>
      <button class="btn btn-outline" style="flex:1" onclick="closeModal('m-creator');openAssignModal(event,'${s.id}')">👤 分配 BD</button>
      <button class="btn btn-ghost" onclick="doReject('${s.id}');closeModal('m-creator')">✕ 拒绝</button>
    </div>`;
  document.getElementById('m-creator').classList.add('show');
}

function openAssignModal(e, sid) {
  e.stopPropagation(); assignTgt = sid;
  document.getElementById('assign-list').innerHTML = BD_LIST.map(b => `
    <div class="assign-opt" onclick="doAssign(${b.id})">
      <img src="${avatarSVG(b.name, 36)}" style="width:36px;height:36px;border-radius:50%">
      <div class="assign-opt-info"><div class="assign-opt-name">${b.name}</div><div class="assign-opt-meta">当前负责 ${b.load} 个达人</div></div>
      <span class="assign-opt-load">${b.load} 人</span>
    </div>`).join('');
  document.getElementById('m-assign').classList.add('show');
}
async function doAssign(bdId) {
  await api(`/api/samples/${assignTgt}`, { method: 'PATCH', body: JSON.stringify({ bd_id: bdId, status: 'assigned' }) });
  closeModal('m-assign');
  const bd = BD_LIST.find(b => b.id === bdId);
  toast(`📨 已分配给 ${bd?.name}，对方将收到通知`);
  await loadShopsAndBD();
  renderSamplePage();
}

function openCollabModal(e, sid) {
  e.stopPropagation(); collabTgt = sid;
  const opts = [
    { v: 'open', l: '公开合作', d: '面向所有达人开放申请', dc: 'cd-open', sc: 'col-sel-open' },
    { v: 'service_provider', l: '服务商合作', d: '服务商或 partner 渠道申请', dc: 'cd-targeted', sc: 'col-sel-targeted' },
    { v: 'targeted', l: '定向合作', d: '邀请特定达人合作', dc: 'cd-targeted', sc: 'col-sel-targeted' },
    { v: 'affiliate', l: '联盟合作', d: '佣金分成推广模式', dc: 'cd-affiliate', sc: 'col-sel-affiliate' },
  ];
  document.getElementById('collab-picker').innerHTML = opts.map(o => `
    <div class="collab-opt" onclick="doSetCollab('${o.v}')">
      <div class="cdot ${o.dc}"></div>
      <div><div style="font-weight:500;font-size:13px">${o.l}</div><div style="font-size:11px;color:#999;margin-top:2px">${o.d}</div></div>
    </div>`).join('');
  document.getElementById('m-collab').classList.add('show');
}
async function doSetCollab(v) {
  await api(`/api/samples/${collabTgt}`, { method: 'PATCH', body: JSON.stringify({ collab_type: v }) });
  closeModal('m-collab');
  toast('🏷️ 合作类型已更新');
  renderSamplePage();
  if (curPage === 'lib') renderLibPage();
}

function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

// ════ BD 成员管理页面 ════
async function renderBDMgmt() {
  BD_LIST = await api('/api/bd');
  const tbody = document.getElementById('bd-mgmt-tbody');
  if (!tbody) return;
  tbody.innerHTML = BD_LIST.map(b => `
    <tr><td>${b.name}<div class="module-meta">来源：系统员工 · 企微：${b.wecom_userid || '未配置'}</div></td><td>${b.load} 个</td></tr>
  `).join('') || '<tr><td colspan="2"><div class="empty-state">暂无 BD 成员</div></td></tr>';
}

function agentTemplateManagerHtml() {
  const productOptions = '<option value="">发送时选择产品</option>' + INVITE_PRODUCTS.map(p => `<option value="${p.id}">${esc(p.emoji || '')} ${esc(p.name)}${p.sku ? ` · ${esc(p.sku)}` : ''}</option>`).join('');
  return `
    <div class="module-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <h3 style="margin-bottom:0">邀约消息模板</h3>
        <div class="module-meta">私信消息走达人后台私信；合作邀约会附带产品样品申请链接</div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">模板名称</label><input class="form-input" id="agent-template-name" placeholder="例如 初次私信 / 样品合作邀约"></div>
        <div class="form-row"><label class="form-label">模板类型</label><select class="form-input" id="agent-template-type" onchange="onAgentTemplateTypeChange()"><option value="dm">私信消息</option><option value="collab">合作邀约</option></select></div>
      </div>
      <div class="form-row" id="agent-template-product-row" style="display:none"><label class="form-label">默认合作产品</label><select class="form-input" id="agent-template-product">${productOptions}</select></div>
      <div class="form-row"><label class="form-label">内容变量：{{creator_name}} {{creator_handle}} {{shop_name}} {{product_name}} {{product_link}} {{sample_apply_link}}</label><textarea class="bd-note-ta" id="agent-template-content" style="min-height:100px" placeholder="输入模板内容"></textarea></div>
      <input type="hidden" id="agent-template-id">
      <div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn btn-primary" onclick="saveInvitationTemplate()">保存模板</button><button class="btn btn-outline" onclick="clearInvitationTemplateForm()">清空</button></div>
      <div class="agent-list">
        ${INVITE_TEMPLATES.map(t => `<div class="agent-row"><div><strong>${esc(t.name)}</strong><div class="agent-load">${t.type === 'collab' ? '合作邀约' : '私信消息'} · ${esc((t.content || '').slice(0, 80))}</div></div><div style="display:flex;gap:8px"><button class="btn btn-outline" onclick="editInvitationTemplate(${t.id})">编辑</button><button class="btn btn-ghost" onclick="deleteInvitationTemplate(${t.id})">停用</button></div></div>`).join('') || '<div class="empty-state">暂无模板</div>'}
      </div>
    </div>`;
}

function onAgentTemplateTypeChange() {
  const type = document.getElementById('agent-template-type')?.value || 'dm';
  const row = document.getElementById('agent-template-product-row');
  if (row) row.style.display = type === 'collab' ? '' : 'none';
}

function clearInvitationTemplateForm() {
  ['agent-template-id','agent-template-name','agent-template-content'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const type = document.getElementById('agent-template-type');
  if (type) type.value = 'dm';
  const product = document.getElementById('agent-template-product');
  if (product) product.value = '';
  onAgentTemplateTypeChange();
}

function editInvitationTemplate(id) {
  const tpl = INVITE_TEMPLATES.find(t => Number(t.id) === Number(id));
  if (!tpl) return;
  document.getElementById('agent-template-id').value = tpl.id;
  document.getElementById('agent-template-name').value = tpl.name || '';
  document.getElementById('agent-template-type').value = tpl.type || 'dm';
  document.getElementById('agent-template-content').value = tpl.content || '';
  const product = document.getElementById('agent-template-product');
  if (product) product.value = tpl.product_id || '';
  onAgentTemplateTypeChange();
}

async function saveInvitationTemplate() {
  const id = document.getElementById('agent-template-id')?.value || '';
  const body = {
    name: document.getElementById('agent-template-name')?.value.trim() || '',
    type: document.getElementById('agent-template-type')?.value || 'dm',
    product_id: document.getElementById('agent-template-product')?.value || null,
    channel: 'im',
    content: document.getElementById('agent-template-content')?.value.trim() || '',
  };
  if (!body.name || !body.content) return toast('请填写模板名称和内容');
  await api(id ? `/api/invitations/templates/${id}` : '/api/invitations/templates', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  });
  toast('模板已保存');
  clearInvitationTemplateForm();
  renderAgentCenter();
}

async function deleteInvitationTemplate(id) {
  await api(`/api/invitations/templates/${id}`, { method: 'DELETE' });
  toast('模板已停用');
  renderAgentCenter();
}

function workflowConfig() {
  return AGENT_WORKFLOW?.workflow?.config || {};
}

function selectedWorkflowProductIds() {
  if (WORKFLOW_PRODUCT_SELECTED.size) return [...WORKFLOW_PRODUCT_SELECTED].map(Number).filter(Boolean);
  return Array.from(document.querySelectorAll('.workflow-product-cb:checked')).map(el => Number(el.value)).filter(Boolean);
}

function selectedWorkflowBdIds() {
  if (WORKFLOW_BD_SELECTED.size) return [...WORKFLOW_BD_SELECTED].map(Number).filter(Boolean);
  return Array.from(document.querySelectorAll('.workflow-bd-cb:checked')).map(el => Number(el.value)).filter(Boolean);
}

function workflowPayloadFromForm() {
  const bdIds = selectedWorkflowBdIds();
  return {
    name: document.getElementById('workflow-name')?.value.trim() || '默认自动化工作流',
    config: {
      source: document.getElementById('workflow-source')?.value || 'shop_pool',
      shop: document.getElementById('workflow-shop')?.value || curStore,
      min_star: Number(document.getElementById('workflow-min-star')?.value || 0),
      min_fans: Number(document.getElementById('workflow-min-fans')?.value || 0),
      min_fulfillment: Number(document.getElementById('workflow-min-fulfillment')?.value || 0),
      min_avg_view: Number(document.getElementById('workflow-min-avg-view')?.value || 0),
      min_orders: Number(document.getElementById('workflow-min-orders')?.value || 0),
      category: document.getElementById('workflow-category')?.value.trim() || '',
      template_id: Number(document.getElementById('workflow-template')?.value || 0),
      product_ids: selectedWorkflowProductIds(),
      commission_rate: Number(document.getElementById('workflow-commission')?.value || 0),
      send_mode: document.getElementById('workflow-send-mode')?.value || 'manual',
      invite_max_per_creator: Number(document.getElementById('workflow-invite-max-per-creator')?.value || 1),
      invite_daily_limit: Number(document.getElementById('workflow-invite-daily-limit')?.value || 50),
      sample_approval_mode: document.getElementById('workflow-sample-approval')?.value || 'manual',
      audit_min_score: Number(document.getElementById('workflow-audit-score')?.value || 70),
      auto_approve_score: Number(document.getElementById('workflow-auto-score')?.value || 90),
      bd_ids: bdIds,
      assign_mode: bdIds.length > 1 ? 'round_robin' : 'least_load',
      auto_reply_template: document.getElementById('workflow-reply-template')?.value.trim() || '',
    },
  };
}

function workflowTaskStatusLabel(status) {
  return {
    agent_review: '待管理员确认',
    admin_approved: '已确认',
    admin_rejected: '已拒绝',
    awaiting_reply: '待达人回复',
    executed: '已执行',
    failed: '执行失败',
  }[status] || status || '-';
}

function workflowTaskTypeLabel(type) {
  return {
    invite: '自动邀约',
    sample_message: '确认拍摄消息',
    sample_audit: '样品审核',
  }[type] || type || '-';
}

function workflowRecommendationLabel(value) {
  return {
    auto_pass: 'Agent建议通过',
    review_pass: '建议通过，需确认',
    manual_review: '需人工判断',
    pending_reply: '待达人回复',
  }[value] || value || '-';
}

function workflowConditionLabel(task) {
  if (task.status === 'failed') return '执行失败';
  if (task.recommendation === 'pending_reply') return '待回复';
  return task.recommendation === 'auto_pass' ? '通过' : '未通过';
}

function workflowModalBodyHtml(config = {}, name = '自动化工作流', mode = 'create') {
  const shopOptions = SHOPS.map(s => `<option value="${s.id}" ${String(config.shop || curStore) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const templateOptions = INVITE_TEMPLATES.map(t => `<option value="${t.id}" ${Number(config.template_id) === Number(t.id) ? 'selected' : ''}>${esc(t.name)} · ${t.type === 'collab' ? '合作邀约' : '私信'}</option>`).join('');
  const selectedProducts = new Set((config.product_ids || []).map(Number));
  const selectedBds = new Set((config.bd_ids || []).map(Number));
  const bdOptions = BD_LIST.map(b => `
    <label class="workflow-bd-option">
      <input type="checkbox" class="workflow-bd-cb" value="${b.id}" ${selectedBds.has(Number(b.id)) ? 'checked' : ''} onchange="updateWorkflowBdSelection()">
      <span>${esc(b.name)}</span><em>当前 ${b.load || 0} 个</em>
    </label>`).join('');
  return `
    <div class="form-row"><label class="form-label">工作流名称</label><input class="form-input" id="workflow-name" value="${esc(name)}"></div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">达人来源</label><select class="form-input" id="workflow-source"><option value="shop_pool" ${config.source === 'shop_pool' ? 'selected' : ''}>联盟中心达人池</option><option value="library" ${config.source === 'library' ? 'selected' : ''}>合作达人库</option></select></div>
      <div class="form-row"><label class="form-label">店铺</label><select class="form-input" id="workflow-shop" onchange="onWorkflowShopChange(this.value)">${shopOptions}</select></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">邀约模板</label><select class="form-input" id="workflow-template">${templateOptions}</select></div>
      <div class="form-row"><label class="form-label">发送方式</label><select class="form-input" id="workflow-send-mode"><option value="manual" ${config.send_mode !== 'auto' ? 'selected' : ''}>手动邀约</option><option value="auto" ${config.send_mode === 'auto' ? 'selected' : ''}>自动发送</option></select></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">每位达人最多邀约次数</label><input class="form-input" id="workflow-invite-max-per-creator" type="number" min="1" value="${esc(config.invite_max_per_creator ?? 1)}"></div>
      <div class="form-row"><label class="form-label">每日邀约次数上限</label><input class="form-input" id="workflow-invite-daily-limit" type="number" min="1" value="${esc(config.invite_daily_limit ?? 50)}"></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">最低星级</label><input class="form-input" id="workflow-min-star" type="number" min="0" max="5" value="${esc(config.min_star ?? 0)}"></div>
      <div class="form-row"><label class="form-label">最低粉丝</label><input class="form-input" id="workflow-min-fans" type="number" min="0" value="${esc(config.min_fans ?? 1000)}"></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">最低履约率 %</label><input class="form-input" id="workflow-min-fulfillment" type="number" min="0" max="100" value="${esc(config.min_fulfillment ?? 0)}"></div>
      <div class="form-row"><label class="form-label">最低均播放</label><input class="form-input" id="workflow-min-avg-view" type="number" min="0" value="${esc(config.min_avg_view ?? 0)}"></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">最低近30天销量</label><input class="form-input" id="workflow-min-orders" type="number" min="0" value="${esc(config.min_orders ?? 0)}"></div>
      <div class="form-row"><label class="form-label">类目关键词</label><input class="form-input" id="workflow-category" value="${esc(config.category || '')}" placeholder="可留空"></div>
    </div>
    <div class="form-row-2">
      <div class="form-row"><label class="form-label">佣金比例 %</label><input class="form-input" id="workflow-commission" type="number" min="0" max="100" value="${esc(config.commission_rate ?? 15)}"></div>
      <div class="form-row"><label class="form-label">样品审批</label><select class="form-input" id="workflow-sample-approval"><option value="manual" ${config.sample_approval_mode !== 'auto' ? 'selected' : ''}>手动审批</option><option value="auto" ${config.sample_approval_mode === 'auto' ? 'selected' : ''}>自动审批</option></select></div>
    </div>
    <div class="form-row"><div class="module-meta">Agent自动审核规则：达人必须同时满足最低星级、最低粉丝、最低履约率、最低均播放、最低近30天销量和类目关键词条件，才会自动通过；选择“联盟中心达人池”时，近30天销量只使用 TK 联盟中心达人画像字段 sales_count_30d，包含其他商家商品，不读取合作达人库或本店联盟订单。</div></div>
    <div class="form-row"><label class="form-label">合作商品</label><div class="workflow-product-pick"><button class="btn btn-outline" type="button" id="workflow-product-button" onclick="openWorkflowProductModal()">选择商品</button><span class="invite-product-summary" id="workflow-product-summary"></span></div></div>
    <div class="form-row"><label class="form-label">参与分配 BD</label><div class="workflow-bd-select"><button class="form-input workflow-bd-trigger" type="button" onclick="toggleWorkflowBdDropdown()"><span id="workflow-bd-summary">请选择负责 BD</span><span>▾</span></button><div class="workflow-bd-menu" id="workflow-bd-menu">${bdOptions || '<div class="empty-state">暂无 BD 成员</div>'}</div></div><div class="module-meta" id="workflow-bd-mode">选择多位 BD 后将按顺序轮流分配</div></div>
    <div class="form-row"><label class="form-label">自动回复模板</label><textarea class="bd-note-ta" id="workflow-reply-template" style="min-height:70px">${esc(config.auto_reply_template || '')}</textarea></div>
    <button class="btn btn-primary" style="width:100%" onclick="saveWorkflowFromModal()">${mode === 'edit' ? '保存并重新运行工作流' : '保存并创建工作流'}</button>`;
}

function workflowSelectedProducts() {
  const selected = new Set([...WORKFLOW_PRODUCT_SELECTED].map(String));
  return INVITE_PRODUCTS.filter(p => selected.has(String(p.id)));
}

function renderWorkflowProductSummary() {
  const btn = document.getElementById('workflow-product-button');
  const summary = document.getElementById('workflow-product-summary');
  if (btn) btn.textContent = WORKFLOW_PRODUCT_SELECTED.size ? `已选 ${WORKFLOW_PRODUCT_SELECTED.size} 件商品` : '选择商品';
  if (summary) {
    const products = workflowSelectedProducts();
    const shopName = SHOPS.find(s => s.id === WORKFLOW_PRODUCT_SHOP)?.name || '未选择店铺';
    summary.textContent = products.length
      ? `${shopName} · ` + products.slice(0, 3).map(p => p.name).join(' / ') + (products.length > 3 ? ` 等 ${products.length} 件` : '')
      : '先选择店铺，再选择该店铺商品';
  }
}

function updateWorkflowBdSelection() {
  WORKFLOW_BD_SELECTED = new Set(Array.from(document.querySelectorAll('.workflow-bd-cb:checked')).map(el => String(el.value)));
  renderWorkflowBdSummary();
}

function renderWorkflowBdSummary() {
  const summary = document.getElementById('workflow-bd-summary');
  const mode = document.getElementById('workflow-bd-mode');
  const selected = BD_LIST.filter(b => WORKFLOW_BD_SELECTED.has(String(b.id)));
  if (summary) summary.textContent = selected.length ? selected.map(b => b.name).slice(0, 3).join('、') + (selected.length > 3 ? ` 等 ${selected.length} 位` : '') : '请选择负责 BD';
  if (mode) mode.textContent = selected.length > 1 ? '自动分配方式：轮流分配' : '选择多位 BD 后将按顺序轮流分配';
}

function toggleWorkflowBdDropdown() {
  document.getElementById('workflow-bd-menu')?.classList.toggle('show');
}

async function openWorkflowProductModal() {
  PRODUCT_PICKER_CONTEXT = 'workflow';
  const select = document.getElementById('invite-product-shop');
  WORKFLOW_PRODUCT_SHOP = WORKFLOW_PRODUCT_SHOP || document.getElementById('workflow-shop')?.value || (curStore === 'all' ? (SHOPS[0]?.id || '') : curStore);
  if (select) {
    select.innerHTML = SHOPS.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    select.value = WORKFLOW_PRODUCT_SHOP;
    const row = select.closest('.form-row');
    if (row) row.style.display = 'none';
  }
  INVITE_PRODUCTS = WORKFLOW_PRODUCT_SHOP ? await api(`/api/products?shop=${WORKFLOW_PRODUCT_SHOP}`).catch(() => []) : [];
  const available = new Set(INVITE_PRODUCTS.map(p => String(p.id)));
  WORKFLOW_PRODUCT_SELECTED = new Set([...WORKFLOW_PRODUCT_SELECTED].filter(id => available.has(String(id))));
  renderInviteProductModalList();
  const modal = document.getElementById('m-invite-products');
  if (modal) {
    modal.style.zIndex = '130';
    modal.classList.add('show');
  }
}

async function onWorkflowShopChange(shop) {
  WORKFLOW_PRODUCT_SHOP = shop;
  WORKFLOW_PRODUCT_SELECTED.clear();
  INVITE_PRODUCTS = shop ? await api(`/api/products?shop=${shop}`).catch(() => []) : [];
  renderWorkflowProductSummary();
}

async function openWorkflowModal() {
  editingWorkflowId = null;
  if (!INVITE_TEMPLATES.length || !INVITE_PRODUCTS.length || !BD_LIST.length) {
    const productShop = curStore === 'all' ? (SHOPS[0]?.id || '') : curStore;
    [INVITE_TEMPLATES, INVITE_PRODUCTS, BD_LIST] = await Promise.all([
      api('/api/invitations/templates').catch(() => []),
      productShop ? api(`/api/products?shop=${productShop}`).catch(() => []) : Promise.resolve([]),
      api('/api/bd').catch(() => []),
    ]);
  }
  const config = workflowConfig();
  WORKFLOW_PRODUCT_SHOP = config.shop || (curStore === 'all' ? (SHOPS[0]?.id || '') : curStore);
  INVITE_PRODUCTS = WORKFLOW_PRODUCT_SHOP ? await api(`/api/products?shop=${WORKFLOW_PRODUCT_SHOP}`).catch(() => []) : [];
  WORKFLOW_PRODUCT_SELECTED = new Set((config.product_ids || []).map(String));
  WORKFLOW_BD_SELECTED = new Set((config.bd_ids || []).map(String));
  document.getElementById('m-workflow-body').innerHTML = workflowModalBodyHtml(config, `自动化工作流 ${new Date().toLocaleString()}`);
  renderWorkflowProductSummary();
  renderWorkflowBdSummary();
  document.getElementById('m-workflow').classList.add('show');
}

async function openEditWorkflowModal(id) {
  editingWorkflowId = Number(id);
  const data = await api(`/api/agent/workflow?id=${id}`);
  const workflow = data.workflow || {};
  const productShop = workflow.config?.shop || (curStore === 'all' ? (SHOPS[0]?.id || '') : curStore);
  [INVITE_TEMPLATES, INVITE_PRODUCTS, BD_LIST] = await Promise.all([
    api('/api/invitations/templates').catch(() => []),
    productShop ? api(`/api/products?shop=${productShop}`).catch(() => []) : Promise.resolve([]),
    api('/api/bd').catch(() => []),
  ]);
  WORKFLOW_PRODUCT_SHOP = productShop;
  WORKFLOW_PRODUCT_SELECTED = new Set((workflow.config?.product_ids || []).map(String));
  WORKFLOW_BD_SELECTED = new Set((workflow.config?.bd_ids || []).map(String));
  document.getElementById('m-workflow-body').innerHTML = workflowModalBodyHtml(workflow.config || {}, workflow.name || '自动化工作流', 'edit');
  renderWorkflowProductSummary();
  renderWorkflowBdSummary();
  document.getElementById('m-workflow').classList.add('show');
}

async function saveWorkflowFromModal() {
  const body = workflowPayloadFromForm();
  const saved = editingWorkflowId
    ? await api('/api/agent/workflow', { method: 'PUT', body: JSON.stringify({ id: editingWorkflowId, ...body }) })
    : (await api('/api/agent/workflows', { method: 'POST', body: JSON.stringify(body) })).workflow;
  closeModal('m-workflow');
  toast(editingWorkflowId ? '工作流已更新，正在重新生成队列' : '工作流已创建');
  selectedWorkflowId = saved.id;
  editingWorkflowId = null;
  await generateWorkflowQueueFor(saved.id, { autoExecute: body.config.send_mode === 'auto', reset: true });
}

function automationWorkflowBlocks(workflow, tasks = []) {
  const inviteCount = tasks.filter(t => t.task_type === 'invite').length;
  const awaitingReply = tasks.filter(t => t.task_type === 'sample_message' && t.status === 'awaiting_reply').length;
  const review = tasks.filter(t => t.task_type === 'sample_audit' && t.status === 'agent_review').length;
  const approved = tasks.filter(t => t.status === 'admin_approved').length;
  const executed = tasks.filter(t => t.status === 'executed').length;
  return `
    <div class="automation-flow">
      <div class="automation-step"><b>自动邀约</b><span>${esc(workflow?.name || '未选择工作流')} · 邀约达人 ${inviteCount} 位</span></div>
      <div class="automation-step"><b>样品申请列表</b><span>待回复 ${awaitingReply} 条</span></div>
      <div class="automation-step"><b>Agent判断</b><span>生成审核待确认 ${review} 条</span></div>
      <div class="automation-step"><b>管理员确认</b><span>已确认 ${approved} 条</span></div>
      <div class="automation-step"><b>自动分配</b><span>已执行 ${executed} 条</span></div>
    </div>`;
}

function workflowEmptyHint(workflow, config = {}, diagnostics = null) {
  if (!workflow) return '';
  if (diagnostics?.source === 'affiliate_center') {
    const pool = diagnostics.pool || {};
    if (pool.requires_sync) {
      return `<div class="empty-hint">当前工作流没有生成邀约达人。联盟中心达人池或近30天销量尚未同步：当前店铺达人池 ${esc(pool.total || 0)} 人，已同步近30天销量 ${esc(pool.with_sales_30d || 0)} 人。请先同步联盟中心达人池，或等待分批补齐 Performance 详情。</div>`;
    }
    return `<div class="empty-hint">当前工作流没有生成邀约达人。当前店铺联盟中心达人池 ${esc(pool.total || 0)} 人，其中已同步近30天销量 ${esc(pool.with_sales_30d || 0)} 人；本工作流要求近30天销量 >= ${esc(config.min_orders ?? 0)}、最低粉丝 ${esc(config.min_fans ?? 0)}、最低履约率 ${esc(config.min_fulfillment ?? 0)}%、最低均播放 ${esc(config.min_avg_view ?? 0)}。请降低条件或继续分批同步更多达人 Performance 详情后再生成队列。</div>`;
  }
  return `<div class="empty-hint">当前工作流没有生成邀约达人。可能原因：最低近30天销量 ${esc(config.min_orders ?? 0)}、最低粉丝 ${esc(config.min_fans ?? 0)}、星级/履约率/类目筛选过严，或达人已达到每人邀约上限 ${esc(config.invite_max_per_creator ?? 1)} 次。调整条件后点击“生成队列”。</div>`;
}

function workflowTaskRows(tasks) {
  return tasks.map(t => `
    <tr>
      <td>${workflowTaskTypeLabel(t.task_type)}</td>
      <td><div class="cn">${esc(t.creator_name || t.uid)}</div><div class="cm">${esc(t.creator_handle || t.uid || '')}</div></td>
      <td>${t.shop_id ? shopTagHtml(t.shop_id) : '-'}</td>
      <td>${workflowConditionLabel(t)}</td>
      <td>${workflowRecommendationLabel(t.recommendation)}<div class="agent-load">${esc(t.reason || '')}</div></td>
      <td>${workflowTaskStatusLabel(t.status)}</td>
      <td>
        ${['agent_review','admin_approved'].includes(t.status) ? `<div class="abtns"><button class="abtn ok" onclick="confirmWorkflowTask(${t.id}, 'approve')">确认</button><button class="abtn ng" onclick="confirmWorkflowTask(${t.id}, 'reject')">拒绝</button></div>` : ''}
        ${t.task_type === 'sample_message' && t.status === 'awaiting_reply' ? `<button class="btn btn-outline" onclick="recordWorkflowReply(${t.id})">录入回复</button>` : ''}
        ${t.invitation_record_id ? `<div class="agent-load">邀约#${t.invitation_record_id}</div>` : ''}
        ${t.assigned_bd_name ? `<div class="agent-load">BD：${esc(t.assigned_bd_name)}</div>` : ''}
      </td>
    </tr>`).join('');
}

async function renderAutomationCenter() {
  const box = document.getElementById('automation-center');
  if (!box) return;
  const productShop = curStore === 'all' ? (SHOPS[0]?.id || '') : curStore;
  const [workflowList, templates, products, bdList] = await Promise.all([
    api('/api/agent/workflows').catch(() => ({ workflows: [] })),
    api('/api/invitations/templates').catch(() => []),
    productShop ? api(`/api/products?shop=${productShop}`).catch(() => []) : Promise.resolve([]),
    api('/api/bd').catch(() => BD_LIST),
  ]);
  AGENT_WORKFLOWS = workflowList.workflows || [];
  if (selectedWorkflowId && !AGENT_WORKFLOWS.some(w => Number(w.id) === Number(selectedWorkflowId))) {
    selectedWorkflowId = null;
  }
  INVITE_TEMPLATES = templates;
  INVITE_PRODUCTS = products;
  BD_LIST = bdList;
  const selectedWorkflow = selectedWorkflowId
    ? AGENT_WORKFLOWS.find(w => Number(w.id) === Number(selectedWorkflowId))
    : null;
  const selectedDetail = selectedWorkflow
    ? await api(`/api/agent/workflow?id=${selectedWorkflow.id}`).catch(() => null)
    : null;
  const selectedConfig = selectedWorkflow?.config || {};
  const selectedDiagnostics = selectedDetail?.diagnostics || null;
  const selectedTasks = selectedWorkflow ? (selectedDetail?.tasks || []).map(t => ({ ...t, workflow_name: selectedWorkflow?.name || '' })) : [];
  const inviteTasks = selectedTasks.filter(t => t.task_type === 'invite');
  const messageTasks = selectedTasks.filter(t => t.task_type === 'sample_message');
  const sampleTasks = selectedTasks.filter(t => t.task_type === 'sample_audit');
  const emptyInviteHint = selectedWorkflow && !inviteTasks.length
    ? workflowEmptyHint(selectedWorkflow, selectedConfig, selectedDiagnostics)
    : '';
  const sendHint = selectedWorkflow && inviteTasks.length && !inviteTasks.some(t => t.invitation_record_id)
    ? `<div class="empty-hint">已有 ${inviteTasks.length} 位邀约达人，但尚未执行。店铺后台只有在“执行已确认”并成功创建合作邀约后才会显示记录。</div>`
    : '';
  const pageMeta = paginate(selectedTasks, automationPage, automationPageSize);
  automationPage = pageMeta.page;
  const workflowCards = AGENT_WORKFLOWS.map(w => `
    <div class="module-panel workflow-card ${Number(w.id) === Number(selectedWorkflowId) ? 'active' : ''}" onclick="selectWorkflow(${w.id})">
      <h3>${esc(w.name)}</h3>
      <div class="module-meta">任务 ${w.task_count || 0} · 待确认 ${w.review_count || 0} · 已确认 ${w.approved_count || 0} · 已执行 ${w.executed_count || 0}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn btn-outline" onclick="event.stopPropagation();openEditWorkflowModal(${w.id})">编辑</button><button class="btn btn-outline" onclick="event.stopPropagation();generateWorkflowQueueFor(${w.id})">生成队列</button><button class="btn btn-primary" onclick="event.stopPropagation();executeWorkflowFor(${w.id})">执行已确认</button></div>
    </div>`).join('');
  if (!selectedWorkflow) {
    box.innerHTML = `
      <div class="module-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
          <div><h3 style="margin-bottom:4px">工作流清单</h3><div class="module-meta">点击工作流查看对应自动化工作状态、邀约达人清单和审核状态</div></div>
          <button class="btn btn-primary" onclick="openWorkflowModal()">新增自动化工作流任务</button>
        </div>
        <div class="module-grid">${workflowCards || '<div class="module-panel"><h3>暂无工作流</h3><div class="module-meta">点击右上角新增自动化工作流任务</div></div>'}</div>
      </div>`;
    return;
  }
  box.innerHTML = `
    <div style="margin-bottom:12px"><button class="btn btn-outline" onclick="backToWorkflowList()">返回工作流清单</button></div>
    ${automationWorkflowBlocks(selectedWorkflow, selectedTasks)}
    <div class="module-panel">
      <h3>${esc(selectedWorkflow.name)} 自动化工作状态</h3>
      <div class="module-meta" style="margin-bottom:12px">邀约达人 ${inviteTasks.length} 位 · 确认消息 ${messageTasks.length} 条 · 待回复 ${messageTasks.filter(t => t.status === 'awaiting_reply').length} 条 · 审核待确认 ${sampleTasks.filter(t => t.status === 'agent_review').length} 条 · 已确认 ${selectedTasks.filter(t => t.status === 'admin_approved').length} 条 · 已执行 ${selectedTasks.filter(t => t.status === 'executed').length} 条</div>
      ${emptyInviteHint || sendHint}
      <div class="table-wrap"><table><thead><tr><th>类型</th><th>达人</th><th>店铺</th><th>条件审核</th><th>Agent结果</th><th>状态</th><th>操作</th></tr></thead><tbody>${workflowTaskRows(pageMeta.items) || '<tr><td colspan="7"><div class="empty-state">暂无工作流任务</div></td></tr>'}</tbody></table><div class="pager">${pagerHtml('automation', pageMeta)}</div></div>
    </div>`;
}

function selectWorkflow(id) {
  selectedWorkflowId = Number(id);
  automationPage = 1;
  renderAutomationCenter();
}

function backToWorkflowList() {
  selectedWorkflowId = null;
  automationPage = 1;
  renderAutomationCenter();
}

async function generateWorkflowQueueFor(id, options = {}) {
  selectedWorkflowId = Number(id);
  toast('正在生成工作流队列...');
  const result = await api(`/api/agent/workflows/${id}/queue`, { method: 'POST', body: JSON.stringify({ reset: Boolean(options.reset) }) });
  const shouldAutoExecute = options.autoExecute || result.workflow?.config?.send_mode === 'auto';
  if (shouldAutoExecute) {
    const hasExecutable = (result.tasks || []).some(t => ['invite','sample_message'].includes(t.task_type) && t.status === 'admin_approved');
    if (hasExecutable) {
      await api(`/api/agent/workflows/${id}/execute`, { method: 'POST', body: JSON.stringify({}) });
      toast('队列已生成并自动执行');
    } else {
      toast('队列已生成，但没有可自动发送的邀约达人');
    }
  } else {
    toast('队列已生成');
  }
  renderAutomationCenter();
}

async function executeWorkflowFor(id) {
  selectedWorkflowId = Number(id);
  toast('正在执行已确认任务...');
  const result = await api(`/api/agent/workflows/${id}/execute`, { method: 'POST', body: JSON.stringify({}) });
  toast(`执行完成：邀约 ${result.invite_results?.length || 0} 条，确认消息 ${result.sample_message_results?.length || 0} 条，分配样品 ${result.assigned_samples || 0} 条`);
  renderAutomationCenter();
}

async function recordWorkflowReply(id) {
  const text = prompt('请输入达人回复内容');
  if (!text) return;
  const result = await api(`/api/agent/workflow/tasks/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply_text: text }) });
  toast(result.audit?.recommendation === 'auto_pass' ? '模型判断可合作，已生成审核待确认' : '模型判断不可自动通过，已保留为需跟进');
  renderAutomationCenter();
}

function workflowPanelHtml() {
  const config = workflowConfig();
  const workflow = AGENT_WORKFLOW?.workflow || {};
  const tasks = AGENT_WORKFLOW?.tasks || [];
  const shopOptions = ['all', ...SHOPS.map(s => s.id)].map(id => {
    const label = id === 'all' ? '全部店铺' : shopInfo(id).name;
    return `<option value="${id}" ${String(config.shop || curStore) === String(id) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const templateOptions = INVITE_TEMPLATES.map(t => `<option value="${t.id}" ${Number(config.template_id) === Number(t.id) ? 'selected' : ''}>${esc(t.name)} · ${t.type === 'collab' ? '合作邀约' : '私信'}</option>`).join('');
  const selectedProducts = new Set((config.product_ids || []).map(Number));
  const productList = INVITE_PRODUCTS.map(p => `
    <label class="agent-check">
      <input type="checkbox" class="workflow-product-cb" value="${p.id}" ${selectedProducts.has(Number(p.id)) ? 'checked' : ''}>
      <span>${productThumbHtml(p, 26)}</span><span>${esc(p.name)}</span>
    </label>
  `).join('') || '<div class="empty-state">当前店铺暂无商品，请先同步商品或切换店铺</div>';
  const selectedBds = new Set((config.bd_ids || []).map(Number));
  const bdList = BD_LIST.map(b => `
    <label class="agent-check">
      <input type="checkbox" class="workflow-bd-cb" value="${b.id}" ${selectedBds.has(Number(b.id)) ? 'checked' : ''}>
      <span>${esc(b.name)}</span><span class="agent-load">当前 ${b.load || 0} 个</span>
    </label>
  `).join('') || '<div class="empty-state">暂无 BD 成员</div>';
  const rows = tasks.map(t => `
    <tr>
      <td>${workflowTaskTypeLabel(t.task_type)}</td>
      <td><div class="cn">${esc(t.creator_name || t.uid)}</div><div class="cm">${esc(t.creator_handle || t.uid || '')}</div></td>
      <td>${t.shop_id ? shopTagHtml(t.shop_id) : '-'}</td>
      <td>${workflowConditionLabel(t)}</td>
      <td>${workflowRecommendationLabel(t.recommendation)}<div class="agent-load">${esc(t.reason || '')}</div></td>
      <td>${workflowTaskStatusLabel(t.status)}</td>
      <td>
        ${['agent_review','admin_approved'].includes(t.status) ? `<div class="abtns"><button class="abtn ok" onclick="confirmWorkflowTask(${t.id}, 'approve')">确认</button><button class="abtn ng" onclick="confirmWorkflowTask(${t.id}, 'reject')">拒绝</button></div>` : ''}
        ${t.task_type === 'sample_message' && t.status === 'awaiting_reply' ? `<button class="btn btn-outline" onclick="recordWorkflowReply(${t.id})">录入回复</button>` : ''}
        ${t.invitation_record_id ? `<div class="agent-load">邀约#${t.invitation_record_id}</div>` : ''}
        ${t.assigned_bd_name ? `<div class="agent-load">BD：${esc(t.assigned_bd_name)}</div>` : ''}
      </td>
    </tr>
  `).join('');
  const reviewCount = tasks.filter(t => t.status === 'agent_review').length;
  const approvedCount = tasks.filter(t => t.status === 'admin_approved').length;
  const executedCount = tasks.filter(t => t.status === 'executed').length;
  return `
    <div class="module-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div><h3 style="margin-bottom:4px">自动化工作流</h3><div class="module-meta">筛选 → 自动邀约 → 样品申请 → Agent规则审核 → 管理员确认 → 自动分配BD → 跟进</div></div>
        <div style="display:flex;gap:8px"><button class="btn btn-outline" onclick="saveWorkflowConfig()">保存配置</button><button class="btn btn-primary" onclick="generateWorkflowQueue()">生成队列</button><button class="btn btn-primary" onclick="executeWorkflow()">执行已确认</button></div>
      </div>
      <div class="module-grid">
        <div class="module-panel"><h3>待确认</h3><div class="module-num">${reviewCount}</div><div class="module-meta">Agent 已完成预审</div></div>
        <div class="module-panel"><h3>可执行</h3><div class="module-num">${approvedCount}</div><div class="module-meta">管理员已确认</div></div>
        <div class="module-panel"><h3>已执行</h3><div class="module-num">${executedCount}</div><div class="module-meta">邀约或分配完成</div></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">工作流名称</label><input class="form-input" id="workflow-name" value="${esc(workflow.name || '默认自动化工作流')}"></div>
        <div class="form-row"><label class="form-label">达人来源</label><select class="form-input" id="workflow-source"><option value="shop_pool" ${config.source === 'shop_pool' ? 'selected' : ''}>联盟中心达人池</option><option value="library" ${config.source === 'library' ? 'selected' : ''}>合作达人库</option></select></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">店铺</label><select class="form-input" id="workflow-shop">${shopOptions}</select></div>
        <div class="form-row"><label class="form-label">邀约模板</label><select class="form-input" id="workflow-template">${templateOptions}</select></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">最低星级</label><input class="form-input" id="workflow-min-star" type="number" min="0" max="5" value="${esc(config.min_star ?? 0)}"></div>
        <div class="form-row"><label class="form-label">最低粉丝</label><input class="form-input" id="workflow-min-fans" type="number" min="0" value="${esc(config.min_fans ?? 1000)}"></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">最低履约率 %</label><input class="form-input" id="workflow-min-fulfillment" type="number" min="0" max="100" value="${esc(config.min_fulfillment ?? 0)}"></div>
        <div class="form-row"><label class="form-label">最低均播放</label><input class="form-input" id="workflow-min-avg-view" type="number" min="0" value="${esc(config.min_avg_view ?? 0)}"></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">最低近30天销量</label><input class="form-input" id="workflow-min-orders" type="number" min="0" value="${esc(config.min_orders ?? 0)}"></div>
        <div class="form-row"><label class="form-label">类目关键词</label><input class="form-input" id="workflow-category" value="${esc(config.category || '')}" placeholder="可留空"></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">佣金比例 %</label><input class="form-input" id="workflow-commission" type="number" min="0" max="100" value="${esc(config.commission_rate ?? 15)}"></div>
        <div class="form-row"><label class="form-label">发送方式</label><select class="form-input" id="workflow-send-mode"><option value="manual" ${config.send_mode !== 'auto' ? 'selected' : ''}>手动邀约</option><option value="auto" ${config.send_mode === 'auto' ? 'selected' : ''}>自动发送</option></select></div>
      </div>
      <div class="form-row-2">
        <div class="form-row"><label class="form-label">样品审批</label><select class="form-input" id="workflow-sample-approval"><option value="manual" ${config.sample_approval_mode !== 'auto' ? 'selected' : ''}>手动审批</option><option value="auto" ${config.sample_approval_mode === 'auto' ? 'selected' : ''}>自动审批</option></select></div>
        <div class="form-row"><label class="form-label">Agent自动审核</label><div class="module-meta">同时满足上方全部筛选条件才自动通过，否则进入人工确认。</div></div>
      </div>
      <div class="form-row"><label class="form-label">合作商品</label><div class="agent-check-grid">${productList}</div></div>
      <div class="form-row"><label class="form-label">参与分配 BD</label><div class="agent-check-grid">${bdList}</div></div>
      <div class="form-row"><label class="form-label">自动回复模板</label><textarea class="bd-note-ta" id="workflow-reply-template" style="min-height:70px">${esc(config.auto_reply_template || '')}</textarea></div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>类型</th><th>达人</th><th>店铺</th><th>条件审核</th><th>Agent结果</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7"><div class="empty-state">暂无工作流任务，请先生成队列</div></td></tr>'}</tbody></table></div>
    </div>`;
}

async function saveWorkflowConfig() {
  AGENT_WORKFLOW = { ...(AGENT_WORKFLOW || {}), workflow: await api('/api/agent/workflow', { method: 'PUT', body: JSON.stringify(workflowPayloadFromForm()) }) };
  toast('工作流配置已保存');
  renderAgentCenter();
}

async function generateWorkflowQueue() {
  toast('正在生成 Agent 工作流队列...');
  AGENT_WORKFLOW = await api('/api/agent/workflow/queue', { method: 'POST', body: JSON.stringify(workflowPayloadFromForm()) });
  toast(`队列已生成：邀约 ${AGENT_WORKFLOW.invite_count || 0} 条，样品审核 ${AGENT_WORKFLOW.sample_count || 0} 条`);
  renderAgentCenter();
}

async function confirmWorkflowTask(id, decision) {
  AGENT_WORKFLOW = await api(`/api/agent/workflow/tasks/${id}/confirm`, { method: 'POST', body: JSON.stringify({ decision }) });
  toast(decision === 'reject' ? '任务已拒绝' : '任务已确认');
  if (curPage === 'automation') renderAutomationCenter();
  else renderAgentCenter();
}

async function executeWorkflow() {
  toast('正在执行已确认任务...');
  AGENT_WORKFLOW = await api('/api/agent/workflow/execute', { method: 'POST', body: JSON.stringify({}) });
  toast(`执行完成：邀约 ${AGENT_WORKFLOW.invite_results?.length || 0} 条，分配样品 ${AGENT_WORKFLOW.assigned_samples || 0} 条`);
  renderAgentCenter();
}
async function renderAgentCenter() {
  const box = document.getElementById('agent-center');
  if (!box) return;
  const fallbackAuth = {
    app_key: '6kbsksu5gsfaf',
    redirect_uri: 'https://aojimiya123.top/tk/api/tiktok/oauth/callback',
    shops: SHOPS.map(shop => ({
      ...shop,
      authorized: false,
      has_access_token: false,
      has_refresh_token: false,
      has_shop_cipher: false,
      last_sync_at: '',
      last_sync_message: '后端授权状态接口尚未加载，请重启系统后刷新',
      auth_url: ''
    }))
  };
  const [bdList, auth, settings] = await Promise.all([
    api('/api/bd').catch(() => BD_LIST),
    api('/api/tiktok/auth/status').catch(() => fallbackAuth),
    api('/api/agent/settings').catch(() => AGENT_SETTINGS || {}),
  ]);
  BD_LIST = bdList;
  AGENT_SETTINGS = settings;
  const productShop = curStore === 'all' ? (SHOPS[0]?.id || '') : curStore;
  [INVITE_TEMPLATES, INVITE_PRODUCTS] = await Promise.all([
    api('/api/invitations/templates').catch(() => []),
    productShop ? api(`/api/products?shop=${productShop}`).catch(() => []) : Promise.resolve([]),
  ]);
  const totalLoad = BD_LIST.reduce((sum, b) => sum + Number(b.load || 0), 0);
  const maxLoad = Math.max(...BD_LIST.map(b => Number(b.load || 0)), 0);
  const avgLoad = BD_LIST.length ? Math.round(totalLoad / BD_LIST.length) : 0;
  box.innerHTML = `
    <div class="module-grid">
      <div class="module-panel"><h3>BD 成员</h3><div class="module-num">${BD_LIST.length}</div><div class="module-meta">当前启用成员</div></div>
      <div class="module-panel"><h3>跟进达人</h3><div class="module-num">${totalLoad}</div><div class="module-meta">按 UID 去重统计</div></div>
      <div class="module-panel"><h3>平均负载</h3><div class="module-num">${avgLoad}</div><div class="module-meta">每位 BD 当前负责达人</div></div>
    </div>
    <div class="module-panel">
      <h3>TikTok Shop 授权</h3>
      <div class="module-meta" style="margin-bottom:10px">Redirect URI：${auth.redirect_uri}</div>
      <div class="agent-list">
        ${auth.shops.map(shop => `
          <div class="agent-row">
            <div>
              <strong>${shop.name}</strong>
              <div class="agent-load">
                Access Token：${shop.has_access_token ? '已保存' : '缺失'} ·
                Refresh Token：${shop.has_refresh_token ? '已保存' : '缺失'} ·
                shop_cipher：${shop.has_shop_cipher ? '已保存' : '缺失'}
              </div>
              <div class="agent-load">上次同步：${shop.last_sync_at || '-'} ${shop.last_sync_message || ''}</div>
            </div>
            <button class="btn ${shop.authorized ? 'btn-outline' : 'btn-primary'}" onclick="openTikTokAuth('${shop.id}')">
              ${shop.authorized ? '重新授权' : '去授权'}
            </button>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="agent-grid">
      <div class="agent-list">
        ${BD_LIST.map(b => `
          <div class="agent-row">
            <div><strong>${b.name}</strong><div class="agent-load">系统员工 · 负责 ${b.load || 0} 个达人 · 企微 ${b.wecom_userid || '未配置'}</div></div>
            <span class="shop-tag st-both">${maxLoad && b.load === maxLoad ? '高负载' : '正常'}</span>
          </div>
        `).join('') || '<div class="empty-state">暂无 BD 成员</div>'}
      </div>
      <div class="module-panel">
        <h3>Agent 任务流</h3>
        <div class="workflow">
          <div class="step"><b>自动邀约</b><span>按达人画像、店铺类目和每日上限生成邀约任务</span></div>
          <div class="step"><b>自动审核</b><span>按粉丝量、履约率、内容数据和合作规则给出审核建议</span></div>
          <div class="step"><b>自动分配</b><span>按店铺、达人类型、BD 负载和历史合作经验分配负责人</span></div>
          <div class="step"><b>BD跟进</b><span>围绕样品寄出、视频发布和超时未回复触发跟进提醒</span></div>
        </div>
      </div>
    </div>
    ${agentTemplateManagerHtml()}
    <div class="agent-config-grid">
      <div class="module-panel">
        <h3>话术模板</h3>
        <div class="form-row"><label class="form-label">自动邀约话术</label><textarea class="bd-note-ta" id="agent-invite-template">${esc(settings.invite_template || '')}</textarea></div>
        <div class="form-row"><label class="form-label">BD 跟进话术</label><textarea class="bd-note-ta" id="agent-followup-template">${esc(settings.followup_template || '')}</textarea></div>
      </div>
      <div class="module-panel">
        <h3>复盘规则</h3>
        <div class="form-row"><label class="form-label">复盘口径</label><textarea class="bd-note-ta" id="agent-review-rules">${esc(settings.review_rules || '')}</textarea></div>
        <div class="form-row-2">
          <div class="form-row"><label class="form-label">邀约每日上限</label><input class="form-input" id="agent-invite-limit" type="number" min="1" value="${esc(settings.invite_daily_limit ?? 50)}"></div>
          <div class="form-row"><label class="form-label">跟进间隔（天）</label><input class="form-input" id="agent-followup-days" type="number" min="1" value="${esc(settings.followup_interval_days ?? 3)}"></div>
        </div>
        <div class="form-row-2">
          <div class="form-row"><label class="form-label">自动审核最低粉丝</label><input class="form-input" id="agent-min-followers" type="number" min="0" value="${esc(settings.audit_min_followers ?? 1000)}"></div>
          <div class="form-row"><label class="form-label">最低履约率（%）</label><input class="form-input" id="agent-min-fulfillment" type="number" min="0" max="100" value="${esc(settings.audit_min_fulfillment ?? 80)}"></div>
        </div>
        <div class="form-row"><label class="form-label">自动分配策略</label><textarea class="bd-note-ta" id="agent-assign-strategy">${esc(settings.assign_strategy || '')}</textarea></div>
        <button class="btn btn-primary" onclick="saveAgentSettings()">保存 Agent 配置</button>
      </div>
    </div>`;
}

async function saveAgentSettings() {
  const payload = {
    invite_template: document.getElementById('agent-invite-template')?.value || '',
    followup_template: document.getElementById('agent-followup-template')?.value || '',
    review_rules: document.getElementById('agent-review-rules')?.value || '',
    invite_daily_limit: document.getElementById('agent-invite-limit')?.value || 50,
    audit_min_followers: document.getElementById('agent-min-followers')?.value || 0,
    audit_min_fulfillment: document.getElementById('agent-min-fulfillment')?.value || 0,
    assign_strategy: document.getElementById('agent-assign-strategy')?.value || '',
    followup_interval_days: document.getElementById('agent-followup-days')?.value || 1,
  };
  AGENT_SETTINGS = await api('/api/agent/settings', { method: 'PUT', body: JSON.stringify(payload) });
  toast('Agent 配置已保存');
  renderAgentCenter();
}
async function openTikTokAuth(shopId) {
  try {
    const data = await api(`/api/tiktok/oauth/url?shop=${shopId}`);
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    toast('请先重启系统，并确认 .env 已配置 TK_SERVICE_ID');
  }
}
function openAddBDModal() {
  toast('BD 名单已改为同步系统员工，请在员工管理里维护名单');
}
async function submitNewBD() {
  toast('BD 名单已改为同步系统员工，请在员工管理里维护名单');
}
async function syncBDMembers() {
  await loadShopsAndBD();
  populateBDFilter();
  if (curPage === 'agent') renderAgentCenter();
  if (curPage === 'automation') renderAutomationCenter();
  if (curPage === 'lib') renderLibPage();
  if (curPage === 'sample') renderSamplePage();
  toast('✅ BD 名单已同步为系统员工名单');
}

// ════ TOAST ════
function toast(msg) {
  const el = document.getElementById('toast-el');
  document.getElementById('toast-msg').textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

async function refreshAll() {
  await loadShopsAndBD();
  if (curPage === 'invite') renderInviteCenter();
  if (curPage === 'sample') renderSamplePage();
  if (curPage === 'lib') renderLibPage();
  if (curPage === 'data') renderDataCenter();
  if (curPage === 'agent') renderAgentCenter();
}

function syncFailureAdvice(message = '', status = '') {
  const text = String(message || '').toLowerCase();
  if (status === 'skipped' || text.includes('未配置') || text.includes('token')) {
    return '检查店铺授权状态，重新授权店铺；确认 access_token、refresh_token 和 shop_cipher 已保存。';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'TikTok 接口超时。稍后重试同步；如果连续失败，减少同步范围或分开同步商品、联盟订单、样品申请。';
  }
  if (text.includes('too many requests') || text.includes('rate limit')) {
    return 'TikTok 接口限流。等待 3-10 分钟后重试；避免连续多次点击同步。';
  }
  if (text.includes('expired') || text.includes('auth') || text.includes('credential')) {
    return '授权可能过期。请在 BD-Agent 中重新授权店铺，然后再次同步。';
  }
  if (text.includes('internal error')) {
    return 'TikTok 服务端异常。稍后重试；如果多次出现，保留失败时间和错误信息再排查接口。';
  }
  return '请先重试一次；若仍失败，检查店铺授权、TikTok API 配置和最近同步日志。';
}

function syncMetric(label, value, suffix = '') {
  return `<div><span>${esc(label)}</span><b>${esc(value ?? 0)}${esc(suffix)}</b></div>`;
}

function syncShopDetailHtml(row) {
  const detail = row.detail || {};
  const products = detail.products || {};
  const orders = detail.orders || {};
  const affiliateOrders = detail.affiliateOrders || {};
  const affiliateCreators = detail.affiliateCreators || {};
  const samples = detail.samples || {};
  if (row.status !== 'success') return '';
  return `
    <div class="sync-detail-grid">
      ${syncMetric('商品', products.total || 0, ' 条')}
      ${syncMetric('订单', orders.total || 0, ' 条')}
      ${syncMetric('联盟订单', affiliateOrders.lines || 0, ' 行')}
      ${syncMetric('样品申请', samples.total || 0, ' 条')}
      ${syncMetric('联盟达人池', affiliateCreators.total || 0, ' 人')}
      ${syncMetric('近30天销量达人', affiliateCreators.with_sales_30d || 0, ' 人')}
      ${syncMetric('样品新增', samples.created || 0, ' 条')}
      ${syncMetric('样品更新', samples.updated || 0, ' 条')}
    </div>
  `;
}

function showSyncResult(result, caughtError = null) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const success = rows.filter(r => r.status === 'success').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const skipped = rows.filter(r => r.status === 'skipped').length;
  const sampleTotal = rows.reduce((sum, r) => sum + Number(r.detail?.samples?.total || 0), 0);
  const body = document.getElementById('m-sync-result-body');
  if (!body) return;

  if (caughtError) {
    const message = caughtError.message || '同步失败';
    body.innerHTML = `
      <div class="sync-shop-list">
        <div class="sync-shop-item">
          <div class="sync-shop-head"><strong>同步失败</strong><span class="sync-status failed">失败</span></div>
          <div class="sync-message">${esc(message)}</div>
          <div class="sync-advice"><b>解决办法</b>${esc(syncFailureAdvice(message, 'failed'))}</div>
        </div>
      </div>
    `;
    document.getElementById('m-sync-result')?.classList.add('show');
    return;
  }

  body.innerHTML = `
    <div class="sync-result-summary">
      <div class="sync-result-card"><span>同步店铺</span><strong>${Number(result?.total || rows.length || 0)}</strong></div>
      <div class="sync-result-card"><span>成功</span><strong>${success}</strong></div>
      <div class="sync-result-card"><span>失败</span><strong>${failed}</strong></div>
      <div class="sync-result-card"><span>样品申请</span><strong>${sampleTotal}</strong></div>
    </div>
    <div class="sync-shop-list">
      ${rows.map(row => {
        const statusClass = row.status === 'success' ? 'success' : (row.status === 'skipped' ? 'skipped' : 'failed');
        const statusText = row.status === 'success' ? '成功' : (row.status === 'skipped' ? '跳过' : '失败');
        const advice = row.status === 'success' ? '' : `<div class="sync-advice"><b>解决办法</b>${esc(syncFailureAdvice(row.message, row.status))}</div>`;
        return `
          <div class="sync-shop-item">
            <div class="sync-shop-head"><strong>${esc(row.shop_name || row.shop_id || '店铺')}</strong><span class="sync-status ${statusClass}">${statusText}</span></div>
            <div class="sync-message">${esc(row.message || '')}</div>
            ${syncShopDetailHtml(row)}
            ${advice}
          </div>
        `;
      }).join('') || '<div class="empty-state">暂无同步结果</div>'}
    </div>
  `;
  document.getElementById('m-sync-result')?.classList.add('show');
}

// ════ INIT ════
async function manualSyncShops() {
  try {
    toast('正在同步店铺数据...');
    const result = await api('/api/sync/shops', { method: 'POST', body: JSON.stringify({}) });
    await refreshAll();
    const failed = result.results.filter(r => r.status === 'failed').length;
    const skipped = result.results.filter(r => r.status === 'skipped').length;
    const updated = result.results.reduce((sum, r) => sum
      + Number(r.detail?.products?.total || 0)
      + Number(r.detail?.orders?.total || 0)
      + Number(r.detail?.affiliateOrders?.lines || 0)
      + Number(r.detail?.samples?.total || 0), 0);
    showSyncResult(result);
    if (failed) {
      toast(`同步失败：${failed} 个店铺，请查看解决办法`);
    } else if (skipped) {
      toast(`同步完成：${skipped} 个店铺待配置授权`);
    } else {
      toast(`同步成功：更新 ${updated} 条信息`);
    }
  } catch (error) {
    showSyncResult(null, error);
    toast(error.message || '同步失败');
  }
}
(async function init() {
  await loadShopsAndBD();
  showPage('invite');
})();









