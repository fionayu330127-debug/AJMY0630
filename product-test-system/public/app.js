const app = document.getElementById('app');

const state = {
  config: null,
  payload: null,
  currentUser: null,
  teamMembers: [],
  search: '',
  status: 'all',
  modalOpen: false,
  editingId: null,
  importing: false,
};

const fields = [
  { key: 'sample_status', label: '刊登流程', type: 'select', options: ['链接刊登提交', '刊登人填写ASIN', '确认是否已开广告', '刊登异常', '链接上架成功'] },
  { key: 'listing_status', label: '刊登状态', type: 'select', options: ['待提交', '待刊登', '已刊登', '暂停'] },
  { key: 'urgency', label: '紧急程度', type: 'select', options: ['⭐⭐⭐', '⭐⭐', '⭐', '普通'] },
  { key: 'submit_date', label: '提交日期', type: 'date' },
  { key: 'developer', label: '开发人', type: 'select', optionsSource: 'teamMembers' },
  { key: 'lister', label: '刊登人', type: 'select', optionsSource: 'teamMembers' },
  { key: 'product_name', label: '产品名称' },
  { key: 'product_keywords', label: '产品关键词', required: true },
  { key: 'brand', label: '品牌', required: true },
  { key: 'store_name', label: '上架店铺', required: true },
  { key: 'variant_name', label: '变体名称', multiline: true },
  { key: 'source_url', label: '1688链接', multiline: true },
  { key: 'product_image', label: '产品图片', type: 'image', wide: true },
  { key: 'product_note', label: '产品说明', multiline: true },
  { key: 'price_jp', label: '售价（JP）' },
  { key: 'erp_listed', label: 'ERP是否刊登？', type: 'select', options: ['否', '是'] },
  { key: 'direct_review', label: '是否上直评', type: 'select', options: ['否', '是'] },
  { key: 'ads_enabled', label: '是否开广告', type: 'select', options: ['否', '是'] },
  { key: 'amazon_asin', label: '亚马逊ASIN' },
  { key: 'product_sku', label: '产品SKU' },
];

