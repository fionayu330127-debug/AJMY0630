require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const TK_DIR = path.join(__dirname, 'modules', 'tk-creator-system');
const PRODUCT_TEST_DIR = path.join(__dirname, 'product-test-system');
const AI_IMAGE_DIR = path.join(__dirname, 'ai-image-system');
const INVENTORY_SHIPMENT_DIR = path.join(__dirname, 'inventory-shipment-system');
const express = require('express');
const tkApp = require(path.join(TK_DIR, 'server.js'));
const tkDb = require(path.join(TK_DIR, 'db.js'));
const productTestApp = require(path.join(PRODUCT_TEST_DIR, 'server.js'));
const aiImageApp = require(path.join(AI_IMAGE_DIR, 'server.js'));
const inventoryShipmentApp = require(path.join(INVENTORY_SHIPMENT_DIR, 'server.js'));

const app = express();
const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:agimia_erp_2026@127.0.0.1:5432/agimia_erp';
const LINGXING_OPENAPI_BASE = process.env.LINGXING_OPENAPI_BASE || 'https://openapi.lingxing.com';
const LINGXING_AMAZON_ADS_PATH = process.env.LINGXING_AMAZON_ADS_PATH || '';

const pool = new Pool({ connectionString: DATABASE_URL });

const members = ['余蓉', '盛峻波', '胡辉', '赵颖霖', '吕文健', '刘嘉莹'];

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

async function query(text, params = []) {
  return pool.query(text, params);
}

async function ensureSeedData() {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0) return;

  for (const name of members) {
    const salt = crypto.randomBytes(16).toString('hex');
    await query(
      `INSERT INTO users (name, login_name, role, password_salt, password_hash, status)
       VALUES ($1, $1, 'member', $2, $3, 'active')`,
      [name, salt, hashPassword('123456', salt)]
    );
  }

  const salt = crypto.randomBytes(16).toString('hex');
  await query(
    `INSERT INTO users (name, login_name, role, password_salt, password_hash, status)
     VALUES ($1, $1, 'admin', $2, $3, 'active')`,
    ['系统管理员', salt, hashPassword('123456', salt)]
  );
}

async function ensureTeamSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS team_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      note TEXT DEFAULT '',
      sort_order INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    )
  `);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS remark TEXT DEFAULT ''`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team_group VARCHAR(100) DEFAULT '员工'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wecom_userid VARCHAR(100)`);

  const groups = [
    ['员工', 10],
    ['经理', 20],
    ['管理员', 30],
    ['BOSS', 40],
  ];

  for (const [name, sortOrder] of groups) {
    await query(
      `INSERT INTO team_groups (name, sort_order)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [name, sortOrder]
    );
  }

  await query(`UPDATE users SET team_group = '管理员' WHERE role = 'admin' AND (team_group IS NULL OR team_group = '员工')`);
  await query(`UPDATE users SET team_group = '员工' WHERE team_group IS NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      work_content TEXT DEFAULT '',
      new_skills TEXT DEFAULT '',
      shortcomings TEXT DEFAULT '',
      needs TEXT DEFAULT '',
      next_focus TEXT DEFAULT '',
      admin_comment TEXT DEFAULT '',
      commented_by INT REFERENCES users(id) ON DELETE SET NULL,
      commented_at TIMESTAMP,
      submitted_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      UNIQUE(user_id, week_start)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ai_image_tasks (
      id SERIAL PRIMARY KEY,
      submitter_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_name VARCHAR(200) NOT NULL,
      draft JSONB,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    )
  `);
  await query(`ALTER TABLE ai_image_tasks ADD COLUMN IF NOT EXISTS draft JSONB`);

  await query(`
    CREATE TABLE IF NOT EXISTS product_sample_submissions (
      id SERIAL PRIMARY KEY,
      submitter_id INT REFERENCES users(id) ON DELETE SET NULL,
      listing_status TEXT DEFAULT '',
      urgency TEXT DEFAULT '',
      submit_date DATE,
      developer TEXT DEFAULT '',
      lister TEXT DEFAULT '',
      shipper TEXT DEFAULT '',
      product_keywords TEXT DEFAULT '',
      brand TEXT DEFAULT '',
      store_name TEXT DEFAULT '',
      delivery_method TEXT DEFAULT '',
      lead_time TEXT DEFAULT '',
      variant_attribute TEXT DEFAULT '',
      variant_name TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      product_note TEXT DEFAULT '',
      parent_asin_us TEXT DEFAULT '',
      shipping_channel TEXT DEFAULT '',
      quantity TEXT DEFAULT '',
      is_shipped TEXT DEFAULT '',
      parent_asin_au TEXT DEFAULT '',
      transparency_plan TEXT DEFAULT '',
      link_status TEXT DEFAULT '',
      price_jp TEXT DEFAULT '',
      contact_group TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      reference_text TEXT DEFAULT '',
      need_follow_sale TEXT DEFAULT '',
      erp_listed TEXT DEFAULT '',
      direct_review TEXT DEFAULT '',
      ads_enabled TEXT DEFAULT '',
      copywriting_quality TEXT DEFAULT '',
      a_plus TEXT DEFAULT '',
      sample_status TEXT DEFAULT '待审核',
      reviewer_id INT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      review_note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    )
  `);

  await query(`ALTER TABLE product_sample_submissions ADD COLUMN IF NOT EXISTS sample_status TEXT DEFAULT '待审核'`);
  await query(`ALTER TABLE product_sample_submissions ADD COLUMN IF NOT EXISTS reviewer_id INT REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE product_sample_submissions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`);
  await query(`ALTER TABLE product_sample_submissions ADD COLUMN IF NOT EXISTS review_note TEXT DEFAULT ''`);
  await query(`UPDATE product_sample_submissions SET sample_status = '待审核' WHERE sample_status IS NULL OR sample_status = ''`);
}

