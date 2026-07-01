const app = document.getElementById('app');

const state = {
  auth: null,
  dashboard: null,
  activeModule: 'home',
  openGroup: null,
  tkProducts: null,
  tkProductShop: 'oku',
  tkProductSearch: '',
  team: null,
  teamTab: 'groups',
  teamSearch: '',
  teamAddGroup: '员工',
  teamAddOpen: false,
  teamEditMemberId: null,
  weeklyReport: null,
  weeklyWeekStart: '',
  weeklyFormOpen: false,
  amazonAds: null,
  amazonAdsStart: '',
  amazonAdsEnd: '',
  sampleSubmissions: null,
  sampleSubmitOpen: false,
  sampleSubmitSearch: '',
  sampleSubmitStatus: 'all',
};

const fallbackMemberNames = ['余蓉', '盛峻波', '胡辉', '赵颖霖', '吕文健', '刘嘉莹'];
let memberNames = [...fallbackMemberNames];

const navGroups = [
  {
    id: 'ai-workbench',
    title: 'AI 工作台',
    icon: 'AI',
    items: [
      { id: 'ai-image', label: 'AI 做图' },
      { id: 'ai-video', label: 'AI 剪视频' },
    ],
  },
  {
    id: 'sales-center',
    title: '销售中心',
    icon: '销',
    items: [
      { id: 'tk-sales', label: 'TK 销售中心' },
      { id: 'amazon-sales', label: '亚马逊销售中心' },
      { id: 'sales-overview', label: '销售总览' },
      { id: 'product-performance', label: '商品表现' },
      { id: 'order-detail', label: '订单明细' },
    ],
  },
  {
    id: 'tk-creator-center',
    title: 'TK 达人管理中心',
    icon: 'TK',
    items: [
      { id: 'tk-creator', label: 'TK 达人管理', embedded: true },
    ],
  },
  {
    id: 'operation-center',
    title: '运营中心',
    icon: '运',
    items: [
      { id: 'sample-submit', label: '链接刊登' },
      { id: 'link-tracking', label: '链接跟踪' },
      { id: 'amazon-ads', label: '亚马逊广告' },
      { id: 'tk-ads', label: 'TK 广告' },
      { id: 'review-table', label: '测评表' },
    ],
  },
  {
    id: 'product-center',
    title: '商品中心',
    icon: '品',
    items: [
      { id: 'tk-products', label: 'TK商品' },
      { id: 'amazon-products', label: '亚马逊商品' },
    ],
  },
  {
    id: 'selection-center',
    title: '选品中心',
    icon: '选',
    items: [
      { id: 'aba-data', label: 'ABA 数据' },
      { id: 'tk-trend', label: 'TK trend' },
    ],
  },
  {
    id: 'inventory-center',
    title: '库存货件',
    icon: '库',
    items: [
      { id: 'inventory-detail', label: '库存明细', externalUrl: 'http://47.110.59.28/' },
      { id: 'inventory', label: '库存货件' },
    ],
  },
  { id: 'logistics-center', title: '物流中心', icon: '流', items: [{ id: 'logistics', label: '物流中心' }] },
  { id: 'purchase-center', title: '采购中心', icon: '采', items: [{ id: 'purchase', label: '采购中心' }] },
  { id: 'finance-center', title: '财务中心', icon: '财', items: [{ id: 'finance', label: '财务中心' }] },
  { id: 'team-center', title: '团队管理', icon: '人', items: [{ id: 'team', label: '团队管理' }, { id: 'weekly-report', label: '周报提交' }] },
  { id: 'agent-center', title: 'Agent 中心', icon: 'AG', items: [{ id: 'agent', label: 'Agent 中心' }] },
  { id: 'data-assistant-center', title: '数据助手', icon: '数', items: [{ id: 'data-assistant', label: '数据助手' }] },
  { id: 'toolbox-center', title: '工具箱', icon: '具', items: [{ id: 'toolbox', label: '工具箱' }] },
  { id: 'settings-center', title: '系统设置', icon: '设', items: [{ id: 'settings', label: '系统设置' }] },
];

function findModule(id) {
  for (const group of navGroups) {
    const item = group.items.find((entry) => entry.id === id);
    if (item) return { ...item, group: group.title, groupId: group.id };
  }
  return { id: 'home', label: '首页', group: '首页' };
}