const tableFields = [
  { key: 'sample_status', label: '状态', type: 'select', options: ['链接刊登提交', '刊登人填写ASIN', '确认是否已开广告', '刊登异常', '链接上架成功'] },
  { key: 'urgency', label: '紧急', type: 'select', options: ['⭐⭐⭐', '⭐⭐', '⭐', '普通'] },
  { key: 'submit_date', label: '提交日期', type: 'date' },
  { key: 'product_image', label: '产品图片' },
  { key: 'product_name', label: '产品名称' },
  { key: 'lister', label: '刊登人', type: 'select', optionsSource: 'teamMembers' },
  { key: 'brand', label: '品牌', required: true },
  { key: 'store_name', label: '店铺', required: true },
  { key: 'price_jp', label: '售价JP' },
  { key: 'submitter_name', label: '提交人' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusKey(status) {
  const text = String(status || '链接刊登提交');
  if (text === '刊登人填写ASIN' || text === '测品中') return 'testing';
  if (text === '确认是否已开广告' || text === '测品通过') return 'passed';
  if (text === '刊登异常' || text === '测品失败') return 'failed';
  if (text === '链接上架成功' || text === '已转正式商品') return 'converted';
  return 'pending';
}

function formatDateTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').slice(0, 16);
}

function render() {
  const rows = state.payload?.submissions || [];
  const summary = state.payload?.summary || {};
  const tabs = [
    ['all', '全部', summary.total || 0],
    ['pending', '待提交', summary.pending || 0],
    ['testing', '待填ASIN', summary.testing || 0],
    ['passed', '待确认广告', summary.passed || 0],
    ['failed', '异常', summary.failed || 0],
    ['converted', '上架成功', summary.converted || 0],
  ];

  app.innerHTML = `
    <section class="module-shell">
      <header class="module-head">
        <div>
          <h1>链接刊登</h1>
          <p>链接刊登流程，配置、页面、接口与数据文件均在 product-test-system 模块内。</p>
        </div>
        <div class="head-actions">
          <button class="ghost-btn" id="reloadBtn" type="button">刷新清单</button>
          <button class="ghost-btn" id="downloadTemplateBtn" type="button">下载导入模板</button>
          <button class="ghost-btn" id="importBtn" type="button">${state.importing ? '导入中...' : '导入'}</button>
          <input id="importFile" type="file" accept=".csv,.json,application/json,text/csv" hidden>
          <button class="primary-btn" id="openModal" type="button">新增链接刊登提交</button>
        </div>
      </header>

      <section class="process-strip">
        <div class="process-step active"><b>1</b><span>链接刊登提交</span></div>
        <div class="process-step"><b>2</b><span>刊登人填写ASIN</span></div>
        <div class="process-step"><b>3</b><span>选择是否已开广告</span></div>
        <div class="process-step"><b>4</b><span>链接上架成功</span></div>
      </section>

      <input class="search-input" id="searchInput" type="search" placeholder="搜索关键词 / 品牌 / 店铺 / 说明 / 链接" value="${escapeHtml(state.search)}">

      <nav class="status-tabs">
        ${tabs.map(([id, label, count]) => `
          <button class="${state.status === id ? 'active' : ''}" data-status="${id}" type="button">${escapeHtml(label)} <em>${Number(count)}</em></button>
        `).join('')}
      </nav>

      <section class="kpi-grid">
        <div><span>待提交</span><strong>${Number(summary.pending || 0)}</strong></div>
        <div><span>待填ASIN</span><strong>${Number(summary.testing || 0)}</strong></div>
        <div><span>待确认广告</span><strong>${Number(summary.passed || 0)}</strong></div>
        <div><span>上架成功</span><strong>${Number(summary.converted || 0)}</strong></div>
      </section>

      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              ${tableFields.map((field) => `<th>${escapeHtml(field.label)}</th>`).join('')}
              <th>操作</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>${state.payload ? rowsView(rows) : '<tr><td colspan="12"><div class="empty">正在加载提交清单...</div></td></tr>'}</tbody>
        </table>
      </section>
      ${state.modalOpen ? modalView() : ''}
    </section>
  `;
  bind();
}

function rowsView(rows) {
  if (!rows.length) return '<tr><td colspan="12"><div class="empty">暂无链接刊登提交记录</div></td></tr>';
  return rows.map((row) => `
    <tr>
      ${tableFields.map((field) => `<td>${readonlyCell(field, row)}</td>`).join('')}
      <td>${actionsView(row)}</td>
      <td>${escapeHtml(formatDateTime(row.created_at))}</td>
    </tr>
  `).join('');
}

function readonlyCell(field, row) {
  const value = row[field.key];
  if (field.key === 'sample_status') {
    const current = value || '链接刊登提交';
    return `
      <select class="status-select ${statusKey(current)}" data-row-status-id="${Number(row.id)}">
        ${(field.options || []).map((option) => `<option value="${escapeHtml(option)}" ${option === current ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      </select>
    `;
  }
  if (field.key === 'submit_date') {
    return escapeHtml(String(value || '').slice(0, 10) || '-');
  }
  if (field.key === 'product_keywords') {
    return `<div class="main-cell"><strong>${escapeHtml(value || '-')}</strong>${row.source_url ? `<a href="${escapeHtml(row.source_url)}" target="_blank" rel="noopener">1688链接</a>` : ''}</div>`;
  }
  if (field.key === 'product_image') {
    return value
      ? `<img class="table-thumb" src="${escapeHtml(imagePreviewSrc(value))}" alt="产品图片">`
      : '<span class="muted">-</span>';
  }
  if (field.key === 'submitter_name') {
    return escapeHtml(value || row.submitter || '-');
  }
  return escapeHtml(value || '-');
}

function actionsView(row) {
  return `<div class="row-actions"><button data-edit-id="${Number(row.id)}" type="button">编辑</button></div>`;
}

function modalView() {
  const editingRow = currentEditingRow();
  const isEditing = Boolean(editingRow);
  return `
    <div class="modal-backdrop" id="modalBackdrop">
      <section class="modal">
        <header>
          <div>
            <h2>${isEditing ? '编辑链接刊登提交' : '新增链接刊登提交'}</h2>
            <p>${isEditing ? '修改后点击保存，列表信息会同步更新。' : '记录保存在当前独立模块的数据文件中。'}</p>
          </div>
          <button class="ghost-btn" id="closeModal" type="button">关闭</button>
        </header>
        <form id="submitForm" class="form-grid">
          ${fields.map((field) => fieldView(field, editingRow)).join('')}
          <footer>
            <div class="error" id="formError"></div>
            <button class="primary-btn" type="submit">${isEditing ? '保存' : '提交'}</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}

function currentEditingRow() {
  if (!state.editingId) return null;
  return (state.payload?.submissions || []).find((row) => Number(row.id) === Number(state.editingId)) || null;
}

function fieldValue(field, row) {
  if (!row) return '';
  const value = row[field.key] || '';
  if (field.type === 'date') return String(value).slice(0, 10);
  return String(value);
}

function imagePreviewSrc(value) {
  const text = String(value || '');
  if (!/^https?:\/\//i.test(text)) return text;
  return `./api/image-proxy?url=${encodeURIComponent(text)}`;
}

function fieldView(field, row = null) {
  const required = field.required ? 'required' : '';
  const value = fieldValue(field, row);
  if (field.type === 'image') {
    return `
      <label class="wide image-field">
        <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
        <input name="${escapeHtml(field.key)}" type="hidden" value="${escapeHtml(value)}" ${required}>
        <div class="image-tool">
          <div class="image-preview" data-image-preview>
            ${value ? `<img src="${escapeHtml(imagePreviewSrc(value))}" alt="${escapeHtml(field.label)}">` : '<span>暂无图片</span>'}
          </div>
          <div class="image-actions">
            <button class="ghost-btn" data-fetch-image type="button">自动抓取首图</button>
            <label class="upload-btn">
              <input data-upload-image type="file" accept="image/*">
              上传图片
            </label>
            <button class="ghost-btn" data-clear-image type="button">清空</button>
            <small data-image-message></small>
          </div>
        </div>
      </label>
    `;
  }
  if (field.type === 'select') {
    const options = field.optionsSource === 'teamMembers' ? state.teamMembers : field.options || [];
    return `
      <label>
        <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
        <select name="${escapeHtml(field.key)}" ${required}>
          <option value="">请选择</option>
          ${options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }
  if (field.multiline) {
    if (field.key === 'source_url') {
      return `
        <label class="wide link-field">
          <span>
            ${escapeHtml(field.label)}${field.required ? ' *' : ''}
            <button class="link-open-btn" data-open-source-url type="button">在网页端打开链接</button>
          </span>
          <textarea name="${escapeHtml(field.key)}" rows="3" ${required}>${escapeHtml(value)}</textarea>
        </label>
      `;
    }
    return `
      <label class="wide">
        <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
        <textarea name="${escapeHtml(field.key)}" rows="3" ${required}>${escapeHtml(value)}</textarea>
      </label>
    `;
  }
  return `
    <label>
      <span>${escapeHtml(field.label)}${field.required ? ' *' : ''}</span>
      <input name="${escapeHtml(field.key)}" type="${field.type || 'text'}" value="${escapeHtml(value)}" ${required}>
    </label>
  `;
}

function bind() {
  document.getElementById('reloadBtn')?.addEventListener('click', loadSubmissions);
  document.getElementById('openModal')?.addEventListener('click', () => {
    state.modalOpen = true;
    state.editingId = null;
    render();
  });
  document.getElementById('importBtn')?.addEventListener('click', () => {
    document.getElementById('importFile')?.click();
  });
  document.getElementById('downloadTemplateBtn')?.addEventListener('click', downloadImportTemplate);
  document.getElementById('importFile')?.addEventListener('change', importFile);
  document.getElementById('closeModal')?.addEventListener('click', () => {
    state.modalOpen = false;
    state.editingId = null;
    render();
  });
  document.getElementById('modalBackdrop')?.addEventListener('click', (event) => {
    if (event.target?.id === 'modalBackdrop') {
      state.modalOpen = false;
      state.editingId = null;
      render();
    }
  });
  document.querySelectorAll('[data-status]').forEach((button) => {
    button.addEventListener('click', () => {
      state.status = button.dataset.status || 'all';
      state.payload = null;
      render();
      loadSubmissions();
    });
  });
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    let timer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.search = searchInput.value.trim();
        state.payload = null;
        loadSubmissions();
      }, 260);
    });
  }
  document.getElementById('submitForm')?.addEventListener('submit', submitForm);
  document.querySelectorAll('[data-fetch-image]').forEach((button) => {
    button.addEventListener('click', fetchProductImage);
  });
  document.querySelectorAll('[data-upload-image]').forEach((input) => {
    input.addEventListener('change', uploadProductImage);
  });
  document.querySelectorAll('[data-clear-image]').forEach((button) => {
    button.addEventListener('click', clearProductImage);
  });
  document.querySelectorAll('[data-open-source-url]').forEach((button) => {
    button.addEventListener('click', openSourceUrl);
  });
  document.querySelectorAll('[data-edit-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingId = Number(button.dataset.editId);
      state.modalOpen = true;
      render();
    });
  });
  document.querySelectorAll('[data-row-status-id]').forEach((select) => {
    select.addEventListener('change', () => updateRowStatus(Number(select.dataset.rowStatusId), select.value));
  });
}

async function updateRowStatus(id, status) {
  const response = await fetch(`./api/submissions/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample_status: status }),
  });
  if (!response.ok) {
    alert('状态保存失败');
  }
  await loadSubmissions();
}

function parseCsv(text) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeImportHeader);
  return rows.slice(1).map((values) => {
    const item = {};
    headers.forEach((header, index) => {
      if (header) item[header] = String(values[index] || '').trim();
    });
    return item;
  });
}