function mondayOfWeek(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d;
}

function dateOnly(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekLabel(weekStart) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${dateOnly(start)} 鑷?${dateOnly(end)}`;
}

function weekOptions(count = 16) {
  const current = mondayOfWeek();
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(current);
    start.setDate(current.getDate() - index * 7);
    const value = dateOnly(start);
    return { value, label: weekLabel(value) };
  });
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

async function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie || '').agi_session;
  if (!token) return null;

  const { rows } = await query(
    `SELECT u.id, u.name, u.role, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND u.status = 'active'`,
    [token]
  );

  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return row;
}

function dashboardPayload(user) {
  return {
    user,
    stats: [
      { label: '待处理订单', value: '128', delta: '+12' },
      { label: '同步队列', value: '24', delta: '稳定' },
      { label: 'Webhook 事件', value: '96', delta: '+8' },
      { label: '今日规则', value: '17', delta: '已启用' },
    ],
    modules: [
      { name: 'TikTok API 同步', status: '连接正常', tone: 'ok' },
      { name: 'Webhook 实时推送', status: '监听中', tone: 'ok' },
      { name: 'Cron 自动规则', status: '运行中', tone: 'warn' },
      { name: 'WebSocket 消息推送', status: '待接入', tone: 'info' },
      { name: '本地数据库', status: 'PostgreSQL', tone: 'ok' },
      { name: 'TK 达人管理系统', status: '/tk/', tone: 'info' },
      { name: '库存明细', status: 'http://47.110.59.28/', tone: 'info' },
      { name: '库存货件', status: '/inventory/', tone: 'info' },
    ],
    timeline: [
      { time: '07:00', text: '自动同步 TikTok 店铺数据' },
      { time: '12:00', text: '自动同步 TikTok 店铺数据' },
      { time: '18:00', text: '自动同步 TikTok 店铺数据' },
      { time: '实时', text: '处理登录、模块入口和系统状态' },
    ],
  };
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function maskSecret(value, visibleStart = 4, visibleEnd = 2) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= visibleStart + visibleEnd) return '*'.repeat(text.length);
  return `${text.slice(0, visibleStart)}${'*'.repeat(Math.max(4, text.length - visibleStart - visibleEnd))}${text.slice(-visibleEnd)}`;
}

function lingxingConfigStatus() {
  const appKey = process.env.LINGXING_APP_KEY || process.env.LINGXING_APP_ID || '';
  return {
    base_url: LINGXING_OPENAPI_BASE,
    endpoint_path: LINGXING_AMAZON_ADS_PATH,
    app_id_masked: maskSecret(appKey, 3, 2),
    has_app_id: Boolean(appKey),
    has_app_secret: Boolean(process.env.LINGXING_APP_SECRET),
    has_access_token: Boolean(process.env.LINGXING_ACCESS_TOKEN),
    ready: Boolean(appKey && process.env.LINGXING_APP_SECRET && process.env.LINGXING_ACCESS_TOKEN && LINGXING_AMAZON_ADS_PATH),
  };
}

function stableJson(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function aesEcbEncryptUpperMd5(md5Text, appKey) {
  let key = Buffer.from(String(appKey || ''), 'utf8');
  if (![16, 24, 32].includes(key.length)) {
    key = crypto.createHash('md5').update(String(appKey || '')).digest();
  }
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(md5Text, 'utf8'), cipher.final()]).toString('base64');
}

function buildLingxingSignedBody(paramsJson = {}) {
  const appKey = process.env.LINGXING_APP_KEY || process.env.LINGXING_APP_ID || '';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseParams = {
    access_token: process.env.LINGXING_ACCESS_TOKEN || '',
    app_key: appKey,
    timestamp,
  };
  const businessParams = paramsJson && typeof paramsJson === 'object' ? paramsJson : {};
  const signParams = { ...businessParams, ...baseParams };
  const signText = Object.keys(signParams)
    .filter((key) => signParams[key] !== undefined && signParams[key] !== null && signParams[key] !== '')
    .sort()
    .map((key) => {
      const value = typeof signParams[key] === 'object' ? stableJson(signParams[key]) : String(signParams[key]);
      return `${key}=${value}`;
    })
    .join('&');
  const md5Text = crypto.createHash('md5').update(signText, 'utf8').digest('hex').toUpperCase();

  return {
    ...businessParams,
    ...baseParams,
    sign: aesEcbEncryptUpperMd5(md5Text, appKey),
  };
}

function normalizeLingxingAdsPayload(payload) {
  const sourceRows = Array.isArray(payload?.data?.list)
    ? payload.data.list
    : Array.isArray(payload?.data?.rows)
      ? payload.data.rows
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.list)
          ? payload.list
          : [];

  const rows = sourceRows.slice(0, 200).map((row) => {
    const spend = Number(row.spend ?? row.cost ?? row.ad_cost ?? row.cost_amount ?? 0);
    const sales = Number(row.sales ?? row.ad_sales ?? row.sale_amount ?? row.order_amount ?? 0);
    const impressions = Number(row.impressions ?? row.exposure ?? row.show_count ?? 0);
    const clicks = Number(row.clicks ?? row.click_count ?? 0);
    const acos = row.acos ?? (sales > 0 ? (spend / sales) * 100 : null);
    return {
      campaign_name: row.campaign_name || row.campaignName || row.name || row.ad_name || '-',
      shop_name: row.shop_name || row.shopName || row.store_name || row.sid_name || '-',
      marketplace: row.marketplace || row.marketplace_name || row.country || '-',
      spend,
      sales,
      impressions,
      clicks,
      acos: acos === null || acos === undefined || acos === '' ? null : Number(acos),
      status: row.status || row.state || row.campaign_status || '-',
    };
  });

  const summary = rows.reduce((acc, row) => {
    acc.spend += row.spend;
    acc.sales += row.sales;
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    return acc;
  }, { spend: 0, sales: 0, impressions: 0, clicks: 0 });
  summary.acos = summary.sales > 0 ? (summary.spend / summary.sales) * 100 : null;

  return { summary, rows, raw_count: sourceRows.length };
}

async function requestLingxingAmazonAds({ startDate, endDate }) {
  const config = lingxingConfigStatus();
  if (!config.ready) {
    return {
      configured: false,
      config,
      summary: { spend: 0, sales: 0, impressions: 0, clicks: 0, acos: null },
      rows: [],
      message: '请先在 .env 配置 LINGXING_APP_ID、LINGXING_APP_SECRET 和 LINGXING_AMAZON_ADS_PATH',
    };
  }

  const target = new URL(LINGXING_AMAZON_ADS_PATH, LINGXING_OPENAPI_BASE);
  const body = buildLingxingSignedBody({
    start_date: startDate,
    end_date: endDate,
  });

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const response = await fetch(target, {
    method: process.env.LINGXING_AMAZON_ADS_METHOD || 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    const message = payload?.message || payload?.msg || `领星接口返回 ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return {
    configured: true,
    config,
    source: target.toString(),
    ...normalizeLingxingAdsPayload(payload),
  };
}

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});
productTestApp.getCurrentUser = getSessionUser;
app.use('/tk', tkApp);
app.use('/product-test', productTestApp);
app.use('/ai-draw', aiImageApp);
app.use('/inventory', inventoryShipmentApp);
app.use(express.static(ROOT, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:png|jpg|jpeg|webp|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return;
    }
    if (/\.(?:js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=600');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.post('/api/login', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    if (!name || !password) return sendError(res, 400, '请选择成员并输入密码');

    const { rows } = await query(
      `SELECT id, name, role, password_salt, password_hash
       FROM users
       WHERE (name = $1 OR login_name = $1) AND status = 'active'`,
      [name]
    );
    const user = rows[0];
    if (!user) return sendError(res, 401, '账号或密码错误');

    if (hashPassword(password, user.password_salt) !== user.password_hash) {
      return sendError(res, 401, '账号或密码错误');
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, user.id, expiresAt]
    );

    res.setHeader('Set-Cookie', `agi_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
    res.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    console.error('login failed', err);
    sendError(res, 500, '登录服务异常');
  }
});

app.post('/api/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie || '').agi_session;
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
  res.setHeader('Set-Cookie', 'agi_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');
  res.json({ user: { id: user.id, name: user.name, role: user.role } });
});

app.get('/api/ai-draw/tasks', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const isAdmin = user.role === 'admin';
  const { rows } = await query(
    `SELECT
       t.id,
       t.task_name,
       t.submitter_id,
       u.name AS submitter_name,
       t.draft,
       t.created_at,
       t.updated_at
     FROM ai_image_tasks t
     JOIN users u ON u.id = t.submitter_id
     WHERE ($1::boolean OR t.submitter_id = $2)
     ORDER BY t.updated_at DESC, t.id DESC`,
    [isAdmin, user.id]
  );
  res.json({ is_admin: isAdmin, current_user: { id: user.id, name: user.name, role: user.role }, tasks: rows });
});

app.post('/api/ai-draw/tasks', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const taskName = String(req.body.task_name || '').trim();
  if (!taskName) return sendError(res, 400, '请输入任务名称');

  const { rows } = await query(
    `INSERT INTO ai_image_tasks (submitter_id, task_name, draft)
     VALUES ($1, $2, $3)
     RETURNING id, task_name, submitter_id, draft, created_at, updated_at`,
    [user.id, taskName, req.body.draft && typeof req.body.draft === 'object' ? req.body.draft : null]
  );
  res.json({ ok: true, task: { ...rows[0], submitter_name: user.name } });
});

app.patch('/api/ai-draw/tasks/:id', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const id = Number(req.params.id);
  if (!id) return sendError(res, 400, '记录不存在');

  const hasTaskName = Object.prototype.hasOwnProperty.call(req.body, 'task_name');
  const hasDraft = Object.prototype.hasOwnProperty.call(req.body, 'draft');
  const taskName = hasTaskName ? String(req.body.task_name || '').trim() : null;
  if (hasTaskName && !taskName) return sendError(res, 400, '请输入任务名称');
  if (!hasTaskName && !hasDraft) return sendError(res, 400, '没有要保存的内容');

  const isAdmin = user.role === 'admin';
  const existing = await query(
    `SELECT task_name, draft
     FROM ai_image_tasks
     WHERE id = $1 AND ($2::boolean OR submitter_id = $3)`,
    [id, isAdmin, user.id]
  );
  if (!existing.rows[0]) return sendError(res, 404, '任务不存在或无权限修改');

  const nextDraft = hasDraft
    ? (req.body.draft && typeof req.body.draft === 'object' ? req.body.draft : null)
    : existing.rows[0].draft;
  const { rows } = await query(
    `UPDATE ai_image_tasks
     SET task_name = $1, draft = $2, updated_at = now()
     WHERE id = $3 AND ($4::boolean OR submitter_id = $5)
     RETURNING id, task_name, submitter_id, draft, created_at, updated_at`,
    [hasTaskName ? taskName : existing.rows[0].task_name, nextDraft, id, isAdmin, user.id]
  );

  const submitter = await query('SELECT name FROM users WHERE id = $1', [rows[0].submitter_id]);
  res.json({ ok: true, task: { ...rows[0], submitter_name: submitter.rows[0]?.name || '' } });
});

app.delete('/api/ai-draw/tasks/:id', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const id = Number(req.params.id);
  if (!id) return sendError(res, 400, '记录不存在');

  const isAdmin = user.role === 'admin';
  const { rowCount } = await query(
    `DELETE FROM ai_image_tasks
     WHERE id = $1 AND ($2::boolean OR submitter_id = $3)`,
    [id, isAdmin, user.id]
  );
  if (!rowCount) return sendError(res, 404, '任务不存在或无权限删除');

  res.json({ ok: true });
});
app.get('/api/dashboard', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');
  res.json(dashboardPayload({ id: user.id, name: user.name, role: user.role }));
});

app.get('/api/members', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, role
     FROM users
     WHERE status = 'active'
     ORDER BY id`
  );
  res.json({ members: rows });
});