function groupHasActiveItem(group) {
  return group.items.some((item) => item.id === state.activeModule);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showAppToast(message) {
  document.querySelector('.app-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.classList.remove('show'), 1400);
  setTimeout(() => toast.remove(), 1700);
}

function goHomeSoon() {
  setTimeout(() => {
    state.activeModule = 'home';
    state.openGroup = null;
    state.weeklyFormOpen = false;
    render();
  }, 900);
}

function handleTkFrameLoad(frame) {
  const fallback = document.getElementById('tk-frame-fallback');
  if (!fallback) return;
  setTimeout(() => {
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      const hasTkLayout = Boolean(doc?.querySelector('.layout') && doc?.querySelector('#page-invite'));
      fallback.classList.toggle('show', !hasTkLayout);
    } catch (error) {
      fallback.classList.add('show');
    }
  }, 900);
}

function render() {
  if (!state.auth) {
    app.innerHTML = loginView();
    bindLogin();
    return;
  }
  app.innerHTML = dashboardView();
  bindDashboard();
}

function loginView() {
  return `
    <main class="screen auth-shell">
      <section class="brand-pane">
        <div class="brand-visual">
          <img class="login-logo" src="/assets/ajmy-logo-512.png" alt="AJMY" />
        </div>
        <section class="login-banner">
          <span>跨境电商工作系统</span>
          <h1>奥吉米亚 ERP</h1>
          <p>统一进入订单、商品、达人、任务、消息与自动化规则。当前已接入 TK 达人管理模块，后续继续扩展 TikTok API、Webhook、Cron、WebSocket 与 PostgreSQL 数据库。</p>
        </section>
      </section>

      <section class="auth-pane">
        <section class="login-card">
          <div class="login-top">
            <div>
              <h2 class="login-title">登录系统</h2>
              <p class="login-sub">选择成员并输入密码。</p>
            </div>
          </div>

          <form class="form-grid" id="loginForm">
            <div class="field">
              <label for="memberName">用户名</label>
              <select id="memberName" name="memberName" autocomplete="username">
                <option value="">请选择用户名</option>
                ${memberNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="password">密码</label>
              <input id="password" name="password" type="password" value="123456" autocomplete="current-password" />
            </div>
            <button class="primary-btn" type="submit">进入首页</button>
            <div class="error" id="loginError"></div>
          </form>

          <div class="helper-row">
            <span class="hint">初始密码：123456</span>
            <span>本地开发版</span>
          </div>
        </section>
      </section>
    </main>
  `;
}

function sidebarView() {
  const groupHtml = navGroups.map((group) => {
    const isOpen = state.openGroup === group.id || groupHasActiveItem(group);
    return `
      <div class="nav-group ${isOpen ? 'open' : ''}">
        <button class="nav-group-title ${groupHasActiveItem(group) ? 'active' : ''}" data-group="${group.id}" type="button">
          <span class="nav-title-main"><span class="nav-icon">${escapeHtml(group.icon)}</span>${escapeHtml(group.title)}</span>
        </button>
        <div class="nav-group-items">
          ${group.items.map((item) => `
            <button class="nav-item ${state.activeModule === item.id ? 'active' : ''}" data-module="${item.id}" type="button">
              ${escapeHtml(item.label)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  return `
    <aside class="sidebar">
      <div class="sidebar-brand">
        <img class="sidebar-logo" src="/assets/ajmy-logo-64.png" alt="AJMY" />
        <div>
          <h2>奥吉米亚 ERP</h2>
          <p>${escapeHtml(state.auth?.name || '')} 已登录</p>
        </div>
      </div>
      <nav class="nav-list">
        <button class="nav-home ${state.activeModule === 'home' ? 'active' : ''}" data-module="home" type="button">首页</button>
        ${groupHtml}
      </nav>
    </aside>
  `;
}

function dashboardView() {
  const active = findModule(state.activeModule);

  return `
    <main class="screen dashboard-shell">
      ${sidebarView()}

      <section class="main">
        <header class="topbar">
          <div class="topbar-title">
            <h1>${escapeHtml(active.label)}</h1>
            <p>${escapeHtml(active.group)}</p>
          </div>
          <div class="topbar-actions">
            <div class="badge"><span class="dot"></span>在线</div>
            <div class="badge">${escapeHtml(state.auth?.name || '')}</div>
            <button class="ghost-btn" id="logoutBtn" type="button">退出</button>
          </div>
        </header>

        ${state.activeModule === 'home' ? homePanel() : modulePanel(active)}
      </section>
    </main>
  `;
}

function homePanel() {
  const stats = (state.dashboard?.stats || []).map(card => `
    <section class="stat-card">
      <span>${escapeHtml(card.label)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <em>${escapeHtml(card.delta)}</em>
    </section>
  `).join('');

  const modules = (state.dashboard?.modules || []).map(item => `
    <div class="module-item">
      <strong>${escapeHtml(item.name)}</strong>
      <span class="tone-${escapeHtml(item.tone)}">${escapeHtml(item.status)}</span>
    </div>
  `).join('');

  const timeline = (state.dashboard?.timeline || []).map(item => `
    <div class="timeline-row">
      <time>${escapeHtml(item.time)}</time>
      <div>${escapeHtml(item.text)}</div>
    </div>
  `).join('');

  return `
    <section class="stats-grid">${stats}</section>

    <section class="grid-2">
      <section class="panel">
        <div class="panel-head">
          <h3>今日节奏</h3>
          <small>自动任务</small>
        </div>
        <div class="timeline">${timeline}</div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h3>模块状态</h3>
          <small>系统底座</small>
        </div>
        <div class="module-grid">${modules}</div>
      </section>
    </section>
  `;
}

function modulePanel(active) {
  if (active.id === 'ai-image') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>AI 做图工作台</h3>
          <small>/ai-draw/</small>
        </div>
        <div class="module-frame">
          <iframe src="/ai-draw/" title="AI 做图工作台"></iframe>
        </div>
        <div class="footer-row">
          <span>AI 做图模块已接入当前 ERP 服务。</span>
          <span>公网入口：https://aojimiya123.top/ai-draw/</span>
        </div>
      </section>
    `;
  }

  if (active.id === 'inventory') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>库存货件</h3>
          <small>/inventory/</small>
        </div>
        <div class="module-frame">
          <iframe src="/inventory/" title="库存货件"></iframe>
        </div>
        <div class="footer-row">
          <span>库存货件模块已作为独立项目接入当前 ERP 服务。</span>
          <span>公网入口：https://aojimiya123.top/inventory/</span>
        </div>
      </section>
    `;
  }

  if (active.id === 'inventory-detail') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>库存明细</h3>
          <small>http://47.110.59.28/</small>
        </div>
        <div class="module-frame">
          <iframe src="http://47.110.59.28/" title="库存明细"></iframe>
        </div>
        <div class="footer-row">
          <span>库存明细模块已同步到库存货件菜单。</span>
          <a href="http://47.110.59.28/" target="_blank" rel="noopener">模块链接：http://47.110.59.28/</a>
        </div>
      </section>
    `;
  }

  if (active.id === 'tk-creator') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>TK 达人管理系统</h3>
          <small>/tk/</small>
        </div>
        <div class="module-frame tk-frame-wrap">
          <iframe src="/tk/?v=20260629-tk-frame" title="TK 达人管理系统" onload="handleTkFrameLoad(this)"></iframe>
          <div class="tk-frame-fallback" id="tk-frame-fallback">
            <strong>TK 达人管理系统未在当前框内正常显示</strong>
            <span>可以直接打开完整 TK 页面继续操作。</span>
            <button class="btn primary" onclick="window.location.href='/tk/'">打开完整 TK 系统</button>
          </div>
        </div>
        <div class="footer-row">
          <span>TK 模块已并入当前 ERP 服务。</span>
          <a href="/tk/" target="_self">打开完整 TK 系统</a>
        </div>
      </section>
    `;
  }

  if (active.id === 'tk-products') {
    return tkProductsPanel();
  }

  if (active.id === 'amazon-products') {
    return amazonProductsPanel();
  }

  if (active.id === 'sample-submit') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>链接刊登</h3>
          <small>/product-test/</small>
        </div>
        <div class="module-frame">
          <iframe src="/product-test/" title="链接刊登"></iframe>
        </div>
        <div class="footer-row">
          <span>链接刊登已作为根目录独立应用接入当前 ERP 服务。</span>
          <a href="/product-test/" target="_self">打开完整链接刊登模块</a>
        </div>
      </section>
    `;
  }

  if (active.id === 'link-tracking') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>链接跟踪</h3>
          <small>/product-test/?view=tracking</small>
        </div>
        <div class="module-frame">
          <iframe src="/product-test/?view=tracking" title="链接跟踪"></iframe>
        </div>
        <div class="footer-row">
          <span>链接跟踪同步链接刊登中“链接上架成功”的清单。</span>
          <a href="/product-test/?view=tracking" target="_self">打开完整链接跟踪模块</a>
        </div>
      </section>
    `;
  }

  if (active.id === 'amazon-ads') {
    return amazonAdsPanel();
  }

  if (active.id === 'team') {
    return teamPanel();
  }

  if (active.id === 'weekly-report') {
    return weeklyReportPanel();
  }

  return `
    <section class="panel placeholder-panel">
      <div>
        <small>${escapeHtml(active.group)}</small>
        <h2>${escapeHtml(active.label)}</h2>
        <p>该模块入口已创建，后续可继续接入页面、接口、权限和数据表。</p>
      </div>
    </section>
  `;
}

function shopLabel(shopId) {
  return {
    oku: 'OKUYOSHI',
    mir: 'MIR HOME',
  }[shopId] || shopId;
}

function statusLabel(status) {
  const value = String(status || '').toUpperCase();
  if (['ACTIVATE', 'ACTIVE', 'ONLINE'].includes(value)) return '在线';
  if (value === 'SAMPLE') return '样品商品';
  if (!value) return '未同步';
  return status;
}

function tkProductsPanel() {
  const payload = state.tkProducts;
  const products = payload?.products || [];
  const shops = payload?.shops || [
    { id: 'oku', name: 'OKUYOSHI', product_count: 0 },
    { id: 'mir', name: 'MIR HOME', product_count: 0 },
  ];
  const summary = payload?.summary || { total: 0, active: 0, synced: 0 };
  const isLoading = !payload;

  return `
    <section class="panel tk-product-panel">
      <div class="panel-head tk-product-head">
        <div>
          <h3>TK商品</h3>
          <small>同步显示 TikTok Shop 店铺商品信息</small>
        </div>
        <button class="ghost-btn" id="tkProductReload" type="button">刷新商品</button>
      </div>

      <div class="tk-product-toolbar">
        <div class="tk-shop-tabs">
          ${shops.map((shop) => `
            <button class="tk-shop-tab ${state.tkProductShop === shop.id ? 'active' : ''}" data-tk-product-shop="${escapeHtml(shop.id)}" type="button">
              <span class="shop-dot"></span>
              ${escapeHtml(shop.name || shopLabel(shop.id))}
              <em>${Number(shop.product_count || 0)}</em>
            </button>
          `).join('')}
        </div>
        <div class="tk-product-search">
          <input id="tkProductSearch" type="search" placeholder="搜索商品名称 / SKU / 商品ID" value="${escapeHtml(state.tkProductSearch)}" />
        </div>
      </div>

      <div class="tk-product-stats">
        <div><span>当前店铺</span><strong>${escapeHtml(shopLabel(state.tkProductShop))}</strong></div>
        <div><span>商品总数</span><strong>${Number(summary.total || 0)}</strong></div>
        <div><span>在线商品</span><strong>${Number(summary.active || 0)}</strong></div>
        <div><span>已同步</span><strong>${Number(summary.synced || 0)}</strong></div>
      </div>

      <div class="tk-product-table-wrap">
        <table class="tk-product-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>SKU</th>
              <th>状态</th>
              <th>样品申请</th>
              <th>同步时间</th>
            </tr>
          </thead>
          <tbody id="tkProductTbody">
            ${isLoading ? '<tr><td colspan="5"><div class="table-empty">正在加载商品...</div></td></tr>' : tkProductRows(products)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function tkProductRows(products) {
  if (!products.length) {
    return '<tr><td colspan="5"><div class="table-empty">暂无商品数据</div></td></tr>';
  }

  return products.map((product) => {
    const image = product.image_url
      ? `<img src="${escapeHtml(product.image_url)}" alt="">`
      : `<div class="tk-product-thumb">${escapeHtml(product.emoji || '品')}</div>`;

    return `
      <tr>
        <td>
          <div class="tk-product-main">
            ${image}
            <div>
              <strong>${escapeHtml(product.name || '-')}</strong>
              <span>${escapeHtml(product.external_product_id || '未关联 TikTok 商品ID')}</span>
            </div>
          </div>
        </td>
        <td><code>${escapeHtml(product.sku || '-')}</code></td>
        <td><span class="tk-status">${escapeHtml(statusLabel(product.status))}</span></td>
        <td>
          <div class="tk-sample-count">
            <strong>${Number(product.sample_count || 0)}</strong>
            <span>待审 ${Number(product.pending_samples || 0)}</span>
          </div>
        </td>
        <td>${escapeHtml(product.synced_at || '-')}</td>
      </tr>
    `;
  }).join('');
}

function amazonProductsPanel() {
  return `
    <section class="panel amazon-products-panel">
      <div class="panel-head amazon-products-head">
        <div>
          <h3>亚马逊商品</h3>
          <small>预留领星 API 商品信息对接</small>
        </div>
        <button class="ghost-btn" type="button" disabled>等待接口配置</button>
      </div>

      <div class="amazon-products-status pending">
        <div>
          <strong>领星商品 API 待接入</strong>
          <span>后续配置领星应用凭证和商品接口路径后，可同步亚马逊产品信息。</span>
        </div>
        <code>LINGXING_PRODUCT_API_PATH</code>
      </div>

      <div class="amazon-products-kpis">
        <div><span>商品总数</span><strong>0</strong></div>
        <div><span>在售商品</span><strong>0</strong></div>
        <div><span>待同步</span><strong>0</strong></div>
        <div><span>异常链接</span><strong>0</strong></div>
      </div>

      <div class="amazon-products-table-wrap">
        <table class="amazon-products-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>ASIN</th>
              <th>SKU</th>
              <th>站点</th>
              <th>店铺</th>
              <th>状态</th>
              <th>售价</th>
              <th>库存</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="9"><div class="table-empty">等待领星 API 接入后同步亚马逊商品数据</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

const sampleSubmitFields = [
  { key: 'sample_status', label: '测品流程', type: 'select', options: ['待审核', '测品中', '测品通过', '测品失败', '已转正式商品'] },
  { key: 'listing_status', label: '刊登状态', type: 'select', options: ['待提交', '待刊登', '已刊登', '暂停'] },
  { key: 'urgency', label: '紧急程度', type: 'select', options: ['⭐⭐⭐', '⭐⭐', '⭐', '普通'] },
  { key: 'submit_date', label: '提交日期', type: 'date' },
  { key: 'developer', label: '开发人' },
  { key: 'lister', label: '刊登人' },
  { key: 'shipper', label: '发货人' },
  { key: 'product_keywords', label: '产品关键词', required: true },
  { key: 'brand', label: '品牌', required: true },
  { key: 'store_name', label: '上架店铺', required: true },
  { key: 'delivery_method', label: '配送方式', type: 'select', options: ['FBM', 'FBA', ''] },
  { key: 'lead_time', label: '货期' },
  { key: 'variant_attribute', label: '变体属性' },
  { key: 'variant_name', label: '变体名称', multiline: true },
  { key: 'source_url', label: '1688链接', multiline: true },
  { key: 'product_note', label: '产品说明', multiline: true },
  { key: 'parent_asin_us', label: '父ASIN（US）' },
  { key: 'shipping_channel', label: '发货渠道' },
  { key: 'quantity', label: '数量' },
  { key: 'is_shipped', label: '是否发货', type: 'select', options: ['否', '是', ''] },
  { key: 'parent_asin_au', label: '父ASIN（AU）' },
  { key: 'transparency_plan', label: '透明计划', type: 'select', options: ['不注册', '注册', ''] },
  { key: 'link_status', label: '链接状态', type: 'select', options: ['正常', '需要认证', '异常', ''] },
  { key: 'price_jp', label: '售价（JP）' },
  { key: 'contact_group', label: '对接群' },
  { key: 'start_time', label: '开始时间' },
  { key: 'reference_text', label: '文本', multiline: true },
  { key: 'need_follow_sale', label: '是否需要跟卖', type: 'select', options: ['否', '是', ''] },
  { key: 'erp_listed', label: 'ERP是否刊登？', type: 'select', options: ['否', '是', ''] },
  { key: 'direct_review', label: '是否上直评', type: 'select', options: ['否', '是', ''] },
  { key: 'ads_enabled', label: '是否开广告', type: 'select', options: ['否', '是', ''] },
  { key: 'copywriting_quality', label: '文案质量' },
  { key: 'a_plus', label: 'A+' },
];

function sampleSubmitPanel() {
  const rows = state.sampleSubmissions?.submissions || [];
  const summary = state.sampleSubmissions?.summary || {};
  const loading = !state.sampleSubmissions;
  const total = rows.length;
  const pending = Number(summary.pending || rows.filter((row) => sampleStatusKey(row.sample_status) === 'pending').length);
  const testing = Number(summary.testing || rows.filter((row) => sampleStatusKey(row.sample_status) === 'testing').length);
  const passed = Number(summary.passed || rows.filter((row) => sampleStatusKey(row.sample_status) === 'passed').length);
  const failed = Number(summary.failed || rows.filter((row) => sampleStatusKey(row.sample_status) === 'failed').length);
  const converted = Number(summary.converted || rows.filter((row) => sampleStatusKey(row.sample_status) === 'converted').length);
  const statusTabs = [
    { id: 'all', label: '全部', count: summary.total ?? total },
    { id: 'pending', label: '待审核', count: pending },
    { id: 'testing', label: '测品中', count: testing },
    { id: 'passed', label: '通过', count: passed },
    { id: 'failed', label: '失败', count: failed },
    { id: 'converted', label: '已转商品', count: converted },
  ];

  return `
    <section class="panel sample-submit-panel">
      <div class="panel-head sample-submit-head">
        <div>
          <h3>测品提交</h3>
          <small>独立测品流程，不写入正式商品池</small>
        </div>
        <div class="sample-submit-actions">
          <button class="ghost-btn" id="sampleSubmitReload" type="button">刷新清单</button>
          <button class="primary-btn" id="openSampleSubmit" type="button">新增测品</button>
        </div>
      </div>

      <div class="sample-process-strip">
        <div class="sample-process-step active"><strong>1</strong><span>提交测品</span></div>
        <div class="sample-process-step"><strong>2</strong><span>审核评估</span></div>
        <div class="sample-process-step"><strong>3</strong><span>测品执行</span></div>
        <div class="sample-process-step"><strong>4</strong><span>结果沉淀</span></div>
        <div class="sample-process-step"><strong>5</strong><span>转正式商品</span></div>
      </div>

      <div class="sample-submit-toolbar">
        <input id="sampleSubmitSearch" type="search" placeholder="搜索关键词 / 品牌 / 店铺 / 说明 / 链接" value="${escapeHtml(state.sampleSubmitSearch)}" />
      </div>

      <div class="sample-status-tabs">
        ${statusTabs.map((tab) => `
          <button class="sample-status-tab ${state.sampleSubmitStatus === tab.id ? 'active' : ''}" data-sample-status="${escapeHtml(tab.id)}" type="button">
            ${escapeHtml(tab.label)}<em>${Number(tab.count || 0)}</em>
          </button>
        `).join('')}
      </div>

      <div class="sample-submit-kpis">
        <div><span>待审核</span><strong>${pending}</strong></div>
        <div><span>测品中</span><strong>${testing}</strong></div>
        <div><span>通过</span><strong>${passed}</strong></div>
        <div><span>已转商品</span><strong>${converted}</strong></div>
      </div>

      <div class="sample-submit-table-wrap">
        <table class="sample-submit-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>紧急</th>
              <th>提交日期</th>
              <th>产品关键词</th>
              <th>品牌</th>
              <th>店铺</th>
              <th>配送</th>
              <th>变体</th>
              <th>售价JP</th>
              <th>提交人</th>
              <th>审核备注</th>
              <th>流程操作</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            ${loading ? '<tr><td colspan="13"><div class="table-empty">正在加载提交清单...</div></td></tr>' : sampleSubmitRows(rows)}
          </tbody>
        </table>
      </div>

      ${state.sampleSubmitOpen ? sampleSubmitModal() : ''}
    </section>
  `;
}

function sampleSubmitRows(rows) {
  if (!rows.length) return '<tr><td colspan="13"><div class="table-empty">暂无测品提交记录</div></td></tr>';
  return rows.map((row) => `
    <tr>
      <td><span class="sample-status ${escapeHtml(sampleStatusKey(row.sample_status))}">${escapeHtml(row.sample_status || '待审核')}</span></td>
      <td>${escapeHtml(row.urgency || '-')}</td>
      <td>${escapeHtml(String(row.submit_date || '').slice(0, 10) || '-')}</td>
      <td>
        <div class="sample-main-cell">
          <strong>${escapeHtml(row.product_keywords || '-')}</strong>
          <a href="${escapeHtml(row.source_url || '#')}" target="_blank" rel="noopener">${escapeHtml(row.source_url ? '1688链接' : '')}</a>
        </div>
      </td>
      <td>${escapeHtml(row.brand || '-')}</td>
      <td>${escapeHtml(row.store_name || '-')}</td>
      <td>${escapeHtml(row.delivery_method || '-')}</td>
      <td>${escapeHtml(row.variant_name || '-')}</td>
      <td>${escapeHtml(row.price_jp || '-')}</td>
      <td>${escapeHtml(row.submitter_name || '-')}</td>
      <td>${escapeHtml(row.review_note || '-')}</td>
      <td>${sampleSubmitActions(row)}</td>
      <td>${escapeHtml(formatDateTime(row.created_at) || '-')}</td>
    </tr>
  `).join('');
}

function sampleStatusKey(status) {
  const text = String(status || '待审核');
  if (text === '测品中') return 'testing';
  if (text === '测品通过') return 'passed';
  if (text === '测品失败') return 'failed';
  if (text === '已转正式商品') return 'converted';
  return 'pending';
}

function sampleSubmitActions(row) {
  const status = row.sample_status || '待审核';
  const actions = [];
  if (status === '待审核') actions.push(['测品中', '开始测品']);
  if (status === '待审核' || status === '测品中') {
    actions.push(['测品通过', '通过']);
    actions.push(['测品失败', '失败']);
  }
  if (status === '测品通过') actions.push(['已转正式商品', '转商品']);
  if (!actions.length) return '<span class="sample-action-done">已完成</span>';
  return `
    <div class="sample-row-actions">
      ${actions.map(([nextStatus, label]) => `
        <button class="sample-action-btn" data-sample-id="${Number(row.id)}" data-next-status="${escapeHtml(nextStatus)}" type="button">${escapeHtml(label)}</button>
      `).join('')}
    </div>
  `;
}

function sampleSubmitModal() {
  return `
    <div class="modal-backdrop" id="sampleSubmitBackdrop">
      <section class="sample-submit-modal">
        <div class="sample-submit-modal-head">
          <div>
            <h3>新增产品提交</h3>
            <p>字段来自桌面《测品流程表.xlsx》</p>
          </div>
          <button class="ghost-btn" id="closeSampleSubmit" type="button">关闭</button>
        </div>
        <form id="sampleSubmitForm" class="sample-submit-form">
          ${sampleSubmitFields.map(sampleSubmitField).join('')}
          <div class="sample-submit-form-foot">
            <div class="error" id="sampleSubmitError"></div>
            <button class="primary-btn" type="submit">提交</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function sampleSubmitField(field) {
  const required = field.required ? 'required' : '';
  if (field.type === 'select') {
    return `
      <label class="sample-field">
        <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
        <select name="${escapeHtml(field.key)}" ${required}>
          <option value="">请选择</option>
          ${(field.options || []).filter(Boolean).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }
  if (field.multiline) {
    return `
      <label class="sample-field sample-field-wide">
        <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
        <textarea name="${escapeHtml(field.key)}" rows="3" ${required}></textarea>
      </label>
    `;
  }
  return `
    <label class="sample-field">
      <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
      <input name="${escapeHtml(field.key)}" type="${field.type || 'text'}" ${required} />
    </label>
  `;
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  const toDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  return { start: toDate(start), end: toDate(end) };
}

function amazonAdsPanel() {
  const range = defaultDateRange();
  const start = state.amazonAdsStart || range.start;
  const end = state.amazonAdsEnd || range.end;
  const payload = state.amazonAds;
  const config = payload?.config || {};
  const summary = payload?.summary || { spend: 0, sales: 0, impressions: 0, clicks: 0, acos: null };
  const rows = payload?.rows || [];
  const configured = Boolean(payload?.configured || config.ready);

  return `
    <section class="panel amazon-ads-panel">
      <div class="panel-head amazon-ads-head">
        <div>
          <h3>亚马逊广告</h3>
          <small>对接领星 ERP 广告模块</small>
        </div>
        <button class="ghost-btn" id="amazonAdsReload" type="button">刷新数据</button>
      </div>

      <div class="amazon-ads-toolbar">
        <label>
          开始日期
          <input id="amazonAdsStart" type="date" value="${escapeHtml(start)}" />
        </label>
        <label>
          结束日期
          <input id="amazonAdsEnd" type="date" value="${escapeHtml(end)}" />
        </label>
        <button class="primary-btn" id="amazonAdsApply" type="button">查询</button>
      </div>

      <div class="amazon-ads-status ${configured ? 'ready' : 'pending'}">
        <strong>${configured ? '领星接口已配置' : '等待配置领星接口'}</strong>
        <span>App ID：${escapeHtml(config.app_id_masked || '-')} · 接口路径：${escapeHtml(config.endpoint_path || '未设置')}</span>
      </div>

      ${payload?.error || payload?.message ? `
        <div class="amazon-ads-alert">${escapeHtml(payload.error || payload.message)}</div>
      ` : ''}

      <div class="amazon-ads-kpis">
        <div><span>广告花费</span><strong>${formatMoney(summary.spend)}</strong></div>
        <div><span>广告销售额</span><strong>${formatMoney(summary.sales)}</strong></div>
        <div><span>曝光</span><strong>${formatNumber(summary.impressions)}</strong></div>
        <div><span>点击</span><strong>${formatNumber(summary.clicks)}</strong></div>
        <div><span>ACOS</span><strong>${summary.acos === null || Number.isNaN(summary.acos) ? '-' : `${formatMoney(summary.acos)}%`}</strong></div>
      </div>

      <div class="amazon-ads-table-wrap">
        <table class="amazon-ads-table">
          <thead>
            <tr>
              <th>广告活动</th>
              <th>店铺</th>
              <th>站点</th>
              <th>花费</th>
              <th>销售额</th>
              <th>曝光</th>
              <th>点击</th>
              <th>ACOS</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${!payload ? '<tr><td colspan="9"><div class="table-empty">正在加载领星广告数据...</div></td></tr>' : amazonAdsRows(rows)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function amazonAdsRows(rows) {
  if (!rows.length) return '<tr><td colspan="9"><div class="table-empty">暂无广告数据</div></td></tr>';
  return rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.campaign_name || '-')}</strong></td>
      <td>${escapeHtml(row.shop_name || '-')}</td>
      <td>${escapeHtml(row.marketplace || '-')}</td>
      <td>${formatMoney(row.spend)}</td>
      <td>${formatMoney(row.sales)}</td>
      <td>${formatNumber(row.impressions)}</td>
      <td>${formatNumber(row.clicks)}</td>
      <td>${row.acos === null || Number.isNaN(row.acos) ? '-' : `${formatMoney(row.acos)}%`}</td>
      <td><span class="amazon-ads-state">${escapeHtml(row.status || '-')}</span></td>
    </tr>
  `).join('');
}

function teamPanel() {
  const payload = state.team || { groups: [], members: [] };
  const groups = payload.groups || [];
  const members = payload.members || [];
  const disabledCount = members.filter((member) => member.status === 'disabled').length;
  const activeCount = members.filter((member) => member.status === 'active').length;
  const selectedGroup = groups.find((group) => group.name === state.teamAddGroup) || groups[0] || { name: '员工' };
  const editingMember = members.find((member) => Number(member.id) === Number(state.teamEditMemberId));
  const filteredMembers = members.filter((member) => {
    const keyword = state.teamSearch.trim().toLowerCase();
    if (state.teamTab === 'disabled' && member.status !== 'disabled') return false;
    if (state.teamTab === 'members' && member.status === 'disabled') return false;
    if (!keyword) return true;
    return [member.name, member.login_name, member.phone, member.remark, member.team_group]
      .some((value) => String(value || '').toLowerCase().includes(keyword));
  });

  return `
    <section class="team-layout">
      <aside class="team-side panel">
        <div class="team-title">团队：奥吉米亚</div>
        <button class="team-side-item ${state.teamTab === 'groups' ? 'active' : ''}" data-team-tab="groups" type="button">
          <span>分组管理</span>
        </button>
        <button class="team-side-item ${state.teamTab === 'members' ? 'active' : ''}" data-team-tab="members" type="button">
          <span>所有成员</span><em>${activeCount}</em>
        </button>
        <button class="team-side-item ${state.teamTab === 'disabled' ? 'active' : ''}" data-team-tab="disabled" type="button">
          <span>已禁用</span><em>${disabledCount}</em>
        </button>
        <button class="team-side-item ${state.teamTab === 'requests' ? 'active' : ''}" data-team-tab="requests" type="button">
          <span>成员申请</span><em>0</em>
        </button>
      </aside>

      <section class="team-main panel">
        <div class="team-toolbar">
          <button class="team-primary" id="openAddMember" type="button">+ 创建成员</button>
          <div class="team-search">
            <input id="teamSearch" type="search" placeholder="请输入分组名称 / 成员 / 手机号" value="${escapeHtml(state.teamSearch)}" />
          </div>
        </div>

        ${state.teamTab === 'groups' ? teamGroupList(groups) : teamMemberList(filteredMembers)}
      </section>

      ${state.teamAddOpen ? teamAddMemberModal(selectedGroup.name, groups) : ''}
      ${editingMember ? teamEditMemberModal(editingMember, groups) : ''}
    </section>
  `;
}

function teamGroupList(groups) {
  if (!state.team) return '<div class="team-empty">正在加载团队数据...</div>';
  if (!groups.length) return '<div class="team-empty">暂无分组</div>';

  return `
    <div class="team-group-list">
      ${groups.map((group) => `
        <article class="team-group-row">
          <div class="team-group-info">
            <strong>${escapeHtml(group.name)}</strong>
            <span>包含账号：${Number(group.member_count || 0)}</span>
          </div>
          <div class="team-group-note">备注：${escapeHtml(group.note || '无')}</div>
          <div class="team-group-actions">
            <button class="team-outline" data-add-to-group="${escapeHtml(group.name)}" type="button">+ 添加成员</button>
            <button class="team-link" type="button">编辑</button>
            <button class="team-link" data-view-group="${escapeHtml(group.name)}" type="button">查看成员</button>
            <button class="team-more" type="button">⋮</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function teamMemberList(members) {
  if (!state.team) return '<div class="team-empty">正在加载团队数据...</div>';
  if (state.teamTab === 'requests') return '<div class="team-empty">暂无成员申请</div>';
  if (!members.length) return '<div class="team-empty">暂无成员</div>';

  return `
    <div class="team-member-table">
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>手机号</th>
            <th>企微 UserID</th>
            <th>备注名</th>
            <th>分组</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${members.map((member) => `
            <tr>
              <td><strong>${escapeHtml(member.name || '-')}</strong></td>
              <td>${escapeHtml(member.phone || '-')}</td>
              <td>${escapeHtml(member.wecom_userid || '-')}</td>
              <td>${escapeHtml(member.remark || '-')}</td>
              <td>${escapeHtml(member.team_group || '-')}</td>
              <td><span class="team-status ${member.status === 'disabled' ? 'disabled' : ''}">${member.status === 'disabled' ? '已禁用' : '启用中'}</span></td>
              <td>
                <button class="team-link" data-edit-member="${Number(member.id)}" type="button">编辑</button>
                <button class="team-link" data-toggle-member="${Number(member.id)}" data-next-status="${member.status === 'disabled' ? 'active' : 'disabled'}" type="button">
                  ${member.status === 'disabled' ? '启用' : '禁用'}
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function teamAddMemberModal(groupName, groups) {
  return `
    <div class="team-modal-backdrop" id="teamModalBackdrop">
      <section class="team-modal" role="dialog" aria-modal="true">
        <div class="team-modal-head">
          <h2>添加成员</h2>
          <button class="team-modal-close" id="closeAddMember" type="button">×</button>
        </div>
        <form class="team-form" id="teamAddForm">
          <label class="team-field required">
            <span>登录账号：</span>
            <input name="name" placeholder="请输入用户名" autocomplete="username" />
          </label>
          <label class="team-field">
            <span>手机号：</span>
            <input name="phone" placeholder="请输入手机号" autocomplete="tel" />
          </label>
          <label class="team-field">
            <span>企微 UserID：</span>
            <input name="wecom_userid" placeholder="例如 wxyu" />
          </label>
          <label class="team-field required">
            <span>备注名：</span>
            <input name="remark" placeholder="请输入备注名" />
          </label>
          <label class="team-field">
            <span>分组名称：</span>
            <select name="group">
              ${groups.map((group) => `<option value="${escapeHtml(group.name)}" ${group.name === groupName ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
            </select>
          </label>
          <div class="team-form-foot">
            <span>默认密码：123456</span>
            <button class="team-primary" type="submit">添加</button>
          </div>
          <div class="error" id="teamAddError"></div>
        </form>
      </section>
    </div>
  `;
}

function teamEditMemberModal(member, groups) {
  return `
    <div class="team-modal-backdrop" id="teamEditModalBackdrop">
      <section class="team-modal" role="dialog" aria-modal="true">
        <div class="team-modal-head">
          <h2>编辑成员</h2>
          <button class="team-modal-close" id="closeEditMember" type="button">×</button>
        </div>
        <form class="team-form" id="teamEditForm">
          <label class="team-field required">
            <span>登录账号：</span>
            <input name="name" value="${escapeHtml(member.name || '')}" autocomplete="username" />
          </label>
          <label class="team-field">
            <span>手机号：</span>
            <input name="phone" value="${escapeHtml(member.phone || '')}" autocomplete="tel" />
          </label>
          <label class="team-field">
            <span>企微 UserID：</span>
            <input name="wecom_userid" value="${escapeHtml(member.wecom_userid || '')}" placeholder="例如 wxyu" />
          </label>
          <label class="team-field required">
            <span>备注名：</span>
            <input name="remark" value="${escapeHtml(member.remark || member.name || '')}" />
          </label>
          <label class="team-field">
            <span>分组名称：</span>
            <select name="group">
              ${groups.map((group) => `<option value="${escapeHtml(group.name)}" ${group.name === member.team_group ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
            </select>
          </label>
          <div class="team-form-foot">
            <button class="team-outline" id="cancelEditMember" type="button">取消</button>
            <button class="team-primary" type="submit">保存</button>
          </div>
          <div class="error" id="teamEditError"></div>
        </form>
      </section>
    </div>
  `;
}

function weeklyReportPanel() {
  const payload = state.weeklyReport;
  if (!payload) {
    return '<section class="weekly-panel panel"><div class="team-empty">正在加载周报数据...</div></section>';
  }

  return `
    <section class="weekly-panel panel">
      <div class="weekly-page-head">
        <div>
          <h2>周报提交</h2>
          <p>按周报模板填写BD工作、亚马逊工作、学习与改进事项。</p>
        </div>
        ${payload.is_admin ? '<button class="team-outline" type="button">导出表格</button>' : '<button class="team-primary" id="openWeeklyForm" type="button">新增周报</button>'}
      </div>
      <div class="weekly-search"><input type="search" placeholder="搜索姓名、周期、BD数据、亚马逊工作、学习、改进事项"></div>
      ${payload.is_admin ? weeklyAdminView(payload) : weeklyEmployeeView(payload)}
    </section>
  `;
}

function weeklyEmployeeView(payload) {
  const statuses = payload.week_statuses || [];
  const report = state.weeklyFormOpen ? (payload.my_report || {}) : {};
  return `
    ${state.weeklyFormOpen ? weeklyEmployeeForm(payload, report) : ''}
    <div class="weekly-table">
      <table>
        <thead><tr><th>时间</th><th>是否已提交</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          ${statuses.map((week) => `
            <tr>
              <td>${escapeHtml(formatWeekShort(week.label))}</td>
              <td><span class="team-status ${week.my_submitted ? '' : 'disabled'}">${week.my_submitted ? '已提交' : '未提交'}</span></td>
              <td>${escapeHtml(formatDateTime(week.my_updated_at) || '-')}</td>
              <td>
                <button class="team-link" data-weekly-edit="${escapeHtml(week.value)}" type="button">${week.my_submitted ? '编辑' : '填写'}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function weeklyEmployeeForm(payload, report) {
  return `
    <form class="weekly-form" id="weeklyReportForm">
      <div class="weekly-status-card">
        <div>
          <b>${payload.my_report ? '编辑周报' : '新增周报'}</b>
          <span>${escapeHtml(payload.selected_week_label || '')}</span>
        </div>
        <button class="team-primary" type="submit">${payload.my_report ? '更新周报' : '提交周报'}</button>
      </div>
      ${weeklyField('work_content', '本周工作内容', report.work_content)}
      ${weeklyField('new_skills', '本周新技能', report.new_skills)}
      ${weeklyField('shortcomings', '不足之处', report.shortcomings)}
      ${weeklyField('needs', '需要公司协调或改进的', report.needs)}
      ${weeklyField('next_focus', '下周工作重点', report.next_focus)}
      ${report.admin_comment ? `<div class="weekly-comment-readonly"><b>管理员点评</b><p>${escapeHtml(report.admin_comment)}</p></div>` : ''}
      <div class="error" id="weeklyError"></div>
    </form>
  `;
}

function weeklyField(name, label, value = '') {
  return `
    <label class="weekly-field">
      <span>${escapeHtml(label)}</span>
      <textarea name="${escapeHtml(name)}" rows="4" placeholder="请输入${escapeHtml(label)}">${escapeHtml(value || '')}</textarea>
    </label>
  `;
}

function weeklyAdminView(payload) {
  const statuses = payload.week_statuses || [];
  const reports = payload.reports || [];
  const missing = payload.missing_members || [];

  return `
    <div class="weekly-table">
      <table>
        <thead><tr><th>时间</th><th>已提交</th><th>未提交</th><th>操作</th></tr></thead>
        <tbody>
          ${statuses.map((week) => `
            <tr class="${week.value === payload.selected_week_start ? 'weekly-selected-row' : ''}">
              <td>${escapeHtml(formatWeekShort(week.label))}</td>
              <td>${Number(week.submitted || 0)}</td>
              <td>${Number(week.missing || 0)}</td>
              <td><button class="team-link" data-weekly-view="${escapeHtml(week.value)}" type="button">查看</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="weekly-admin-grid">
      <section class="weekly-list">
        <div class="weekly-section-title">${escapeHtml(payload.selected_week_label || '')} 已提交周报清单</div>
        ${reports.length ? reports.map(weeklyReportCard).join('') : '<div class="team-empty">当前自然周暂无已提交周报</div>'}
      </section>
      <section class="weekly-missing">
        <div class="weekly-section-title">未提交人员</div>
        ${missing.length ? missing.map((member) => `
          <div class="weekly-missing-row">
            <strong>${escapeHtml(member.name)}</strong>
            <span>${escapeHtml(member.team_group || '-')}</span>
          </div>
        `).join('') : '<div class="weekly-ok">本周所有员工已提交</div>'}
      </section>
    </div>
  `;
}

function weeklyReportCard(report) {
  return `
    <article class="weekly-report-card">
      <div class="weekly-report-head">
        <div><strong>${escapeHtml(report.user_name)}</strong><span>${escapeHtml(report.team_group || '-')} · ${escapeHtml(report.submitted_at || '')}</span></div>
        <button class="team-outline" data-save-weekly-comment="${Number(report.id)}" type="button">保存点评</button>
      </div>
      <div class="weekly-report-body">
        <div><b>本周工作内容</b><p>${escapeHtml(report.work_content || '-')}</p></div>
        <div><b>本周新技能</b><p>${escapeHtml(report.new_skills || '-')}</p></div>
        <div><b>不足之处</b><p>${escapeHtml(report.shortcomings || '-')}</p></div>
        <div><b>需要公司协调或改进的</b><p>${escapeHtml(report.needs || '-')}</p></div>
        <div><b>下周工作重点</b><p>${escapeHtml(report.next_focus || '-')}</p></div>
      </div>
      <label class="weekly-comment">
        <span>管理员点评</span>
        <textarea rows="3" data-weekly-comment="${Number(report.id)}" placeholder="请输入点评">${escapeHtml(report.admin_comment || '')}</textarea>
      </label>
    </article>
  `;
}

function formatWeekShort(label) {
  const parts = String(label || '').split(' 至 ');
  if (parts.length !== 2) return String(label || '');
  return `${formatMonthDay(parts[0])} - ${formatMonthDay(parts[1])}`;
}

function formatMonthDay(value) {
  const match = String(value || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function formatDateTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

function bindLogin() {
  const form = document.getElementById('loginForm');
  const memberName = document.getElementById('memberName');
  const password = document.getElementById('password');
  const error = document.getElementById('loginError');

  memberName.addEventListener('change', () => {
    error.textContent = '';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: memberName.value.trim(),
        password: password.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      error.textContent = payload.error || '登录失败';
      return;
    }
    state.auth = payload.user;
    state.activeModule = 'home';
    state.openGroup = null;
    await bootstrap();
  });
}

function bindDashboard() {
  document.querySelectorAll('[data-group]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = navGroups.find((entry) => entry.id === button.dataset.group);
      const firstItem = group?.items?.[0];
      if (firstItem) {
        state.activeModule = firstItem.id;
        state.openGroup = group.id;
      } else {
        state.openGroup = state.openGroup === button.dataset.group ? null : button.dataset.group;
      }
      render();
    });
  });

  document.querySelectorAll('[data-module]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeModule = button.dataset.module;
      if (state.activeModule === 'home') state.openGroup = null;
      render();
    });
  });

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    state.auth = null;
    state.dashboard = null;
    state.activeModule = 'home';
    state.openGroup = null;
    render();
  });

  if (state.activeModule === 'tk-products') {
    bindTkProducts();
    if (!state.tkProducts || state.tkProducts.shop !== state.tkProductShop) {
      loadTkProducts();
    }
  }

  if (state.activeModule === 'amazon-ads') {
    bindAmazonAds();
    if (!state.amazonAds) loadAmazonAds();
  }

  if (state.activeModule === 'team') {
    bindTeam();
    if (!state.team) loadTeam();
  }

  if (state.activeModule === 'weekly-report') {
    bindWeeklyReport();
    if (!state.weeklyReport) loadWeeklyReport();
  }
}

function bindTkProducts() {
  document.querySelectorAll('[data-tk-product-shop]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tkProductShop = button.dataset.tkProductShop;
      state.tkProducts = null;
      render();
    });
  });

  document.getElementById('tkProductReload')?.addEventListener('click', () => {
    state.tkProducts = null;
    render();
    loadTkProducts();
  });

  const search = document.getElementById('tkProductSearch');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.tkProductSearch = search.value.trim();
        loadTkProducts();
      }, 250);
    });
  }
}

async function loadTkProducts() {
  const params = new URLSearchParams({ shop: state.tkProductShop });
  if (state.tkProductSearch) params.set('search', state.tkProductSearch);

  try {
    const response = await fetch(`/api/tk/products?${params.toString()}`);
    if (!response.ok) throw new Error('商品数据加载失败');
    state.tkProducts = await response.json();
    render();
  } catch (error) {
    state.tkProducts = {
      shop: state.tkProductShop,
      shops: [
        { id: 'oku', name: 'OKUYOSHI', product_count: 0 },
        { id: 'mir', name: 'MIR HOME', product_count: 0 },
      ],
      summary: { total: 0, active: 0, synced: 0 },
      products: [],
      error: error.message,
    };
    render();
  }
}

function bindAmazonAds() {
  const range = defaultDateRange();
  if (!state.amazonAdsStart) state.amazonAdsStart = range.start;
  if (!state.amazonAdsEnd) state.amazonAdsEnd = range.end;

  const startInput = document.getElementById('amazonAdsStart');
  const endInput = document.getElementById('amazonAdsEnd');
  const applyRange = () => {
    state.amazonAdsStart = startInput?.value || state.amazonAdsStart;
    state.amazonAdsEnd = endInput?.value || state.amazonAdsEnd;
    state.amazonAds = null;
    render();
    loadAmazonAds();
  };

  document.getElementById('amazonAdsApply')?.addEventListener('click', applyRange);
  document.getElementById('amazonAdsReload')?.addEventListener('click', () => {
    state.amazonAds = null;
    render();
    loadAmazonAds();
  });
}

async function loadAmazonAds() {
  const range = defaultDateRange();
  if (!state.amazonAdsStart) state.amazonAdsStart = range.start;
  if (!state.amazonAdsEnd) state.amazonAdsEnd = range.end;

  const params = new URLSearchParams({
    start_date: state.amazonAdsStart,
    end_date: state.amazonAdsEnd,
  });

  try {
    const response = await fetch(`/api/amazon-ads/overview?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || '领星广告数据加载失败');
    }
    state.amazonAds = payload;
    render();
  } catch (error) {
    let config = {};
    try {
      const response = await fetch('/api/amazon-ads/config');
      config = response.ok ? await response.json() : {};
    } catch {
      config = {};
    }
    state.amazonAds = {
      configured: false,
      config,
      summary: { spend: 0, sales: 0, impressions: 0, clicks: 0, acos: null },
      rows: [],
      error: error.message,
    };
    render();
  }
}

function bindSampleSubmit() {
  document.getElementById('openSampleSubmit')?.addEventListener('click', () => {
    state.sampleSubmitOpen = true;
    render();
  });

  document.getElementById('closeSampleSubmit')?.addEventListener('click', () => {
    state.sampleSubmitOpen = false;
    render();
  });

  document.getElementById('sampleSubmitBackdrop')?.addEventListener('click', (event) => {
    if (event.target?.id === 'sampleSubmitBackdrop') {
      state.sampleSubmitOpen = false;
      render();
    }
  });

  document.querySelectorAll('[data-sample-status]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sampleSubmitStatus = button.dataset.sampleStatus || 'all';
      state.sampleSubmissions = null;
      render();
      loadSampleSubmissions();
    });
  });

  document.getElementById('sampleSubmitReload')?.addEventListener('click', () => {
    state.sampleSubmissions = null;
    render();
    loadSampleSubmissions();
  });

  const search = document.getElementById('sampleSubmitSearch');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.sampleSubmitSearch = search.value.trim();
        state.sampleSubmissions = null;
        loadSampleSubmissions();
      }, 260);
    });
  }

  document.getElementById('sampleSubmitForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('sampleSubmitError');
    if (error) error.textContent = '';
    const formData = new FormData(event.currentTarget);
    const payload = {};
    for (const field of sampleSubmitFields) {
      payload[field.key] = String(formData.get(field.key) || '').trim();
    }
    if (!payload.sample_status) payload.sample_status = '待审核';

    const response = await fetch('/api/sample-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (error) error.textContent = result.error || '测品提交失败';
      return;
    }
    state.sampleSubmitOpen = false;
    state.sampleSubmissions = null;
    showAppToast('测品提交成功');
    await loadSampleSubmissions();
  });

  document.querySelectorAll('[data-sample-id][data-next-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.sampleId);
      const nextStatus = button.dataset.nextStatus;
      const note = nextStatus === '已转正式商品'
        ? '已确认转入正式商品流程'
        : `${state.auth?.name || '系统'} 更新为 ${nextStatus}`;
      const response = await fetch(`/api/sample-submissions/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_status: nextStatus, review_note: note }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        showAppToast(result.error || '状态更新失败');
        return;
      }
      state.sampleSubmissions = null;
      showAppToast('测品流程已更新');
      await loadSampleSubmissions();
    });
  });
}

async function loadSampleSubmissions() {
  const params = new URLSearchParams();
  if (state.sampleSubmitSearch) params.set('search', state.sampleSubmitSearch);
  if (state.sampleSubmitStatus && state.sampleSubmitStatus !== 'all') {
    params.set('status', state.sampleSubmitStatus);
  }

  try {
    const response = await fetch(`/api/sample-submissions?${params.toString()}`);
    if (!response.ok) throw new Error('测品提交数据加载失败');
    state.sampleSubmissions = await response.json();
    render();
  } catch (error) {
    state.sampleSubmissions = {
      summary: { total: 0, pending: 0, testing: 0, passed: 0, failed: 0, converted: 0 },
      submissions: [],
      error: error.message,
    };
    render();
  }
}

function bindTeam() {
  document.querySelectorAll('[data-team-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.teamTab = button.dataset.teamTab;
      render();
    });
  });

  document.querySelectorAll('[data-add-to-group]').forEach((button) => {
    button.addEventListener('click', () => {
      state.teamAddGroup = button.dataset.addToGroup;
      state.teamAddOpen = true;
      render();
    });
  });

  document.querySelectorAll('[data-view-group]').forEach((button) => {
    button.addEventListener('click', () => {
      state.teamTab = 'members';
      state.teamSearch = button.dataset.viewGroup;
      render();
    });
  });

  document.getElementById('openAddMember')?.addEventListener('click', () => {
    state.teamAddOpen = true;
    render();
  });

  document.getElementById('closeAddMember')?.addEventListener('click', () => {
    state.teamAddOpen = false;
    render();
  });

  document.getElementById('closeEditMember')?.addEventListener('click', () => {
    state.teamEditMemberId = null;
    render();
  });

  document.getElementById('cancelEditMember')?.addEventListener('click', () => {
    state.teamEditMemberId = null;
    render();
  });

  document.getElementById('teamModalBackdrop')?.addEventListener('click', (event) => {
    if (event.target.id === 'teamModalBackdrop') {
      state.teamAddOpen = false;
      render();
    }
  });

  document.getElementById('teamEditModalBackdrop')?.addEventListener('click', (event) => {
    if (event.target.id === 'teamEditModalBackdrop') {
      state.teamEditMemberId = null;
      render();
    }
  });

  const search = document.getElementById('teamSearch');
  if (search) {
    search.addEventListener('input', () => {
      state.teamSearch = search.value.trim();
      render();
    });
  }

  document.querySelectorAll('[data-toggle-member]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.toggleMember;
      const status = button.dataset.nextStatus;
      await fetch(`/api/team/members/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await loadTeam();
    });
  });

  document.querySelectorAll('[data-edit-member]').forEach((button) => {
    button.addEventListener('click', () => {
      state.teamEditMemberId = Number(button.dataset.editMember);
      render();
    });
  });

  document.getElementById('teamAddForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('teamAddError');
    if (error) error.textContent = '';
    const formData = new FormData(event.currentTarget);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      phone: String(formData.get('phone') || '').trim(),
      wecom_userid: String(formData.get('wecom_userid') || '').trim(),
      remark: String(formData.get('remark') || '').trim(),
      group: String(formData.get('group') || state.teamAddGroup).trim(),
    };
    const response = await fetch('/api/team/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (error) error.textContent = result.error || '添加成员失败';
      return;
    }
    state.teamAddOpen = false;
    await loadTeam();
  });

  document.getElementById('teamEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('teamEditError');
    if (error) error.textContent = '';
    const formData = new FormData(event.currentTarget);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      phone: String(formData.get('phone') || '').trim(),
      wecom_userid: String(formData.get('wecom_userid') || '').trim(),
      remark: String(formData.get('remark') || '').trim(),
      group: String(formData.get('group') || state.teamAddGroup).trim(),
    };
    const response = await fetch(`/api/team/members/${state.teamEditMemberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (error) error.textContent = result.error || '保存成员失败';
      return;
    }
    state.teamEditMemberId = null;
    await loadTeam();
  });
}

async function loadTeam() {
  try {
    const response = await fetch('/api/team');
    if (!response.ok) throw new Error('团队数据加载失败');
    state.team = await response.json();
    render();
  } catch (error) {
    state.team = { groups: [], members: [], error: error.message };
    render();
  }
}

function bindWeeklyReport() {
  document.getElementById('openWeeklyForm')?.addEventListener('click', () => {
    const current = state.weeklyReport?.selected_week_start || state.weeklyReport?.week_statuses?.[0]?.value || '';
    state.weeklyWeekStart = current;
    state.weeklyFormOpen = true;
    state.weeklyReport = null;
    render();
    loadWeeklyReport(true);
  });

  document.querySelectorAll('[data-weekly-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      state.weeklyWeekStart = button.dataset.weeklyEdit;
      state.weeklyFormOpen = true;
      state.weeklyReport = null;
      render();
      loadWeeklyReport(true);
    });
  });

  document.querySelectorAll('[data-weekly-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.weeklyWeekStart = button.dataset.weeklyView;
      state.weeklyReport = null;
      render();
      loadWeeklyReport();
    });
  });

  document.getElementById('weeklyReportForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('weeklyError');
    if (error) error.textContent = '';
    const formData = new FormData(event.currentTarget);
    const payload = {
      week_start: state.weeklyReport?.selected_week_start || state.weeklyWeekStart,
      work_content: String(formData.get('work_content') || '').trim(),
      new_skills: String(formData.get('new_skills') || '').trim(),
      shortcomings: String(formData.get('shortcomings') || '').trim(),
      needs: String(formData.get('needs') || '').trim(),
      next_focus: String(formData.get('next_focus') || '').trim(),
    };
    const response = await fetch('/api/weekly-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (error) error.textContent = result.error || '周报提交失败';
      return;
    }
    state.weeklyFormOpen = false;
    showAppToast('周报保存成功');
    goHomeSoon();
  });

  document.querySelectorAll('[data-save-weekly-comment]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.saveWeeklyComment;
      const textarea = document.querySelector(`[data-weekly-comment="${id}"]`);
      await fetch(`/api/weekly-reports/${id}/comment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: textarea?.value || '' }),
      });
      showAppToast('点评保存成功');
      await loadWeeklyReport();
    });
  });
}