function normalizeImportHeader(header) {
  const key = String(header || '').trim();
  const map = {
    刊登流程: 'sample_status',
    状态: 'sample_status',
    刊登状态: 'listing_status',
    紧急程度: 'urgency',
    紧急: 'urgency',
    提交日期: 'submit_date',
    开发人: 'developer',
    刊登人: 'lister',
    产品名称: 'product_name',
    产品关键词: 'product_keywords',
    品牌: 'brand',
    上架店铺: 'store_name',
    店铺: 'store_name',
    变体名称: 'variant_name',
    变体: 'variant_name',
    '1688链接': 'source_url',
    产品图片: 'product_image',
    产品说明: 'product_note',
    '售价（JP）': 'price_jp',
    售价JP: 'price_jp',
    ERP是否刊登: 'erp_listed',
    'ERP是否刊登？': 'erp_listed',
    是否上直评: 'direct_review',
    是否开广告: 'ads_enabled',
    亚马逊ASIN: 'amazon_asin',
    产品SKU: 'product_sku',
  };
  const mapped = map[key] || key;
  return map[key] || fields.some((field) => field.key === key) ? mapped : '';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadImportTemplate() {
  const headers = [
    '刊登流程',
    '刊登状态',
    '紧急程度',
    '提交日期',
    '开发人',
    '刊登人',
    '产品名称',
    '产品关键词',
    '品牌',
    '上架店铺',
    '变体名称',
    '1688链接',
    '产品图片',
    '产品说明',
    '售价（JP）',
    'ERP是否刊登？',
    '是否上直评',
    '是否开广告',
    '亚马逊ASIN',
    '产品SKU',
  ];
  const example = [
    '链接刊登提交',
    '已刊登',
    '普通',
    '2026-06-30',
    '',
    '',
    '示例产品名称',
    '示例关键词',
    '示例品牌',
    '示例店铺',
    '示例变体',
    'https://detail.1688.com/offer/示例.html',
    '',
    '示例产品说明',
    '2998',
    '否',
    '否',
    '否',
    '',
    '',
  ];
  const csv = `\uFEFF${headers.map(csvCell).join(',')}\r\n${example.map(csvCell).join(',')}\r\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '链接刊登导入模板.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function normalizeImportItem(item) {
  const normalized = {};
  Object.entries(item || {}).forEach(([key, value]) => {
    const fieldKey = normalizeImportHeader(key);
    if (fieldKey) normalized[fieldKey] = String(value || '').trim();
  });
  if (!normalized.sample_status) normalized.sample_status = '链接刊登提交';
  if (!normalized.product_keywords) normalized.product_keywords = normalized.product_name || normalized.amazon_asin || normalized.product_sku || '已上架链接';
  if (!normalized.brand) normalized.brand = '-';
  if (!normalized.store_name) normalized.store_name = '-';
  return normalized;
}

async function importFile(event) {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file || state.importing) return;
  state.importing = true;
  render();
  try {
    const text = await file.text();
    const rawRows = file.name.toLowerCase().endsWith('.json')
      ? JSON.parse(text)
      : parseCsv(text);
    const rows = (Array.isArray(rawRows) ? rawRows : rawRows?.submissions || []).map(normalizeImportItem);
    if (!rows.length) throw new Error('未识别到可导入的数据');
    let success = 0;
    for (const row of rows) {
      const response = await fetch('./api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      if (response.ok) success += 1;
    }
    await loadSubmissions();
    alert(`导入完成：${success}/${rows.length}`);
  } catch (error) {
    alert(error.message || '导入失败');
  } finally {
    state.importing = false;
    render();
  }
}

function setImageField(value, message = '') {
  const form = document.getElementById('submitForm');
  if (!form) return;
  const input = form.querySelector('input[name="product_image"]');
  const preview = form.querySelector('[data-image-preview]');
  const messageNode = form.querySelector('[data-image-message]');
  if (input) input.value = value || '';
  if (preview) {
    preview.innerHTML = value
      ? `<img src="${escapeHtml(imagePreviewSrc(value))}" alt="产品图片">`
      : '<span>暂无图片</span>';
  }
  if (messageNode) messageNode.textContent = message;
}

async function fetchProductImage() {
  const form = document.getElementById('submitForm');
  const url = String(form?.querySelector('[name="source_url"]')?.value || '').trim();
  if (!url) {
    setImageField('', '请先填写1688链接');
    return;
  }
  setImageField(form.querySelector('input[name="product_image"]')?.value || '', '正在抓取...');
  try {
    const response = await fetch(`./api/extract-image?url=${encodeURIComponent(url)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.image) throw new Error(result.error || '未抓取到产品图片');
    setImageField(result.image, '已抓取首图');
  } catch (error) {
    setImageField(form.querySelector('input[name="product_image"]')?.value || '', error.message || '抓取失败');
  }
}

