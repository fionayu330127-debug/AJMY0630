// app.js — 前端逻辑，所有数据来自后端 API（/api/...），不再使用假数据

// ════ STATE ════
let SHOPS = [];
let BD_LIST = [];
let PRODUCTS = [];
let curStore = 'oku';
let curPage = 'sample';
let curTab = 'all';
let sSearch = '';
let sType = '';
let lSearch = '';
let lStar = '';
let lBD = '';
let assignTgt = null;
let collabTgt = null;
let sampleStats = { total: 0, byStatus: {}, assignedBD: 0 };

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
  const cols = ['#fe2c55', '#0958d9', '#722ed1', '#d46b08', '#52c41a', '#08979c', '#eb2f96'];
  const c = cols[[...seed].reduce((a, x) => a + x.charCodeAt(0), 0) % cols.length];
  const l = (seed[0] || '?').toUpperCase();
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='${sz}' height='${sz}'><rect width='${sz}' height='${sz}' rx='${sz / 2}' fill='${encodeURIComponent(c)}'/><text x='50%' y='50%' text-anchor='middle' dominant-baseline='central' fill='white' font-size='${Math.round(sz * .4)}' font-family='sans-serif'>${encodeURIComponent(l)}</text></svg>`;
}
function fmtF(n) { n = n || 0; if (n >= 10000000) return (n / 10000000).toFixed(1) + '千万'; if (n >= 10000) return (n / 10000).toFixed(1) + '万'; return String(n); }
function shopInfo(id) { return SHOPS.find(s => s.id === id) || { name: id, color: '#999' }; }
function shopTagHtml(shop) {
  const s = shopInfo(shop);
  const cls = shop === 'oku' ? 'st-oku' : (shop === 'mir' ? 'st-mir' : 'st-both');
  return `<span class="shop-tag ${cls}">${s.name}</span>`;
}
function collabTagHtml(ct, id) {
  if (ct === 'open') return '<span class="tag tag-open">公开合作</span>';
  if (ct === 'targeted') return '<span class="tag tag-targeted">定向合作</span>';
  if (ct === 'affiliate') return '<span class="tag tag-affiliate">联盟合作</span>';
  return `<span class="tag tag-unset" onclick="openCollabModal(event,'${id}')">＋ 标记类型</span>`;
}
function statusBadge(s) {
  const M = { pending: ['s-pending', '待审核'], approved: ['s-approved', '已通过'], rejected: ['s-rejected', '已拒绝'], assigned: ['s-assigned', '已分配'], shipped: ['s-shipped', '已寄出'], published: ['s-published', '已发布'] };
  const [c, l] = M[s] || ['s-pending', '未知'];
  return `<span class="status ${c}"><span class="sdot"></span>${l}</span>`;
}
function starBadgeHtml(n) {
  const M = { 5: 'sb-5', 4: 'sb-4', 3: 'sb-3', 2: 'sb-2', 1: 'sb-1' };
  return n > 0 ? `<span class="sb ${M[n]}">${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${n}星</span>` : '';
}
function progressLabel(s) { return { approved: '待安排发货', assigned: 'BD跟进中', shipped: '样品已寄出', published: '视频已发布', pending: '审核中', rejected: '已拒绝' }[s] || ''; }

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
    <button class="sw-btn ${curStore === 'all' ? 'active' : ''}" onclick="switchStore('all')">全部</button>
  `;
  document.getElementById('store-switcher-sample').innerHTML = html('');
  document.getElementById('store-switcher-lib').innerHTML = html('-lib');
  updateStoreCounts();
}

async function updateStoreCounts() {
  for (const s of SHOPS) {
    const stats = await api(`/api/samples/stats?shop=${s.id}`);
    ['', '-lib'].forEach(suf => {
      const el = document.getElementById(`scnt-${s.id}${suf}`);
      if (el) el.textContent = stats.total;
    });
  }
}

// ════ STORE / PAGE SWITCH ════
function switchStore(store) {
  curStore = store;
  renderStoreSwitchers();
  if (curPage === 'sample') renderSamplePage();
  if (curPage === 'lib') renderLibPage();
}