app.get('/api/team', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const { rows: groups } = await query(`
    SELECT
      g.id,
      g.name,
      COALESCE(g.note, '') AS note,
      COUNT(u.id)::int AS member_count
    FROM team_groups g
    LEFT JOIN users u ON u.team_group = g.name AND u.status = 'active'
    WHERE g.status = 'active'
    GROUP BY g.id, g.name, g.note, g.sort_order
    ORDER BY g.sort_order, g.id
  `);

  const { rows: members } = await query(`
    SELECT id, name, login_name, phone, wecom_userid, role, status, team_group, remark, created_at
    FROM users
    ORDER BY status DESC, team_group, id
  `);

  res.json({ groups, members });
});

app.post('/api/team/members', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const wecomUserid = String(req.body.wecom_userid || '').trim();
  const remark = String(req.body.remark || '').trim();
  const groupName = String(req.body.group || '员工').trim();

  if (!name) return sendError(res, 400, '请输入用户名');
  if (!remark) return sendError(res, 400, '请输入备注名');

  const { rows: groupRows } = await query('SELECT name FROM team_groups WHERE name = $1 AND status = $2', [groupName, 'active']);
  if (!groupRows[0]) return sendError(res, 400, '分组不存在');

  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const { rows } = await query(
      `INSERT INTO users (name, login_name, phone, wecom_userid, remark, team_group, role, password_salt, password_hash, status)
       VALUES ($1, $1, $2, $3, $4, $5, 'member', $6, $7, 'active')
       RETURNING id, name, login_name, phone, wecom_userid, role, status, team_group, remark, created_at`,
      [name, phone, wecomUserid || null, remark, groupName, salt, hashPassword('123456', salt)]
    );
    res.json({ ok: true, member: rows[0] });
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, '用户名已存在');
    console.error('create team member failed', err);
    sendError(res, 500, '添加成员失败');
  }
});