function uploadProductImage(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setImageField(String(reader.result || ''), '已上传图片');
  reader.onerror = () => setImageField('', '图片读取失败');
  reader.readAsDataURL(file);
}

function clearProductImage() {
  setImageField('', '已清空');
}

function openSourceUrl() {
  const form = document.getElementById('submitForm');
  const url = String(form?.querySelector('[name="source_url"]')?.value || '').trim();
  if (!url) return;
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  window.open(target, '_blank', 'noopener');
}

async function loadConfig() {
  const response = await fetch('./api/config');
  state.config = response.ok ? await response.json() : null;
}

async function loadTeamMembers() {
  try {
    const response = await fetch('/api/members', { credentials: 'same-origin' });
    const payload = response.ok ? await response.json() : {};
    const members = Array.isArray(payload.members) ? payload.members : [];
    state.teamMembers = [...new Set(members.map((member) => String(member.name || '').trim()).filter(Boolean))];
  } catch {
    state.teamMembers = [];
  }
}

async function loadCurrentUser() {
  try {
    const response = await fetch('/api/dashboard', { credentials: 'same-origin' });
    const payload = response.ok ? await response.json() : {};
    state.currentUser = payload.user || null;
  } catch {
    state.currentUser = null;
  }
}

async function loadSubmissions() {
  const params = new URLSearchParams();
  if (state.search) params.set('search', state.search);
  if (state.status !== 'all') params.set('status', state.status);
  const response = await fetch(`./api/submissions?${params.toString()}`);
  state.payload = response.ok
    ? await response.json()
    : { summary: {}, submissions: [] };
  render();
}

async function submitForm(event) {
  event.preventDefault();
  const error = document.getElementById('formError');
  if (error) error.textContent = '';
  const formData = new FormData(event.currentTarget);
  const payload = {};
  fields.forEach((field) => {
    payload[field.key] = String(formData.get(field.key) || '').trim();
  });
  payload.submitter_name = String(state.currentUser?.name || '').trim();
  if (!payload.sample_status) payload.sample_status = '链接刊登提交';
  const editingId = state.editingId;
  const response = await fetch(editingId ? `./api/submissions/${editingId}` : './api/submissions', {
    method: editingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (error) error.textContent = result.error || (editingId ? '保存失败' : '链接刊登提交失败');
    return;
  }
  state.modalOpen = false;
  state.editingId = null;
  await loadSubmissions();
}

async function bootstrap() {
  render();
  await loadConfig();
  await loadCurrentUser();
  await loadTeamMembers();
  await loadSubmissions();
}

bootstrap();