function showPage(page) {
  curPage = page;
  ['sample', 'lib', 'data', 'bdmgmt'].forEach(p => {
    document.getElementById('page-' + p)?.classList.toggle('visible', p === page);
    document.getElementById('nav-' + p)?.classList.toggle('active', p === page);
  });
  if (page === 'sample') renderSamplePage();
  if (page === 'lib') renderLibPage();
  if (page === 'bdmgmt') renderBDMgmt();
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
  ];
  document.getElementById('tab-bar').innerHTML = tabs.map(t => `
    <div class="tab-item ${t.id === curTab ? 'active' : ''}" onclick="switchTab('${t.id}')">
      ${t.lbl} <span class="tab-cnt">${t.cnt}</span>
    </div>`).join('');
}

function switchTab(tab) { curTab = tab; renderSampleTable(); }

async function renderSampleTable() {
  const params = new URLSearchParams();
  if (curStore !== 'all') params.set('shop', curStore);
  if (curTab !== 'all') params.set('status', curTab);
  if (sSearch) params.set('search', sSearch);
  if (sType) params.set('collab_type', sType);

  const list = await api('/api/samples?' + params.toString());
  document.getElementById('pager-info').textContent = `共 ${list.length} 条`;

  const showShop = curStore === 'all';
  const thead = document.getElementById('sample-thead');
  const existing = thead.querySelector('.th-shop');
  if (showShop && !existing) {
    const th = document.createElement('th');
    th.className = 'th-shop'; th.textContent = '店铺';
    thead.insertBefore(th, thead.children[5]);
  } else if (!showShop && existing) {
    existing.remove();
  }

  const tbody = document.getElementById('sample-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${showShop ? 10 : 9}"><div class="empty-state"><div class="empty-icon">📭</div><div>暂无申请数据</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => {
    const av = avatarSVG(s.creator_name, 36);
    const bdHtml = s.bd_id
      ? `<div style="display:flex;align-items:center;gap:6px"><img src="${avatarSVG(s.bd_name, 22)}" style="width:22px;height:22px;border-radius:50%"><span style="font-size:12px;color:#555">${s.bd_name}</span></div>`
      : `<button class="assign-btn" onclick="openAssignModal(event,'${s.id}')">分配 BD</button>`;
    const actHtml = s.status === 'pending'
      ? `<div class="abtns"><button class="abtn ok" onclick="doApprove('${s.id}')">通过</button><button class="abtn ng" onclick="doReject('${s.id}')">拒绝</button><button class="abtn bl" onclick="openCreatorModal('${s.id}')">详情</button></div>`
      : `<div class="abtns"><button class="abtn bl" onclick="openCreatorModal('${s.id}')">达人</button><button class="abtn" onclick="toast('📦 物流记录（演示）')">物流</button></div>`;
    return `<tr>
      <td><input type="checkbox" class="checkbox"></td>
      <td><div class="cc"><img src="${av}" class="av" onclick="openCreatorModal('${s.id}')"><div><div class="cn" onclick="openCreatorModal('${s.id}')">${s.creator_name}</div><div class="cm">${s.creator_handle || ''} · ${s.category || ''}</div></div></div></td>
      <td><div class="pc"><div class="pe">${s.product_emoji || '🧴'}</div><div><div class="pn">${s.product_name || '-'}</div><div class="ps">${s.product_sku || ''}</div></div></div></td>
      <td style="font-weight:500">${fmtF(s.fans)}</td>
      <td style="color:#999;font-size:12px">${s.applied_at || ''}</td>
      ${showShop ? `<td>${shopTagHtml(s.shop_id)}</td>` : ''}
      <td onclick="openCollabModal(event,'${s.id}')">${collabTagHtml(s.collab_type, s.id)}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${bdHtml}</td>
      <td>${actHtml}</td>
    </tr>`;
  }).join('');
}