app.patch('/api/team/members/:id', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const wecomUserid = String(req.body.wecom_userid || '').trim();
  const remark = String(req.body.remark || '').trim();
  const groupName = String(req.body.group || '员工').trim();

  if (!id) return sendError(res, 400, '记录不存在');
  if (!name) return sendError(res, 400, '请输入用户名');
  if (!remark) return sendError(res, 400, '请输入备注名');
  if (!groupName) return sendError(res, 400, '请选择分组');

  const { rows: groupRows } = await query('SELECT name FROM team_groups WHERE name = $1 AND status = $2', [groupName, 'active']);
  if (!groupRows[0]) return sendError(res, 400, '分组不存在');

  try {
    const { rows } = await query(
      `UPDATE users
       SET name = $1, login_name = $1, phone = $2, wecom_userid = $3, remark = $4, team_group = $5, updated_at = now()
       WHERE id = $6
       RETURNING id, name, login_name, phone, wecom_userid, role, status, team_group, remark, created_at`,
      [name, phone || null, wecomUserid || null, remark, groupName, id]
    );
    if (!rows[0]) return sendError(res, 404, '记录不存在');
    res.json({ ok: true, member: rows[0] });
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, '用户名已存在');
    console.error('update team member failed', err);
    sendError(res, 500, '保存成员失败');
  }
});