async function loadWeeklyReport(scrollToForm = false) {
  try {
    const params = new URLSearchParams();
    if (state.weeklyWeekStart) params.set('week_start', state.weeklyWeekStart);
    const response = await fetch(`/api/weekly-reports?${params.toString()}`);
    if (!response.ok) throw new Error('周报数据加载失败');
    state.weeklyReport = await response.json();
    state.weeklyWeekStart = state.weeklyReport.selected_week_start;
    render();
    if (scrollToForm) {
      document.getElementById('weeklyReportForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    state.weeklyReport = {
      is_admin: state.auth?.role === 'admin',
      week_options: [],
      summary: { total_members: 0, submitted: 0, missing: 0 },
      reports: [],
      missing_members: [],
      error: error.message,
    };
    render();
  }
}

async function loadMembers() {
  try {
    const response = await fetch('/api/members');
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.members) && payload.members.length > 0) {
      memberNames = payload.members
        .map((member) => member.name);
    }
  } catch {
    memberNames = [...fallbackMemberNames];
  }
}

async function bootstrap() {
  render();

  loadMembers()
    .then(() => {
      if (!state.auth) render();
    })
    .catch(() => {
      memberNames = [...fallbackMemberNames];
      if (!state.auth) render();
    });

  const me = await fetch('/api/me');
  if (!me.ok) {
    state.auth = null;
    render();
    return;
  }
  state.auth = (await me.json()).user;

  const dashboard = await fetch('/api/dashboard');
  state.dashboard = dashboard.ok ? (await dashboard.json()) : null;
  render();
}

bootstrap().catch((error) => {
  console.error('ERP bootstrap failed', error);
  state.auth = null;
  render();
});