function onSampleSearch(v) { sSearch = v.toLowerCase(); renderSampleTable(); }
function setTypeFilter(v) { sType = v; renderSampleTable(); }
function resetFilters() {
  sSearch = ''; sType = '';
  document.querySelectorAll('#page-sample .fi').forEach(el => { if (el.type === 'text') el.value = ''; else if (el.tagName === 'SELECT') el.selectedIndex = 0; });
  renderSampleTable();
}
function selAll(cb) { document.querySelectorAll('#sample-tbody .checkbox').forEach(c => c.checked = cb.checked); }

async function doApprove(id) {
  await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
  toast('✅ 已通过审核，请分配 BD 成员');
  renderSamplePage();
}
async function doReject(id) {
  await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) });
  toast('❌ 已拒绝该申请');
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
  const params = new URLSearchParams();
  if (curStore !== 'all') params.set('shop', curStore);
  if (lSearch) params.set('search', lSearch);
  if (lStar) params.set('star', lStar);
  if (lBD) params.set('bd', lBD);

  const creators = await api('/api/library?' + params.toString());
  const grid = document.getElementById('lib-grid');

  if (!creators.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><div>暂无合作达人数据<br><span style="font-size:12px;color:#bbb">已通过审核的样品申请会自动出现在这里</span></div></div>`;
    return;
  }

  grid.innerHTML = creators.map(c => {
    const shops = c.shops;
    const shopDisplay = shops.length > 1 ? 'both' : shops[0];
    const av = avatarSVG(c.name, 44);
    const bdNames = [...new Set(c.samples.map(s => s.bd_name).filter(Boolean))].join(' · ');
    const totalOrders = c.samples.length * 3;

    const subRows = c.samples.map(s => `
      <tr>
        <td>${shopTagHtml(s.shop_id)}</td>
        <td><div style="display:flex;align-items:center;gap:6px"><span style="font-size:15px">${s.product_emoji || '🧴'}</span><div><div style="font-size:12px">${s.product_name || '-'}</div><div style="font-size:11px;color:#999">${s.product_sku || ''}</div></div></div></td>
        <td style="color:#999">${(s.applied_at || '').slice(0, 10)}</td>
        <td>${collabTagHtml(s.collab_type, s.id)}</td>
        <td>${statusBadge(s.status)}</td>
        <td style="font-size:11px;color:#999">${progressLabel(s.status)}</td>
      </tr>`).join('');

    return `<div class="lib-card" id="lc-${c.uid}">
      <div class="lib-head" onclick="toggleCard('${c.uid}')">
        <img src="${av}" style="width:44px;height:44px;border-radius:50%;flex-shrink:0;border:1.5px solid #f0f0f0">
        <div class="lib-info">
          <div class="lib-name">
            ${c.name}
            ${shopDisplay === 'both' ? '<span class="shop-tag st-both">双店铺合作</span>' : shopTagHtml(shops[0])}
            ${c.star > 0 ? starBadgeHtml(c.star) : ''}
          </div>
          <div class="lib-meta">
            <span>${c.handle || ''}</span><span>·</span>
            <span>${c.category || ''}</span><span>·</span>
            <span>粉丝 ${fmtF(c.fans)}</span>
            <span>·</span><span style="font-family:monospace;font-size:11px">${c.uid}</span>
            ${bdNames ? `<span>·</span><span>BD: ${bdNames}</span>` : ''}
          </div>
        </div>
        <div class="lib-stats">
          <div><div class="lib-stat-val">${c.samples.length}</div><div class="lib-stat-lbl">合作次数</div></div>
          <div><div class="lib-stat-val">${totalOrders}</div><div class="lib-stat-lbl">累计出单</div></div>
        </div>
        <div class="stars" onclick="event.stopPropagation()" id="stars-${c.uid}">
          ${[1,2,3,4,5].map(n => `<span class="star ${n <= c.star ? 'on' : 'off'}" onclick="setStar('${c.uid}',${n})">${n <= c.star ? '★' : '☆'}</span>`).join('')}
        </div>
        <div class="lib-expand">▼</div>
      </div>
      <div class="lib-body">
        <table class="sub-table">
          <thead><tr><th>店铺</th><th>样品商品</th><th>申请日期</th><th>合作类型</th><th>状态</th><th>合作进度</th></tr></thead>
          <tbody>${subRows}</tbody>
        </table>
        <div class="bd-note">
          <div class="bd-note-lbl">📝 BD 跟进备注（达人介绍、联系方式、出单情况等）</div>
          <textarea class="bd-note-ta" id="note-${c.uid}" placeholder="记录达人沟通情况、联系方式、出单详情…">${c.libNote || ''}</textarea>
          <button class="bd-note-save" onclick="saveNote('${c.uid}')">保存备注</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleCard(uid) { document.getElementById('lc-' + uid)?.classList.toggle('open'); }

async function setStar(uid, n) {
  await api(`/api/library/${uid}/star`, { method: 'PUT', body: JSON.stringify({ star: n }) });
  toast(`⭐ 已标记 ${n} 星`);
  renderLibPage();
}
async function saveNote(uid) {
  const note = document.getElementById('note-' + uid)?.value || '';
  await api(`/api/library/${uid}/note`, { method: 'PUT', body: JSON.stringify({ note }) });
  toast('📝 备注已保存');
}
function onLibSearch(v) { lSearch = v.toLowerCase(); renderLibPage(); }
function filterLibStar(v) { lStar = v; renderLibPage(); }
function filterLibBD(v) { lBD = v; renderLibPage(); }

function populateBDFilter() {
  const sel = document.getElementById('lib-bd-sel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 BD</option>' + BD_LIST.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  sel.value = cur || '';
}

// ════ MODALS ════
async function openCreatorModal(sid) {
  const list = await api('/api/samples');
  const s = list.find(x => x.id === sid);
  if (!s) return;
  const av = avatarSVG(s.creator_name, 68);
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
        <div><div class="info-lbl">申请时间</div><div class="info-val" style="font-size:12px">${s.applied_at || '-'}</div></div>
        <div><div class="info-lbl">合作类型</div><div class="info-val">${{open:'公开合作',targeted:'定向合作',affiliate:'联盟合作'}[s.collab_type] || '未标记'}</div></div>
        <div><div class="info-lbl">申请样品</div><div class="info-val">${s.product_emoji || ''} ${s.product_name || '-'}</div></div>
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
  document.getElementById('bd-mgmt-tbody').innerHTML = BD_LIST.map(b => `
    <tr><td>${b.name}</td><td>${b.load} 个</td></tr>
  `).join('') || '<tr><td colspan="2"><div class="empty-state">暂无 BD 成员</div></td></tr>';
}
function openAddBDModal() {
  document.getElementById('bd-name').value = '';
  document.getElementById('m-add-bd').classList.add('show');
}
async function submitNewBD() {
  const name = document.getElementById('bd-name').value.trim();
  if (!name) { toast('⚠️ 请输入姓名'); return; }
  await api('/api/bd', { method: 'POST', body: JSON.stringify({ name }) });
  closeModal('m-add-bd');
  toast('✅ BD 成员已添加');
  await loadShopsAndBD();
  renderBDMgmt();
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
  if (curPage === 'sample') renderSamplePage();
  if (curPage === 'lib') renderLibPage();
}

// ════ INIT ════
async function manualSyncShops() {
  try {
    toast('正在同步店铺数据...');
    const result = await api('/api/sync/shops', { method: 'POST', body: JSON.stringify({}) });
    await refreshAll();
    const skipped = result.results.filter(r => r.status === 'skipped').length;
    if (skipped) {
      toast(`已完成同步检查：${result.total} 个店铺，${skipped} 个店铺待配置 API`);
    } else {
      toast(`店铺数据同步完成：${result.total} 个店铺`);
    }
  } catch (error) {
    toast(error.message || '同步失败');
  }
}
(async function init() {
  await loadShopsAndBD();
  showPage('sample');
})();