app.patch('/api/team/members/:id/status', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const id = Number(req.params.id);
  const status = String(req.body.status || '').trim();
  if (!['active', 'disabled'].includes(status)) return sendError(res, 400, '状态不正确');

  await query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
  res.json({ ok: true });
});

app.get('/api/weekly-reports', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const options = weekOptions();
  const weekStart = String(req.query.week_start || options[0].value).slice(0, 10);
  const isAdmin = user.role === 'admin';
  const optionValues = options.map((week) => week.value);

  const { rows: members } = await query(`
    SELECT id, name, team_group
    FROM users
    WHERE status = 'active' AND role <> 'admin'
    ORDER BY team_group, id
  `);

  const { rows: submittedRows } = await query(`
    SELECT
      r.id,
      r.user_id,
      u.name AS user_name,
      u.team_group,
      r.week_start::text AS week_start,
      r.work_content,
      r.new_skills,
      r.shortcomings,
      r.needs,
      r.next_focus,
      r.admin_comment,
      r.submitted_at,
      r.updated_at,
      c.name AS commenter_name,
      r.commented_at
    FROM weekly_reports r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users c ON c.id = r.commented_by
    WHERE r.week_start = $1
    ORDER BY r.submitted_at DESC, r.id DESC
  `, [weekStart]);

  const submittedIds = new Set(submittedRows.map((row) => row.user_id));
  const missing = members.filter((member) => !submittedIds.has(member.id));
  const myReport = submittedRows.find((row) => row.user_id === user.id) || null;
  const { rows: weekCounts } = await query(`
    SELECT r.week_start::text AS week_start, COUNT(DISTINCT r.user_id)::int AS submitted
    FROM weekly_reports r
    JOIN users u ON u.id = r.user_id
    WHERE r.week_start = ANY($1::date[]) AND u.status = 'active' AND u.role <> 'admin'
    GROUP BY r.week_start
  `, [optionValues]);
  const countMap = new Map(weekCounts.map((row) => [row.week_start, row.submitted]));

  const { rows: myReports } = user.role === 'admin'
    ? { rows: [] }
    : await query(`
      SELECT id, week_start::text AS week_start, submitted_at, updated_at
      FROM weekly_reports
      WHERE user_id = $1 AND week_start = ANY($2::date[])
      ORDER BY week_start DESC
    `, [user.id, optionValues]);
  const myReportMap = new Map(myReports.map((row) => [row.week_start, row]));

  const weekStatuses = options.map((week) => {
    const submitted = countMap.get(week.value) || 0;
    const mine = myReportMap.get(week.value) || null;
    return {
      ...week,
      submitted,
      missing: Math.max(0, members.length - submitted),
      my_report_id: mine?.id || null,
      my_submitted: Boolean(mine),
      my_updated_at: mine?.updated_at || mine?.submitted_at || null,
    };
  });

  res.json({
    is_admin: isAdmin,
    selected_week_start: weekStart,
    selected_week_label: weekLabel(weekStart),
    week_options: options,
    summary: {
      total_members: members.length,
      submitted: submittedRows.filter((row) => members.some((member) => member.id === row.user_id)).length,
      missing: missing.length,
    },
    my_report: myReport,
    week_statuses: weekStatuses,
    reports: isAdmin ? submittedRows : [],
    missing_members: isAdmin ? missing : [],
  });
});

