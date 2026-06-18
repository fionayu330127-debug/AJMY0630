const app = document.getElementById('app');

const state = {
  auth: null,
  dashboard: null,
  activeModule: 'home',
  openGroup: null,
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
      { id: 'sample-submit', label: '测品提交' },
      { id: 'operation-tracking', label: '运营跟踪' },
    ],
  },
  {
    id: 'selection-center',
    title: '选品中心',
    icon: '选',
    items: [
      { id: 'aba-data', label: 'ABA 数据' },
    ],
  },
  { id: 'inventory-center', title: '库存货件', icon: '库', items: [{ id: 'inventory', label: '库存货件' }] },
  { id: 'logistics-center', title: '物流中心', icon: '流', items: [{ id: 'logistics', label: '物流中心' }] },
  { id: 'purchase-center', title: '采购中心', icon: '采', items: [{ id: 'purchase', label: '采购中心' }] },
  { id: 'finance-center', title: '财务中心', icon: '财', items: [{ id: 'finance', label: '财务中心' }] },
  { id: 'team-center', title: '团队管理', icon: '人', items: [{ id: 'team', label: '团队管理' }] },
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
  const memberOptions = memberNames.map((name) => `
    <option value="${escapeHtml(name)}">${escapeHtml(name)}</option>
  `).join('');

  return `
    <main class="screen auth-shell">
      <section class="brand-pane">
        <div class="brand-visual">
          <img class="login-logo" src="/assets/ajmy-logo.png" alt="AJMY" />
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
                ${memberOptions}
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
        <img class="sidebar-logo" src="/assets/ajmy-logo.png" alt="AJMY" />
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
  if (active.id === 'tk-creator') {
    return `
      <section class="panel work-panel">
        <div class="panel-head">
          <h3>TK 达人管理系统</h3>
          <small>/tk/</small>
        </div>
        <div class="module-frame">
          <iframe src="/tk/" title="TK 达人管理系统"></iframe>
        </div>
        <div class="footer-row">
          <span>TK 模块已并入当前 ERP 服务。</span>
          <span>ERP 主库：PostgreSQL / TK 模块数据后续继续并库</span>
        </div>
      </section>
    `;
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

function bindLogin() {
  const form = document.getElementById('loginForm');
  const memberName = document.getElementById('memberName');
  const password = document.getElementById('password');
  const error = document.getElementById('loginError');

  memberName.addEventListener('change', () => {
    error.textContent = '';
    password.value = '123456';
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
      state.openGroup = state.openGroup === button.dataset.group ? null : button.dataset.group;
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
}

async function loadMembers() {
  try {
    const response = await fetch('/api/members');
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.members) && payload.members.length > 0) {
      memberNames = payload.members
        .filter((member) => member.role !== 'admin')
        .map((member) => member.name);
    }
  } catch {
    memberNames = [...fallbackMemberNames];
  }
}

async function bootstrap() {
  await loadMembers();

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

bootstrap().catch(() => {
  state.auth = null;
  render();
});