app.post('/api/weekly-reports', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');
  if (user.role === 'admin') return sendError(res, 403, '管理员不用提交周报');

  const weekStart = String(req.body.week_start || dateOnly(mondayOfWeek())).slice(0, 10);
  const workContent = String(req.body.work_content || '').trim();
  const newSkills = String(req.body.new_skills || '').trim();
  const shortcomings = String(req.body.shortcomings || '').trim();
  const needs = String(req.body.needs || '').trim();
  const nextFocus = String(req.body.next_focus || '').trim();

  if (!workContent || !nextFocus) return sendError(res, 400, '请至少填写本周工作内容和下周工作重点');

  const { rows } = await query(`
    INSERT INTO weekly_reports (
      user_id, week_start, work_content, new_skills, shortcomings, needs, next_focus, submitted_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
    ON CONFLICT (user_id, week_start) DO UPDATE SET
      work_content = excluded.work_content,
      new_skills = excluded.new_skills,
      shortcomings = excluded.shortcomings,
      needs = excluded.needs,
      next_focus = excluded.next_focus,
      updated_at = now()
    RETURNING *
  `, [user.id, weekStart, workContent, newSkills, shortcomings, needs, nextFocus]);

  res.json({ ok: true, report: rows[0] });
});

app.patch('/api/weekly-reports/:id/comment', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');
  if (user.role !== 'admin') return sendError(res, 403, '只有管理员可以点评周报');

  const id = Number(req.params.id);
  const comment = String(req.body.comment || '').trim();
  const { rows } = await query(`
    UPDATE weekly_reports
    SET admin_comment = $1, commented_by = $2, commented_at = now(), updated_at = now()
    WHERE id = $3
    RETURNING *
  `, [comment, user.id, id]);

    if (!rows[0]) return sendError(res, 404, '记录不存在');
  res.json({ ok: true, report: rows[0] });
});

app.get('/api/tk/products', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const shop = String(req.query.shop || 'oku');
  const search = String(req.query.search || '').trim();
  const syncedProductFilter = '(p.external_product_id IS NOT NULL OR p.synced_at IS NOT NULL)';
  const where = ['p.shop_id = ?', syncedProductFilter];
  const params = [shop];

  if (search) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.external_product_id LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const shops = tkDb.prepare(`
    SELECT s.id, s.name, s.color, COUNT(p.id) AS product_count
    FROM shops s
    LEFT JOIN products p ON p.shop_id = s.id AND ${syncedProductFilter}
    GROUP BY s.id, s.name, s.color
    ORDER BY s.id
  `).all();

  const rows = tkDb.prepare(`
    SELECT
      p.id,
      p.shop_id,
      p.external_product_id,
      p.sku,
      p.name,
      p.emoji,
      p.status,
      p.image_url,
      p.synced_at,
      COUNT(sa.id) AS sample_count,
      SUM(CASE WHEN sa.status = 'pending' THEN 1 ELSE 0 END) AS pending_samples
    FROM products p
    LEFT JOIN samples sa ON sa.product_id = p.id
    WHERE ${where.join(' AND ')}
    GROUP BY p.id
    ORDER BY
      CASE WHEN p.synced_at IS NULL THEN 1 ELSE 0 END,
      p.synced_at DESC,
      p.id DESC
    LIMIT 300
  `).all(...params);

  const summary = tkDb.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('ACTIVATE','ACTIVE','ONLINE','sample') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced
    FROM products
    WHERE shop_id = ? AND (external_product_id IS NOT NULL OR synced_at IS NOT NULL)
  `).get(shop);

  res.json({ shop, shops, summary, products: rows });
});

const sampleSubmissionColumns = [
  'sample_status',
  'listing_status',
  'urgency',
  'submit_date',
  'developer',
  'lister',
  'shipper',
  'product_keywords',
  'brand',
  'store_name',
  'delivery_method',
  'lead_time',
  'variant_attribute',
  'variant_name',
  'source_url',
  'product_note',
  'parent_asin_us',
  'shipping_channel',
  'quantity',
  'is_shipped',
  'parent_asin_au',
  'transparency_plan',
  'link_status',
  'price_jp',
  'contact_group',
  'start_time',
  'reference_text',
  'need_follow_sale',
  'erp_listed',
  'direct_review',
  'ads_enabled',
  'copywriting_quality',
  'a_plus',
];

const sampleStatusMap = {
  pending: '待审核',
  testing: '测品中',
  passed: '测品通过',
  failed: '测品失败',
  converted: '已转正式商品',
};

function normalizeSampleStatus(value) {
  const text = String(value || '').trim();
  if (Object.values(sampleStatusMap).includes(text)) return text;
  return sampleStatusMap[text] || '待审核';
}

app.get('/api/sample-submissions', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || 'all').trim();
  const params = [];
  const whereParts = [];
  if (search) {
    params.push(`%${search}%`);
    whereParts.push(`(
      product_keywords ILIKE $${params.length}
      OR brand ILIKE $${params.length}
      OR store_name ILIKE $${params.length}
      OR product_note ILIKE $${params.length}
      OR source_url ILIKE $${params.length}
      OR variant_name ILIKE $${params.length}
    )`);
  }
  if (status && status !== 'all' && sampleStatusMap[status]) {
    params.push(sampleStatusMap[status]);
    whereParts.push(`COALESCE(sample_status, '待审核') = $${params.length}`);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const { rows: summaryRows } = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(sample_status, '待审核') = '待审核')::int AS pending,
      COUNT(*) FILTER (WHERE sample_status = '测品中')::int AS testing,
      COUNT(*) FILTER (WHERE sample_status = '测品通过')::int AS passed,
      COUNT(*) FILTER (WHERE sample_status = '测品失败')::int AS failed,
      COUNT(*) FILTER (WHERE sample_status = '已转正式商品')::int AS converted
    FROM product_sample_submissions
  `);

  const { rows } = await query(`
    SELECT
      s.*,
      u.name AS submitter_name,
      r.name AS reviewer_name
    FROM product_sample_submissions s
    LEFT JOIN users u ON u.id = s.submitter_id
    LEFT JOIN users r ON r.id = s.reviewer_id
    ${where}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT 300
  `, params);

  res.json({ summary: summaryRows[0] || {}, submissions: rows });
});

app.post('/api/sample-submissions', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const payload = {};
  for (const column of sampleSubmissionColumns) {
    payload[column] = String(req.body[column] || '').trim();
  }
  payload.sample_status = normalizeSampleStatus(payload.sample_status);
  if (!payload.product_keywords) return sendError(res, 400, '请输入产品关键词');
  if (!payload.brand) return sendError(res, 400, '请输入品牌');
  if (!payload.store_name) return sendError(res, 400, '请输入上架店铺');

  const submitDate = payload.submit_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.submit_date)
    ? payload.submit_date
    : null;
  payload.submit_date = submitDate;

  const columns = ['submitter_id', ...sampleSubmissionColumns];
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const values = [user.id, ...sampleSubmissionColumns.map((column) => payload[column])];

  const { rows } = await query(`
    INSERT INTO product_sample_submissions (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, values);

  res.json({ ok: true, submission: { ...rows[0], submitter_name: user.name } });
});

app.patch('/api/sample-submissions/:id/status', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const id = Number(req.params.id);
  if (!id) return sendError(res, 400, '记录不存在');

  const sampleStatus = normalizeSampleStatus(req.body.sample_status);
  const reviewNote = String(req.body.review_note || '').trim();
  const { rows } = await query(`
    UPDATE product_sample_submissions
    SET sample_status = $1,
        reviewer_id = $2,
        reviewed_at = now(),
        review_note = $3,
        updated_at = now()
    WHERE id = $4
    RETURNING *
  `, [sampleStatus, user.id, reviewNote, id]);

  if (!rows[0]) return sendError(res, 404, '测品记录不存在');
  res.json({ ok: true, submission: { ...rows[0], reviewer_name: user.name } });
});

app.get('/api/amazon-ads/config', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');
  res.json(lingxingConfigStatus());
});

app.get('/api/amazon-ads/overview', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, '未登录');

  const today = dateOnly(new Date());
  const startDate = String(req.query.start_date || today).slice(0, 10);
  const endDate = String(req.query.end_date || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return sendError(res, 400, '日期格式不正确');
  }

  try {
    const payload = await requestLingxingAmazonAds({ startDate, endDate });
    res.json({ ...payload, start_date: startDate, end_date: endDate });
  } catch (err) {
    console.error('lingxing amazon ads request failed', err);
    res.status(err.status || 502).json({
      error: err.message || '领星广告接口请求失败',
      config: lingxingConfigStatus(),
      payload: err.payload || null,
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

async function start() {
  await query('SELECT 1');
  await ensureSeedData();
  await ensureTeamSchema();
  tkApp.startShopSyncScheduler?.();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`濂ュ悏绫充簹 ERP running at http://0.0.0.0:${PORT}`);
    console.log(`TK 杈句汉绠＄悊绯荤粺 mounted at http://0.0.0.0:${PORT}/tk/`);
  });
}

start().catch((err) => {
  console.error('ERP server failed to start', err);
  process.exit(1);
});



