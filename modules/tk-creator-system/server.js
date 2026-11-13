// server.js — TikTok达人管理系统 后端服务
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const db = require('./db');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { ensureSyncSchema, syncAffiliateCreators, syncAffiliateOrders, syncMissingProductImages, syncProducts, syncSampleApplications, syncTikTokShop } = require('./syncTikTok');
const { tiktokRequest } = require('./tiktokApi');
const { getAppConfig, getAppSecretStatus } = require('./tiktokSecrets');

const app = express();
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:agimia_erp_2026@127.0.0.1:5432/agimia_erp';
const corePool = new Pool({ connectionString: DATABASE_URL });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  if (req.url.startsWith('/tk/api/')) req.url = req.url.slice(3);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

async function currentErpUser(req) {
  return typeof app.getCurrentUser === 'function' ? app.getCurrentUser(req) : null;
}

app.get('/api/me', async (req, res) => {
  try {
    const user = await currentErpUser(req);
    if (!user) return res.status(401).json({ error: '未登录' });
    res.json({ id: user.id, name: user.name, role: user.role, is_admin: user.role === 'admin' });
  } catch (error) {
    res.status(500).json({ error: '读取登录用户失败' });
  }
});

// ════════════════════════════════════════
//  工具函数 + TikTok OAuth Token交换函数
// ════════════════════════════════════════
function genId() {
  return 's' + Math.random().toString(36).slice(2, 10);
}

function nowText() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      timeout: 10000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = JSON.parse(text); } catch (_) {}
        if (resp.statusCode < 200 || resp.statusCode >= 300 || data.errcode) {
          reject(new Error(data.errmsg || `HTTP ${resp.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('WeCom webhook timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sampleAssignDetail(sampleId) {
  return db.prepare(`
    SELECT
      s.id,
      s.uid,
      s.creator_name,
      s.creator_handle,
      s.commission_rate,
      s.approve_expiration_at,
      s.sample_received_at,
      p.name AS product_name,
      b.name AS bd_name,
      b.wecom_userid
    FROM samples s
    LEFT JOIN products p ON s.product_id = p.id
    LEFT JOIN bd_members b ON s.bd_id = b.id
    WHERE s.id = ?
  `).get(sampleId);
}

function latestAssignableSampleForUids(uids) {
  const list = [...new Set((uids || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!list.length) return null;
  const notifyStatuses = ['approved', 'published'];
  const placeholders = list.map(() => '?').join(',');
  return db.prepare(`
    SELECT id
    FROM samples
    WHERE uid IN (${placeholders})
      AND status IN (${notifyStatuses.map(() => '?').join(',')})
    ORDER BY applied_at DESC, id DESC
    LIMIT 1
  `).get(...list, ...notifyStatuses);
}

function markSampleLibraryReady(sampleId) {
  const row = db.prepare(`
    SELECT id
    FROM samples
    WHERE id = ?
      AND status IN ('approved', 'shipped', 'published')
      AND bd_id IS NOT NULL
      AND library_added_at IS NULL
  `).get(sampleId);
  if (!row) return false;
  db.prepare('UPDATE samples SET library_added_at = datetime(\'now\') WHERE id = ?').run(sampleId);
  return true;
}

function refreshCreatorLibraryMarkers() {
  db.prepare(`
    UPDATE samples
    SET library_added_at = COALESCE(library_added_at, applied_at, datetime('now'))
    WHERE library_added_at IS NULL
      AND status IN ('approved', 'shipped', 'published')
  `).run();
}

function sampleCenterWhere(alias = 's') {
  return `(${alias}.status NOT IN ('approved', 'shipped', 'published') OR ${alias}.library_added_at IS NULL)`;
}

function findExistingLibraryBd(uid, handle) {
  const cleanUid = String(uid || '').trim();
  if (cleanUid) {
    const fromLibrary = db.prepare(`
      SELECT bd_id
      FROM creator_library
      WHERE uid = ? AND bd_id IS NOT NULL
      LIMIT 1
    `).get(cleanUid);
    if (fromLibrary?.bd_id) return fromLibrary.bd_id;

    const fromSamples = db.prepare(`
      SELECT bd_id
      FROM samples
      WHERE uid = ?
        AND library_added_at IS NOT NULL
        AND bd_id IS NOT NULL
      ORDER BY library_added_at DESC, applied_at DESC
      LIMIT 1
    `).get(cleanUid);
    if (fromSamples?.bd_id) return fromSamples.bd_id;
  }

  const cleanHandle = normalizeCreatorHandle(handle);
  if (!cleanHandle) return null;
  const fromHandle = db.prepare(`
    SELECT bd_id
    FROM samples
    WHERE lower(replace(COALESCE(creator_handle, ''), '@', '')) = ?
      AND library_added_at IS NOT NULL
      AND bd_id IS NOT NULL
    ORDER BY library_added_at DESC, applied_at DESC
    LIMIT 1
  `).get(cleanHandle);
  return fromHandle?.bd_id || null;
}

function daysLeftText(value) {
  if (!value) return '-';
  const end = new Date(value);
  if (Number.isNaN(end.getTime())) return '-';
  const days = Math.ceil((end.getTime() - Date.now()) / 86400000);
  return days >= 0 ? `${days} 天` : '已过期';
}

function percentText(value) {
  if (value === undefined || value === null || value === '') return '-';
  const number = Number(value);
  if (Number.isFinite(number)) return number <= 1 ? `${Math.round(number * 100)}%` : `${number}%`;
  return String(value);
}

function isOverdueUnpublishedSample(row) {
  if (!row?.bd_id || !row?.sample_received_at) return false;
  if (['published', 'rejected', 'cancelled'].includes(String(row.status || ''))) return false;
  const receivedAt = new Date(row.sample_received_at).getTime();
  if (!Number.isFinite(receivedAt)) return false;
  const deadline = receivedAt + 7 * 86400000;
  return Number.isFinite(deadline) && deadline < Date.now();
}

async function syncBdMembersFromEmployees() {
  const { rows } = await corePool.query(`
    SELECT id, name, login_name, phone, wecom_userid, role, status
    FROM users
    WHERE status = 'active' AND COALESCE(name, '') <> '系统管理员'
    ORDER BY id
  `);

  const activeIds = new Set(rows.map((row) => String(row.id)));
  const findByExternalId = db.prepare('SELECT id FROM bd_members WHERE source = ? AND external_user_id = ?');
  const findByName = db.prepare('SELECT id, source, external_user_id FROM bd_members WHERE name = ? LIMIT 1');
  const updateExisting = db.prepare(`
    UPDATE bd_members
    SET name = ?, email = ?, wecom_userid = COALESCE(NULLIF(?, ''), wecom_userid), external_user_id = ?, source = 'employee', active = 1
    WHERE id = ?
  `);
  const insertEmployee = db.prepare(`
    INSERT INTO bd_members (name, email, wecom_userid, external_user_id, source, active)
    VALUES (?, ?, ?, ?, 'employee', 1)
  `);

  for (const row of rows) {
    const externalId = String(row.id);
    const name = String(row.name || row.login_name || '').trim();
    if (!name) continue;

    const existing = findByExternalId.get('employee', externalId);
    if (existing) {
      updateExisting.run(name, row.phone || null, row.wecom_userid || null, externalId, existing.id);
      continue;
    }

    const sameName = findByName.get(name);
    if (sameName && (!sameName.external_user_id || sameName.source === 'local')) {
      updateExisting.run(name, row.phone || null, row.wecom_userid || null, externalId, sameName.id);
      continue;
    }

    insertEmployee.run(name, row.phone || null, row.wecom_userid || null, externalId);
  }

  db.prepare("UPDATE bd_members SET active = 0 WHERE COALESCE(source, 'local') <> 'employee'").run();

  const employeeRows = db.prepare("SELECT id, external_user_id FROM bd_members WHERE source = 'employee'").all();
  const disableEmployee = db.prepare('UPDATE bd_members SET active = 0 WHERE id = ?');
  for (const row of employeeRows) {
    if (!activeIds.has(String(row.external_user_id))) disableEmployee.run(row.id);
  }
}

async function listBdMembers() {
  try {
    await syncBdMembersFromEmployees();
  } catch (error) {
    console.error('[bd-sync] sync employees failed:', error.message);
  }

  const list = db.prepare(`
    SELECT id, name, email, wecom_userid, external_user_id, source, active, max_load
    FROM bd_members
    WHERE active = 1
    ORDER BY source = 'employee' DESC, id
  `).all();
  return list.map((b) => {
    const load = db.prepare(`SELECT COUNT(DISTINCT uid) AS c FROM samples WHERE bd_id = ?`).get(b.id).c;
    return { ...b, load, max_load: Number(b.max_load || 20) };
  });
}

async function notifyBdAssigned(sampleId, title = '新的样品分配通知') {
  const webhook = process.env.QYWX_TK_CREATOR_WEBHOOK || process.env.WECOM_BD_ASSIGN_WEBHOOK || '';
  if (!webhook) {
    console.warn('[wecom] QYWX_TK_CREATOR_WEBHOOK/WECOM_BD_ASSIGN_WEBHOOK is empty, skip BD assign notification');
    return;
  }

  const detail = sampleAssignDetail(sampleId);
  if (!detail) {
    console.warn(`[wecom] sample not found for notification: ${sampleId}`);
    return;
  }

  const mention = detail.wecom_userid ? `<@${detail.wecom_userid}>` : '';
  if (!detail.wecom_userid) {
    console.warn(`[wecom] BD ${detail.bd_name || ''} has no wecom_userid, notification will not @ user`);
  }

  const content = [
    `### ${title}`,
    `> 达人名称：${detail.creator_name || '-'}`,
    `> TikTok ID：${detail.creator_handle || detail.uid || '-'}`,
    `> 样品名称：${detail.product_name || '-'}`,
    `> 佣金比例：${percentText(detail.commission_rate)}`,
    `> 剩余天数：${daysLeftText(detail.approve_expiration_at)}`,
    mention ? `\n${mention}` : '',
  ].filter(Boolean).join('\n');
  const dedupeKey = ['bd-assigned', webhook, sampleId, title, detail.wecom_userid || '', content].join('|');
  if (shouldSkipWecomNotification(dedupeKey)) {
    console.log(`[wecom] duplicate BD assign notification skipped for sample ${sampleId}`);
    return;
  }

  try {
    await postJson(webhook, {
      msgtype: 'markdown',
      markdown: { content },
    });
    console.log(`[wecom] BD assign notification sent for sample ${sampleId}`);
  } catch (error) {
    console.error(`[wecom] BD assign notification failed for sample ${sampleId}:`, error.message);
  }
}

async function notifySampleOverdueUnpublished(sampleId) {
  const webhook = process.env.QYWX_TK_CREATOR_WEBHOOK || process.env.WECOM_BD_ASSIGN_WEBHOOK || '';
  if (!webhook) {
    console.warn('[wecom] QYWX_TK_CREATOR_WEBHOOK/WECOM_BD_ASSIGN_WEBHOOK is empty, skip overdue notification');
    return;
  }

  const detail = sampleAssignDetail(sampleId);
  if (!detail) {
    console.warn(`[wecom] sample not found for overdue notification: ${sampleId}`);
    return;
  }

  const mention = detail.wecom_userid ? `<@${detail.wecom_userid}>` : '';
  const content = [
    '### 样品超时未发布视频',
    `> 达人名称：${detail.creator_name || '-'}`,
    `> TikTok ID：${detail.creator_handle || detail.uid || '-'}`,
    `> 样品名称：${detail.product_name || '-'}`,
    `> 签收时间：${detail.sample_received_at || '-'}`,
    '> 超时标准：签收后 7 天未发布视频',
    `> 负责BD：${detail.bd_name || '-'}`,
    mention ? `\n${mention}` : '',
  ].filter(Boolean).join('\n');
  const dedupeKey = ['overdue-unpublished', webhook, sampleId, detail.wecom_userid || '', content].join('|');
  if (shouldSkipWecomNotification(dedupeKey)) {
    console.log(`[wecom] duplicate overdue unpublished notification skipped for sample ${sampleId}`);
    return;
  }

  try {
    await postJson(webhook, {
      msgtype: 'markdown',
      markdown: { content },
    });
    console.log(`[wecom] overdue unpublished notification sent for sample ${sampleId}`);
  } catch (error) {
    console.error(`[wecom] overdue unpublished notification failed for sample ${sampleId}:`, error.message);
  }
}

function notifyOverdueUnpublishedSamples(sampleId = null) {
  const where = [
    'bd_id IS NOT NULL',
    'sample_received_at IS NOT NULL',
    "COALESCE(wecom_overdue_notified_at, '') = ''",
    "status NOT IN ('published', 'rejected', 'cancelled')",
    "datetime(sample_received_at, '+7 days') < datetime('now')",
  ];
  const params = [];
  if (sampleId) {
    where.push('id = ?');
    params.push(sampleId);
  }
  const rows = db.prepare(`
    SELECT id
    FROM samples
    WHERE ${where.join(' AND ')}
    LIMIT 20
  `).all(...params);
  rows.forEach((row) => {
    db.prepare('UPDATE samples SET wecom_overdue_notified_at = datetime(\'now\') WHERE id = ?').run(row.id);
    notifySampleOverdueUnpublished(row.id).catch((error) => {
      console.error(`[wecom] unexpected overdue notification error for sample ${row.id}:`, error.message);
    });
  });
}

// 把token写进 .env：如果对应的key已存在就替换，不存在就追加一行
function upsertEnvVar(envText, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(envText)) {
    return envText.replace(re, `${key}=${value}`);
  }
  const sep = envText.endsWith('\n') || envText.length === 0 ? '' : '\n';
  return envText + sep + `${key}=${value}\n`;
}

// 授权码交换 access_token 核心函数
// TikTok Shop 官方接口要求：GET 请求，参数放在 query string 里，
// 参数名是 app_key / app_secret / auth_code，grant_type 固定值是 authorized_code
async function getTokenByCode(code, shopId = 'oku') {
  const { appKey: app_key, appSecret: app_secret } = getAppConfig(shopId);

  if (!app_key || !app_secret) {
    throw new Error(`缺少 ${shopId} 店铺的 TikTok App Key 或 App Secret，请检查 .env 配置`);
  }

  const params = querystring.stringify({
    app_key,
    app_secret,
    auth_code: code,
    grant_type: 'authorized_code'
  });

  const options = {
    hostname: 'auth.tiktok-shops.com',
    port: 443,
    path: `/api/v2/token/get?${params}`,
    method: 'GET'
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        let data;
        try {
          data = JSON.parse(buf);
        } catch (e) {
          return reject(new Error(
            `TikTok 接口未返回 JSON（HTTP ${res.statusCode}），可能接口地址或参数有误。原始返回前200字符：${buf.slice(0, 200)}`
          ));
        }

        if (data.code !== 0) {
          return reject(new Error(data.message || `获取token失败（code=${data.code}）`));
        }

        resolve(data.data);
      });
    });
    req.on('error', reject);
    req.end(); // GET 请求不需要 write body，但仍要调用 end() 才会真正发出去
  });
}

function publicBaseUrl() {
  const redirectUri = process.env.TK_REDIRECT_URI || 'https://aojimiya123.top/tk/api/tiktok/oauth/callback';
  return redirectUri.replace(/\/tk\/api\/tiktok\/oauth\/callback.*$/, '');
}

function oauthCallbackUrl() {
  return process.env.TK_REDIRECT_URI || `${publicBaseUrl()}/tk/api/tiktok/oauth/callback`;
}

function buildTikTokAuthorizeUrl(shopId) {
  const { serviceId } = getAppConfig(shopId);
  if (!serviceId) throw new Error(`缺少 ${shopId} 店铺的 TK_SERVICE_ID 或 TK_APP_KEY`);

  const authBase = process.env.TK_AUTH_URL || 'https://services.tiktokshop.com/open/authorize';
  const url = new URL(authBase);
  url.searchParams.set('service_id', serviceId);
  url.searchParams.set('redirect_url', oauthCallbackUrl());
  url.searchParams.set('state', shopId);
  return url.toString();
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return '';
}

function dateText(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function affiliateOrderRangeFilter(query = {}) {
  const range = String(query.order_range || query.orderRange || '90d');
  const month = String(query.order_month || query.orderMonth || '').trim();
  const where = [];
  const params = [];
  const now = new Date();

  if (range === 'all') return { where, params, label: '历史所有订单' };

  if (range === 'month' && /^\d{4}-\d{2}$/.test(month)) {
    const [year, monthNum] = month.split('-').map(Number);
    const start = `${month}-01 00:00:00`;
    const nextMonth = new Date(year, monthNum, 1);
    const end = `${dateText(nextMonth)} 00:00:00`;
    where.push('order_created_at >= ?');
    where.push('order_created_at < ?');
    params.push(start, end);
    return { where, params, label: `${month} 月`, start, end };
  }

  const days = range === '7d' ? 7 : 90;
  const startDate = new Date(now.getTime() - (days - 1) * 86400000);
  const start = `${dateText(startDate)} 00:00:00`;
  where.push('order_created_at >= ?');
  params.push(start);
  return { where, params, label: `近${days}天`, start };
}

function starByRecentOrders(orderCount) {
  const n = Number(orderCount || 0);
  if (n > 100) return 5;
  if (n >= 50) return 4;
  if (n >= 30) return 3;
  if (n >= 10) return 2;
  if (n > 0) return 1;
  return 0;
}

async function getAuthorizedShops(accessToken, shopId = 'oku') {
  const data = await tiktokRequest({
    path: '/authorization/202309/shops',
    method: 'GET',
    accessToken,
    shopId,
    query: {},
    body: {},
  });
  return data.shops || data.shop_list || [];
}

function pickAuthorizedShop(localShop, authorizedShops) {
  if (!authorizedShops.length) return null;
  const localName = firstText(localShop.name).toLowerCase();
  return authorizedShops.find((shop) => {
    const remoteName = firstText(shop.shop_name, shop.name).toLowerCase();
    return remoteName && (remoteName.includes(localName) || localName.includes(remoteName));
  }) || (authorizedShops.length === 1 ? authorizedShops[0] : null);
}

function normalizeCreatorHandle(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

db.exec(`
CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS agent_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_flow_states (
  flow_key TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_result TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS affiliate_creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  uid TEXT NOT NULL,
  creator_open_id TEXT,
  creator_name TEXT,
  creator_handle TEXT,
  normalized_handle TEXT,
  avatar_url TEXT,
  fans INTEGER DEFAULT 0,
  category TEXT,
  fulfillment_rate REAL,
  avg_view REAL,
  sales_count_30d INTEGER,
  sales_amount_30d REAL,
  gmv_30d REAL,
  videos_30d INTEGER,
  sales_currency TEXT,
  profile_json TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop_id, uid)
);

CREATE TABLE IF NOT EXISTS invitation_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'im',
  type TEXT NOT NULL DEFAULT 'dm',
  scene TEXT NOT NULL DEFAULT 'first_invite',
  shop_ids TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'zh',
  version INTEGER NOT NULL DEFAULT 1,
  product_id INTEGER,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invitation_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  scene TEXT NOT NULL,
  shop_ids TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'zh',
  type TEXT NOT NULL DEFAULT 'dm',
  product_id INTEGER,
  content TEXT NOT NULL,
  commission_rate REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(template_id, version)
);

CREATE TABLE IF NOT EXISTS invitation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  source TEXT NOT NULL,
  uid TEXT NOT NULL,
  creator_name TEXT,
  creator_handle TEXT,
  creator_open_id TEXT,
  template_id INTEGER,
  template_type TEXT NOT NULL DEFAULT 'dm',
  product_id INTEGER,
  product_ids TEXT,
  commission_rate REAL,
  target_collaboration_id TEXT,
  send_mode TEXT NOT NULL DEFAULT 'auto',
  sample_approval_mode TEXT NOT NULL DEFAULT 'manual',
  sample_apply_link TEXT,
  channel TEXT NOT NULL DEFAULT 'im',
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_workflow_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  shop_id TEXT,
  uid TEXT,
  creator_name TEXT,
  creator_handle TEXT,
  sample_id TEXT,
  score INTEGER DEFAULT 0,
  recommendation TEXT,
  reason TEXT,
  payload_json TEXT,
  invitation_record_id INTEGER,
  assigned_bd_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  UNIQUE(workflow_id, task_type, uid, sample_id)
);

CREATE TABLE IF NOT EXISTS review_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  sample_pass_line REAL NOT NULL DEFAULT 70,
  invite_pass_line REAL NOT NULL DEFAULT 70,
  orders_base REAL NOT NULL DEFAULT 1000,
  views_base REAL NOT NULL DEFAULT 5000,
  conversion_base REAL NOT NULL DEFAULT 10,
  orders_weight REAL NOT NULL DEFAULT 30,
  views_weight REAL NOT NULL DEFAULT 30,
  conversion_weight REAL NOT NULL DEFAULT 30,
  fans_hard_limit REAL NOT NULL DEFAULT 1000,
  fans_score_1000 REAL NOT NULL DEFAULT 3,
  fans_score_5000 REAL NOT NULL DEFAULT 5,
  fans_score_50000 REAL NOT NULL DEFAULT 8,
  fans_score_200000 REAL NOT NULL DEFAULT 10,
  missing_data_action TEXT NOT NULL DEFAULT '疑',
  zero_video_action TEXT NOT NULL DEFAULT '第三项计0分，其余照常',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_learning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  event_type TEXT NOT NULL,
  uid TEXT,
  sample_id TEXT,
  input_json TEXT,
  outcome TEXT,
  lesson TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_optimization_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  suggestion_type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_suggestion_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  min_samples INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_experiment_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  template_id INTEGER,
  weight INTEGER NOT NULL DEFAULT 50,
  UNIQUE(experiment_id, name)
);

CREATE TABLE IF NOT EXISTS agent_inbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_message_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  conversation_id TEXT,
  creator_open_id TEXT,
  uid TEXT,
  creator_name TEXT,
  direction TEXT NOT NULL DEFAULT 'inbound',
  message_type TEXT,
  message_text TEXT,
  raw_json TEXT,
  classification TEXT,
  reply_status TEXT NOT NULL DEFAULT 'not_sent',
  reply_text TEXT,
  reply_record_id INTEGER,
  received_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_product_audit_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  learning_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_template_terms (
  template_id INTEGER PRIMARY KEY,
  commission_rate REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.prepare('INSERT OR IGNORE INTO agent_runtime_state (id, paused, updated_at) VALUES (1, 0, ?)').run(nowText());
for (const flowKey of ['auto_invite', 'auto_review', 'auto_assign', 'bd_followup']) {
  db.prepare('INSERT OR IGNORE INTO agent_flow_states (flow_key, active, updated_at) VALUES (?, 1, ?)').run(flowKey, nowText());
}

try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_status TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_message TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN token_expires_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE bd_members ADD COLUMN max_load INTEGER NOT NULL DEFAULT 20'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_templates ADD COLUMN type TEXT NOT NULL DEFAULT 'dm'"); } catch (_) {}
try { db.exec("ALTER TABLE invitation_templates ADD COLUMN scene TEXT NOT NULL DEFAULT 'first_invite'"); } catch (_) {}
try { db.exec("ALTER TABLE invitation_templates ADD COLUMN shop_ids TEXT NOT NULL DEFAULT '[]'"); } catch (_) {}
try { db.exec("ALTER TABLE invitation_templates ADD COLUMN language TEXT NOT NULL DEFAULT 'zh'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
try { db.exec("UPDATE invitation_templates SET scene = CASE WHEN type = 'confirmation' THEN 'sample_followup' WHEN name LIKE '%复邀%' THEN 'reinvite' ELSE 'first_invite' END WHERE scene IS NULL OR scene = ''"); } catch (_) {}
try { db.exec("UPDATE invitation_templates SET shop_ids = '[]' WHERE shop_ids IS NULL OR shop_ids = ''"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_templates ADD COLUMN product_id INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN template_type TEXT NOT NULL DEFAULT 'dm'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN product_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN product_ids TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN commission_rate REAL'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN target_collaboration_id TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN send_mode TEXT NOT NULL DEFAULT 'auto'"); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN sample_approval_mode TEXT NOT NULL DEFAULT 'manual'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN sample_apply_link TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN experiment_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN experiment_variant_id INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE agent_optimization_suggestions ADD COLUMN expected_impact TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE agent_optimization_suggestions ADD COLUMN before_json TEXT NOT NULL DEFAULT '{}'"); } catch (_) {}
try { db.exec("ALTER TABLE agent_optimization_suggestions ADD COLUMN after_json TEXT NOT NULL DEFAULT '{}'"); } catch (_) {}
try { db.exec('ALTER TABLE agent_optimization_suggestions ADD COLUMN decision_at TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_agent_inbox_shop_received ON agent_inbox_messages(shop_id, received_at)'); } catch (_) {}
try { db.exec('ALTER TABLE products ADD COLUMN product_url TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE samples ADD COLUMN commission_rate REAL'); } catch (_) {}
try { db.exec('ALTER TABLE samples ADD COLUMN sample_received_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE samples ADD COLUMN published_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE samples ADD COLUMN wecom_overdue_notified_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN invitation_record_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN assigned_bd_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN review_standard_version INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN score_details_json TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE review_standards ADD COLUMN fans_score_1000 REAL NOT NULL DEFAULT 3'); } catch (_) {}
try { db.exec('ALTER TABLE review_standards ADD COLUMN fans_score_5000 REAL NOT NULL DEFAULT 5'); } catch (_) {}
try { db.exec('ALTER TABLE review_standards ADD COLUMN fans_score_50000 REAL NOT NULL DEFAULT 8'); } catch (_) {}
try { db.exec('ALTER TABLE review_standards ADD COLUMN fans_score_200000 REAL NOT NULL DEFAULT 10'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_count_30d INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_amount_30d REAL'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN gmv_30d REAL'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN videos_30d INTEGER'); } catch (_) {}
try { db.exec('UPDATE affiliate_creators SET gmv_30d = sales_amount_30d WHERE gmv_30d IS NULL AND sales_amount_30d IS NOT NULL'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_currency TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN normalized_handle TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_shop_sales ON affiliate_creators(shop_id, sales_count_30d)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_handle ON affiliate_creators(normalized_handle)'); } catch (_) {}

const DEFAULT_AGENT_SETTINGS = {
  invite_template: '您好，我们是店铺BD，看到您的内容风格和我们的商品很匹配，想邀请您参与样品合作。',
  followup_template: '您好，样品进度想和您确认一下。如已收到样品，方便的话请告知预计发布时间。',
  review_rules: '按近90天出单、内容质量、履约率和沟通效率复盘达人，沉淀复邀和加佣建议。',
  sample_sync_hour: 7,
  agent_daily_hour: 8,
  agent_daily_minute: 30,
  invite_target_count: 50,
  invite_daily_limit: 50,
  audit_min_followers: 1000,
  audit_min_fulfillment: 80,
  assign_strategy: '按店铺、达人类型、BD负载和历史合作经验自动分配',
  followup_interval_days: 3,
  monthly_ai_cost_limit: 0,
  ai_api_key: '',
  ai_model: '不调用 AI',
  ai_monthly_budget: 0,
  notify_webhook: '',
  notify_failure_enabled: 1,
  log_retention_days: 90,
};

const AGENT_FLOW_LABELS = {
  auto_invite: '自动邀约',
  auto_review: '自动审核',
  auto_assign: '自动分配',
  bd_followup: 'BD跟进',
};

function getAgentRuntime() {
  const row = db.prepare('SELECT * FROM agent_runtime_state WHERE id = 1').get();
  return { paused: Boolean(row?.paused), updated_at: row?.updated_at || '' };
}

function getAgentFlowStates() {
  return db.prepare('SELECT * FROM agent_flow_states ORDER BY CASE flow_key WHEN \'auto_invite\' THEN 1 WHEN \'auto_review\' THEN 2 WHEN \'auto_assign\' THEN 3 ELSE 4 END')
    .all()
    .map((row) => ({ ...row, key: row.flow_key, label: AGENT_FLOW_LABELS[row.flow_key] || row.flow_key, active: Boolean(row.active), last_result: parseJsonObject(row.last_result, {}) }));
}

function recordAgentRun(flowKey, mode, status, summary = {}) {
  const now = nowText();
  db.prepare('INSERT INTO agent_run_logs (flow_key, mode, status, summary_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(flowKey, mode, status, JSON.stringify(summary), now);
  db.prepare('UPDATE agent_flow_states SET last_run_at = ?, last_result = ?, updated_at = ? WHERE flow_key = ?')
    .run(now, JSON.stringify(summary), now, flowKey);
}

function agentPendingCount() {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM agent_workflow_tasks WHERE status = 'agent_review'").get()?.c || 0);
}

function agentOverviewData() {
  const settings = getAgentSettings();
  const today = nowText().slice(0, 10);
  const month = today.slice(0, 7);
  const sentToday = Number(db.prepare("SELECT COUNT(*) AS c FROM invitation_records WHERE status = 'sent' AND substr(COALESCE(sent_at, created_at), 1, 10) = ?").get(today)?.c || 0);
  const monthCost = Number(db.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN 0 ELSE 0 END), 0) AS c FROM invitation_records WHERE substr(created_at, 1, 7) = ?").get(month)?.c || 0);
  const pendingItems = db.prepare("SELECT id, task_type, creator_name, uid, reason, updated_at FROM agent_workflow_tasks WHERE status = 'agent_review' ORDER BY updated_at DESC, id DESC LIMIT 10").all();
  return {
    runtime: getAgentRuntime(),
    flows: getAgentFlowStates(),
    today: { sent_invites: sentToday, invite_limit: Number(settings.invite_daily_limit || 0) },
    pending_confirmations: agentPendingCount(),
    pending_items: pendingItems,
    month_ai_cost: monthCost,
    month_ai_cost_limit: Number(settings.monthly_ai_cost_limit || 0),
    standard: getReviewStandard(),
  };
}

function defaultReviewStandard() {
  return {
    version: 1,
    sample_pass_line: 70,
    invite_pass_line: 70,
    orders_base: 1000,
    views_base: 5000,
    conversion_base: 10,
    orders_weight: 30,
    views_weight: 30,
    conversion_weight: 30,
    fans_hard_limit: 1000,
    fans_score_1000: 3,
    fans_score_5000: 5,
    fans_score_50000: 8,
    fans_score_200000: 10,
    missing_data_action: '疑',
    zero_video_action: '第三项计0分，其余照常',
  };
}

function normalizeReviewStandard(input = {}, version = null) {
  const defaults = defaultReviewStandard();
  const number = (key, min = 0) => {
    const value = Number(input[key] ?? defaults[key]);
    return Number.isFinite(value) && value >= min ? value : defaults[key];
  };
  return {
    version: Number(version || input.version || defaults.version),
    sample_pass_line: number('sample_pass_line'),
    invite_pass_line: number('invite_pass_line'),
    orders_base: number('orders_base', 0.000001),
    views_base: number('views_base', 0.000001),
    conversion_base: number('conversion_base', 0.000001),
    orders_weight: number('orders_weight'),
    views_weight: number('views_weight'),
    conversion_weight: number('conversion_weight'),
    fans_hard_limit: number('fans_hard_limit'),
    fans_score_1000: number('fans_score_1000'),
    fans_score_5000: number('fans_score_5000'),
    fans_score_50000: number('fans_score_50000'),
    fans_score_200000: number('fans_score_200000'),
    missing_data_action: String(input.missing_data_action || defaults.missing_data_action),
    zero_video_action: String(input.zero_video_action || defaults.zero_video_action),
  };
}

function getReviewStandard(version = null) {
  const row = version
    ? db.prepare('SELECT * FROM review_standards WHERE version = ?').get(Number(version))
    : db.prepare('SELECT * FROM review_standards ORDER BY version DESC LIMIT 1').get();
  if (row) return normalizeReviewStandard(row, row.version);
  const standard = defaultReviewStandard();
  db.prepare(`
    INSERT INTO review_standards (
      version, sample_pass_line, invite_pass_line, orders_base, views_base, conversion_base,
      orders_weight, views_weight, conversion_weight, fans_hard_limit,
      fans_score_1000, fans_score_5000, fans_score_50000, fans_score_200000,
      missing_data_action, zero_video_action
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(standard.version, standard.sample_pass_line, standard.invite_pass_line, standard.orders_base, standard.views_base, standard.conversion_base, standard.orders_weight, standard.views_weight, standard.conversion_weight, standard.fans_hard_limit, standard.fans_score_1000, standard.fans_score_5000, standard.fans_score_50000, standard.fans_score_200000, standard.missing_data_action, standard.zero_video_action);
  return standard;
}

function saveReviewStandard(input = {}) {
  const standard = normalizeReviewStandard(input);
  const weightTotal = standard.orders_weight + standard.views_weight + standard.conversion_weight + standard.fans_score_200000;
  if (Math.abs(weightTotal - 100) > 0.000001) throw new Error('三项权重合计必须是 100');
  const current = getReviewStandard();
  const nextVersion = Number(current.version || 0) + 1;
  const now = nowText();
  db.prepare(`
    INSERT INTO review_standards (
      version, sample_pass_line, invite_pass_line, orders_base, views_base, conversion_base,
      orders_weight, views_weight, conversion_weight, fans_hard_limit,
      fans_score_1000, fans_score_5000, fans_score_50000, fans_score_200000,
      missing_data_action, zero_video_action, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nextVersion, standard.sample_pass_line, standard.invite_pass_line, standard.orders_base, standard.views_base, standard.conversion_base, standard.orders_weight, standard.views_weight, standard.conversion_weight, standard.fans_hard_limit, standard.fans_score_1000, standard.fans_score_5000, standard.fans_score_50000, standard.fans_score_200000, standard.missing_data_action, standard.zero_video_action, now, now);
  return getReviewStandard(nextVersion);
}

const DEFAULT_INVITATION_TEMPLATES = [
  {
    name: '样品合作邀约',
    channel: 'im',
    type: 'collab',
    scene: 'first_invite',
    language: 'zh',
    content: '您好 {{creator_name}}，我们是 {{shop_name}} 店铺BD。想邀请您体验 {{product_name}}。您可以直接点击链接申请样品：{{sample_apply_link}}',
  },
  {
    name: '私信初次触达',
    channel: 'im',
    type: 'dm',
    scene: 'first_invite',
    language: 'zh',
    content: '您好 {{creator_name}}，我们是 {{shop_name}} 店铺BD。看到您的内容风格和我们的商品很匹配，想了解是否有合作兴趣。',
  },
  {
    name: '复邀老合作达人',
    channel: 'im',
    type: 'dm',
    scene: 'reinvite',
    language: 'zh',
    content: '您好 {{creator_name}}，感谢之前与 {{shop_name}} 的合作。我们近期有新的商品和活动，想再次邀请您参与推广合作，方便的话可以回复确认档期。',
  },
  {
    name: '确认拍摄与发布',
    channel: 'im',
    type: 'confirmation',
    scene: 'sample_followup',
    language: 'zh',
    content: '您好 {{creator_name}}，您申请的 {{product_name}} 样品已收到。请确认是否可以拍摄并发布 TikTok 视频；如果可以，请回复预计发布时间和内容形式。',
  },
];

function ensureInvitationTemplates() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM invitation_templates WHERE active = 1').get().c;
  if (count) return;
  const insert = db.prepare(`
    INSERT INTO invitation_templates (name, channel, type, scene, language, content, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const now = nowText();
  DEFAULT_INVITATION_TEMPLATES.forEach((tpl) => insert.run(tpl.name, tpl.channel, tpl.type || 'dm', tpl.scene || 'first_invite', tpl.language || 'zh', tpl.content, now, now));
  return;
}

ensureInvitationTemplates();
db.prepare(`
  UPDATE invitation_templates
  SET type = 'collab',
      updated_at = ?
  WHERE active = 1 AND name LIKE '%样品合作邀约%'
`).run(nowText());
if (!db.prepare("SELECT id FROM invitation_templates WHERE active = 1 AND type = 'confirmation' LIMIT 1").get()) {
  const now = nowText();
  db.prepare(`INSERT INTO invitation_templates (name, channel, type, scene, language, content, active, created_at, updated_at) VALUES (?, 'im', 'confirmation', 'sample_followup', 'zh', ?, 1, ?, ?)`)
    .run('确认拍摄与发布', '您好 {{creator_name}}，您申请的 {{product_name}} 样品已收到。请确认是否可以拍摄并发布 TikTok 视频；如果可以，请回复预计发布时间和内容形式。', now, now);
}

function getAgentSettings() {
  const rows = db.prepare('SELECT key, value FROM agent_settings').all();
  const data = { ...DEFAULT_AGENT_SETTINGS };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(data, row.key)) data[row.key] = row.value;
  }
  for (const key of ['sample_sync_hour', 'agent_daily_hour', 'agent_daily_minute', 'invite_target_count', 'invite_daily_limit', 'audit_min_followers', 'audit_min_fulfillment', 'followup_interval_days']) {
    const value = Number(data[key]);
    data[key] = Number.isFinite(value) ? value : DEFAULT_AGENT_SETTINGS[key];
  }
  data.ai_api_key = data.ai_api_key ? `********${String(data.ai_api_key).slice(-4)}` : '';
  data.notify_webhook = data.notify_webhook ? `${String(data.notify_webhook).slice(0, 12)}...${String(data.notify_webhook).slice(-4)}` : '';
  return data;
}

function saveAgentSettings(input = {}) {
  const current = getAgentSettings();
  const next = { ...current };
  next.ai_api_key = db.prepare("SELECT value FROM agent_settings WHERE key = 'ai_api_key'").get()?.value || '';
  next.notify_webhook = db.prepare("SELECT value FROM agent_settings WHERE key = 'notify_webhook'").get()?.value || '';
  Object.keys(DEFAULT_AGENT_SETTINGS).forEach((key) => {
    if (input[key] !== undefined && !(key === 'ai_api_key' && /^\*+/.test(String(input[key] || '')))) next[key] = input[key];
  });
  const settingNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  next.sample_sync_hour = Math.max(0, Math.min(23, settingNumber(next.sample_sync_hour, 7)));
  next.agent_daily_hour = Math.max(0, Math.min(23, settingNumber(next.agent_daily_hour, 8)));
  next.agent_daily_minute = Math.max(0, Math.min(59, settingNumber(next.agent_daily_minute, 30)));
  next.invite_target_count = Math.max(1, settingNumber(next.invite_target_count, 50));
  next.invite_daily_limit = Math.max(1, settingNumber(next.invite_daily_limit, next.invite_target_count || 50));
  next.audit_min_followers = Math.max(0, settingNumber(next.audit_min_followers, 0));
  next.audit_min_fulfillment = Math.max(0, Math.min(100, settingNumber(next.audit_min_fulfillment, 0)));
  next.followup_interval_days = Math.max(1, settingNumber(next.followup_interval_days, 3));
  next.ai_monthly_budget = Math.max(0, settingNumber(next.ai_monthly_budget, 0));
  next.ai_model = String(next.ai_model || '不调用 AI');
  next.notify_failure_enabled = next.notify_failure_enabled ? 1 : 0;
  next.log_retention_days = Math.max(1, settingNumber(next.log_retention_days, 90));
  const stmt = db.prepare(`
    INSERT INTO agent_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const now = nowText();
  Object.entries(next).forEach(([key, value]) => stmt.run(key, String(value ?? ''), now));
  return getAgentSettings();
}

function parseNumberFilter(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeImportedCreators(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      uid: firstText(row.uid, row.UID, row.creator_uid, row['达人UID'], row['达人 UID']),
      creator_name: firstText(row.creator_name, row.name, row['达人昵称'], row['达人名称']),
      creator_handle: firstText(row.creator_handle, row.handle, row.tiktok_id, row['TikTok ID']),
      creator_open_id: firstText(row.creator_open_id, row.open_id, row['Open ID']),
      fans: parseNumberFilter(firstText(row.fans, row.followers, row['粉丝量']), 0),
      category: firstText(row.category, row['分类']),
    }))
    .filter((row) => row.uid);
}

function rowMetricNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value).trim().toLowerCase();
  const multiplier =
    text.includes('万') ? 10000 :
    text.includes('千') ? 1000 :
    text.includes('k') ? 1000 :
    text.includes('m') ? 1000000 :
    1;
  const raw = text.replace(/[,%\s万千km]/g, '');
  const num = Number(raw);
  return Number.isFinite(num) ? num * multiplier : 0;
}

function buildCreatorCandidate(row, source, shopMap = {}) {
  const shop = shopMap[row.shop_id] || {};
  const profile = parseJsonObject(row.profile_json, {});
  return {
    source,
    uid: row.uid,
    creator_name: row.creator_name || row.name || row.uid,
    creator_handle: row.creator_handle || row.handle || '',
    creator_open_id: row.creator_open_id || row.open_id || row.uid || '',
    shop_id: row.shop_id || '',
    shop_name: shop.name || row.shop_name || row.shop_id || '',
    fans: Number(row.fans || 0),
    category: row.category || '',
    fulfillment_rate: rowMetricNumber(row.fulfillment_rate),
    avg_view: rowMetricNumber(row.avg_view),
    monthly_avg_view: rowMetricNumber(row.avg_view || profile.monthly_avg_view || profile.avg_view),
    monthly_videos: profile.monthly_videos ?? profile.videos ?? profile.published_videos,
    videos_30d: row.videos_30d === undefined || row.videos_30d === null
      ? (profile.videos_30d ?? profile.video_count_30d ?? profile.published_videos_30d ?? profile.monthly_videos ?? profile.videos ?? profile.published_videos)
      : Number(row.videos_30d || 0),
    star: Number(row.star || 0),
    total_orders: Number(row.total_orders || 0),
    sales_count_30d: row.sales_count_30d === undefined || row.sales_count_30d === null ? null : Number(row.sales_count_30d || 0),
    sales_amount: Number(row.sales_amount || 0),
    gmv_30d: row.gmv_30d === undefined || row.gmv_30d === null ? Number(row.sales_amount || 0) : Number(row.gmv_30d || 0),
    metrics_source: row.metrics_source || (source === 'shop_pool' ? 'affiliate_center' : 'shop_orders'),
    latest_at: row.latest_at || row.applied_at || row.library_added_at || row.synced_at || '',
    last_invited_at: row.last_invited_at || '',
    invited_count: Number(row.invited_count || 0),
  };
}

function applyCandidateFilters(list, query = {}) {
  const minFans = parseNumberFilter(query.min_fans, 0);
  const minFulfillment = parseNumberFilter(query.min_fulfillment, 0);
  const minAvgView = parseNumberFilter(query.min_avg_view, 0);
  const minStar = parseNumberFilter(query.min_star, 0);
  const minOrders = parseNumberFilter(query.min_orders, 0);
  const minGmv = parseNumberFilter(query.min_gmv, 0);
  const minVideos = parseNumberFilter(query.min_monthly_videos, 0);
  const category = String(query.category || '').trim().toLowerCase();
  const search = String(query.search || '').trim().toLowerCase();

  return list.filter((item) => {
    if (minFans && Number(item.fans || 0) < minFans) return false;
    if (minFulfillment && Number(item.fulfillment_rate || 0) < minFulfillment) return false;
    if (minAvgView && Number(item.avg_view || 0) < minAvgView) return false;
    if (minStar && Number(item.star || 0) < minStar) return false;
    if (minOrders && Number(item.total_orders || 0) < minOrders) return false;
    if (minGmv && Number(item.gmv_30d || 0) < minGmv) return false;
    if (minVideos && Number(item.videos_30d ?? item.monthly_videos ?? 0) < minVideos) return false;
    if (category && !String(item.category || '').toLowerCase().includes(category)) return false;
    if (search) {
      const haystack = `${item.uid} ${item.creator_name} ${item.creator_handle}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function dedupeCandidates(list) {
  const map = new Map();
  for (const item of list) {
    const handle = normalizeCreatorHandle(item.creator_handle);
    const key = handle ? `handle:${handle}` : `uid:${item.uid}`;
    const existing = map.get(key);
    if (!existing || Number(item.fans || 0) > Number(existing.fans || 0)) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

function invitationStatsByUid() {
  const rows = db.prepare(`
    SELECT uid, COUNT(*) AS invited_count, MAX(created_at) AS last_invited_at
    FROM invitation_records
    GROUP BY uid
  `).all();
  const map = {};
  rows.forEach((row) => { map[row.uid] = row; });
  return map;
}

function affiliateCreatorPoolStats(query = {}) {
  const shop = String(query.shop || 'all');
  const args = [];
  const where = [];
  if (shop !== 'all') {
    where.push('(shop_id = ? OR COALESCE(shop_id, \'\') = \'\')');
    args.push(shop);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sales_count_30d IS NOT NULL THEN 1 ELSE 0 END) AS with_sales_30d,
      MAX(synced_at) AS last_synced_at
    FROM affiliate_creators
    ${whereSql}
  `).get(...args);
  return {
    total: Number(row?.total || 0),
    with_sales_30d: Number(row?.with_sales_30d || 0),
    last_synced_at: row?.last_synced_at || '',
    requires_sync: Number(row?.total || 0) === 0 || Number(row?.with_sales_30d || 0) === 0,
  };
}

function inviteCandidateDiagnostics(query = {}) {
  const source = String(query.source || 'shop_pool');
  if (source !== 'shop_pool') return null;
  const pool = affiliateCreatorPoolStats(query);
  const minOrders = parseNumberFilter(query.min_orders, 0);
  return {
    source: 'affiliate_center',
    sales_metric: 'sales_count_30d',
    sales_metric_label: '联盟中心达人近30天销量',
    includes_other_sellers: true,
    excludes_local_shop_orders: true,
    pool,
    warning: pool.requires_sync
      ? '联盟中心达人池或近30天销量尚未同步，系统不会使用合作达人库或本店订单数据替代。'
      : (minOrders > 0 ? `已按联盟中心近30天销量 >= ${minOrders} 筛选。` : ''),
  };
}

function listInviteCandidates(query = {}) {
  const source = String(query.source || 'shop_pool');
  const shop = String(query.shop || 'all');
  const shopRows = db.prepare('SELECT id, name FROM shops').all();
  const shopMap = {};
  shopRows.forEach((row) => { shopMap[row.id] = row; });
  const inviteStats = invitationStatsByUid();
  let list = [];

  if (source === 'library') {
    const rows = db.prepare(`
      SELECT
        s.uid,
        MAX(s.creator_name) AS creator_name,
        MAX(s.creator_handle) AS creator_handle,
        MAX(s.shop_id) AS shop_id,
        MAX(s.fans) AS fans,
        MAX(s.category) AS category,
        MAX(s.fulfillment_rate) AS fulfillment_rate,
        MAX(s.avg_view) AS avg_view,
        MAX(COALESCE(s.sales_count, 0)) AS total_orders,
        MAX(s.library_added_at) AS latest_at,
        MAX(COALESCE(l.star, 0)) AS star
      FROM samples s
      LEFT JOIN creator_library l ON l.uid = s.uid
      WHERE s.library_added_at IS NOT NULL
        ${shop !== 'all' ? 'AND s.shop_id = ?' : ''}
      GROUP BY s.uid
      ORDER BY latest_at DESC
      LIMIT 500
    `).all(...(shop !== 'all' ? [shop] : []));
    list = rows.map((row) => ({ ...row, ...(inviteStats[row.uid] || {}) }));
  } else if (source === 'import') {
    list = normalizeImportedCreators(query.imported || []).map((row) => ({ ...row, shop_id: shop === 'all' ? '' : shop }));
  } else {
    const rows = db.prepare(`
      SELECT
        ac.uid,
        ac.creator_name,
        ac.creator_handle,
        ac.creator_open_id,
        ac.shop_id,
        ac.fans,
        ac.category,
        ac.fulfillment_rate,
        ac.avg_view,
        ac.profile_json,
        ac.sales_count_30d,
        ac.gmv_30d,
        ac.videos_30d,
        COALESCE(ac.sales_count_30d, 0) AS total_orders,
        ac.sales_amount_30d AS sales_amount,
        ac.synced_at AS latest_at,
        'affiliate_center' AS metrics_source,
        COALESCE(l.star, 0) AS star
      FROM affiliate_creators ac
      LEFT JOIN creator_library l ON l.uid = ac.uid
      WHERE 1 = 1
        ${shop !== 'all' ? 'AND (ac.shop_id = ? OR COALESCE(ac.shop_id, \'\') = \'\')' : ''}
      ORDER BY COALESCE(ac.sales_count_30d, -1) DESC, ac.synced_at DESC
      LIMIT 1000
    `).all(...(shop !== 'all' ? [shop] : []));
    list = rows.map((row) => ({ ...row, ...(inviteStats[row.uid] || {}) }));
  }

  const candidates = dedupeCandidates(list.map((row) => buildCreatorCandidate(row, source, shopMap)));
  return applyCandidateFilters(candidates, query).slice(0, 200);
}

function parseJsonObject(value, fallback = {}) {
  try {
    const data = JSON.parse(value || '');
    return data && typeof data === 'object' ? data : fallback;
  } catch (_) {
    return fallback;
  }
}

function defaultWorkflowConfig() {
  const firstTemplate = db.prepare("SELECT id FROM invitation_templates WHERE active = 1 AND type = 'collab' ORDER BY id LIMIT 1").get();
  const firstProduct = db.prepare('SELECT id, shop_id FROM products ORDER BY id LIMIT 1').get();
  const bdRows = db.prepare('SELECT id FROM bd_members WHERE active = 1 ORDER BY id LIMIT 3').all();
  return {
    source: 'shop_pool',
    shop: firstProduct?.shop_id || 'all',
    min_star: 0,
    min_fans: 0,
    min_fulfillment: 0,
    min_avg_view: 0,
    min_orders: 0,
    category: '',
    template_id: firstTemplate?.id || '',
    confirmation_template_id: db.prepare("SELECT id FROM invitation_templates WHERE active = 1 AND type = 'confirmation' ORDER BY id LIMIT 1").get()?.id || null,
    product_ids: firstProduct?.id ? [firstProduct.id] : [],
    commission_rate: 15,
    send_mode: 'manual',
    invite_max_per_creator: 1,
    invite_daily_limit: 50,
    sample_approval_mode: 'manual',
    audit_min_score: 70,
    score_model: 'creator_table_v1',
    auto_approve_score: 90,
    bd_ids: bdRows.map((row) => row.id),
    assign_mode: 'round_robin',
    experiment_id: null,
    auto_reply_template: '您好，样品申请已收到，我们会尽快审核并安排后续沟通。',
  };
}

function getWorkflow(id = null) {
  let row = id
    ? db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM agent_workflows WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    const now = nowText();
    const result = db.prepare(`
      INSERT INTO agent_workflows (name, active, config_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?)
    `).run('默认自动化工作流', JSON.stringify(defaultWorkflowConfig()), now, now);
    row = db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(result.lastInsertRowid);
  }
  return { ...row, config: { ...defaultWorkflowConfig(), ...parseJsonObject(row.config_json, {}) } };
}

function saveWorkflow(input = {}, createNew = false) {
  const current = createNew ? null : getWorkflow(input.id || null);
  const config = { ...defaultWorkflowConfig(), ...(current?.config || {}), ...(input.config || input) };
  config.product_ids = Array.isArray(config.product_ids)
    ? config.product_ids.map(Number).filter(Boolean)
    : String(config.product_ids || '').split(',').map(Number).filter(Boolean);
  config.bd_ids = Array.isArray(config.bd_ids)
    ? config.bd_ids.map(Number).filter(Boolean)
    : String(config.bd_ids || '').split(',').map(Number).filter(Boolean);
  config.min_star = Number(config.min_star || 0);
  config.min_fans = Number(config.min_fans || 0);
  config.min_fulfillment = Number(config.min_fulfillment || 0);
  config.min_avg_view = Number(config.min_avg_view || 0);
  config.min_orders = Number(config.min_orders || 0);
  config.commission_rate = Number(config.commission_rate || 0);
  config.invite_max_per_creator = Math.max(1, Number(config.invite_max_per_creator || 1));
  config.invite_daily_limit = Math.max(1, Number(config.invite_daily_limit || 50));
  config.invite_target_count = Math.max(1, Number(config.invite_target_count || config.invite_daily_limit || 50));
  config.audit_min_score = Number(config.audit_min_score || 70);
  config.score_model = config.score_model === 'creator_table_v1' ? 'creator_table_v1' : 'creator_table_v1';
  if (config.score_model === 'creator_table_v1') {
    config.min_star = 0;
    config.min_fans = 0;
    config.min_fulfillment = 0;
    config.min_avg_view = 0;
    config.min_orders = 0;
    config.category = '';
  }
  config.auto_approve_score = Number(config.auto_approve_score || 90);
  config.experiment_id = config.experiment_id ? Number(config.experiment_id) : null;
  config.confirmation_template_id = config.confirmation_template_id ? Number(config.confirmation_template_id) : null;
  // Invites run automatically; sample approval remains an explicit admin gate.
  config.send_mode = 'auto';
  config.sample_approval_mode = 'manual';
  config.assign_mode = config.assign_mode === 'least_load' ? 'least_load' : 'round_robin';
  config.product_audit_rules = config.product_audit_rules && typeof config.product_audit_rules === 'object'
    ? config.product_audit_rules
    : {};
  const name = String(input.name || current?.name || '自动化工作流').trim();
  if (createNew || !current) {
    const now = nowText();
    const result = db.prepare(`
      INSERT INTO agent_workflows (name, active, config_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?)
    `).run(name, JSON.stringify(config), now, now);
    const saved = getWorkflow(result.lastInsertRowid);
    for (const productId of saved.config.product_ids) {
      const rules = normalizeAuditRules(config.product_audit_rules[String(productId)]);
      if (rules.length) saveProductAuditProfile(productId, { rules });
    }
    return saved;
  }
  db.prepare('UPDATE agent_workflows SET name = ?, config_json = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(config), nowText(), current.id);
  const saved = getWorkflow(current.id);
  for (const productId of saved.config.product_ids) {
    const rules = normalizeAuditRules(config.product_audit_rules[String(productId)]);
    if (rules.length) saveProductAuditProfile(productId, { rules });
  }
  return saved;
}

const AUDIT_METRIC_LABELS = {
  monthly_orders: '月成交件数',
  monthly_videos: '月发布视频数',
  followers: '粉丝数',
  fulfillment_rate: '履约率 %',
  avg_view: '平均播放量',
  star: '达人星级',
};

function defaultProductAuditRules() {
  return [
    { metric: 'monthly_orders', operator: 'gte', value: 1, weight: 30, required: false },
    { metric: 'monthly_videos', operator: 'lt', value: 200, weight: 20, required: false },
    { metric: 'fulfillment_rate', operator: 'gte', value: 80, weight: 30, required: true },
    { metric: 'followers', operator: 'gte', value: 1000, weight: 20, required: false },
  ];
}

function normalizeAuditRules(value) {
  const source = Array.isArray(value) ? value : [];
  const operators = new Set(['gte', 'gt', 'lte', 'lt', 'eq']);
  return source.map((rule) => ({
    metric: Object.prototype.hasOwnProperty.call(AUDIT_METRIC_LABELS, rule?.metric) ? rule.metric : '',
    operator: operators.has(String(rule?.operator)) ? String(rule.operator) : 'gte',
    value: Number.isFinite(Number(rule?.value)) ? Number(rule.value) : 0,
    weight: Math.max(1, Math.min(100, Number(rule?.weight || 1))),
    required: Boolean(rule?.required),
  })).filter((rule) => rule.metric);
}

function getProductAuditProfile(productId) {
  const row = db.prepare('SELECT * FROM agent_product_audit_profiles WHERE product_id = ?').get(Number(productId || 0));
  if (!row) return null;
  return { ...row, rules: normalizeAuditRules(parseJsonObject(row.rules_json, [])) };
}

function saveProductAuditProfile(productId, input = {}) {
  const id = Number(productId || 0);
  if (!id) throw new Error('商品 ID 不正确');
  const rules = normalizeAuditRules(input.rules);
  if (!rules.length) throw new Error('至少配置一条有效审核指标');
  const existing = getProductAuditProfile(id);
  const version = Number(existing?.version || 0) + 1;
  const now = nowText();
  db.prepare(`
    INSERT INTO agent_product_audit_profiles (product_id, name, rules_json, version, learning_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      name = excluded.name, rules_json = excluded.rules_json, version = excluded.version,
      learning_enabled = excluded.learning_enabled, updated_at = excluded.updated_at
  `).run(id, String(input.name || `商品 ${id} 审核模板`), JSON.stringify(rules), version, input.learning_enabled === false ? 0 : 1, now, now);
  return getProductAuditProfile(id);
}

function productAuditRules(productId, config = {}) {
  const profile = getProductAuditProfile(productId);
  if (profile?.rules?.length) return profile.rules;
  const inline = config.product_audit_rules?.[String(productId)] || config.product_audit_rules?.[Number(productId)];
  return normalizeAuditRules(inline?.rules || inline) || [];
}

function applyOptimizationProposal(suggestion) {
  const workflowId = Number(suggestion?.workflow_id || 0);
  const proposal = parseJsonObject(suggestion?.proposal_json, {});
  if (!workflowId || !proposal.action) return { applied: false, reason: '优化建议缺少工作流或动作' };

  // Only apply reversible threshold changes automatically. Copy and send-policy
  // suggestions stay human-controlled because they can affect external messages.
  if (proposal.action !== 'review_thresholds') {
    return { applied: false, reason: '该建议需要人工在工作流设置中实施' };
  }
  const workflow = getWorkflow(workflowId);
  const current = Number(workflow.config.min_fulfillment || 0);
  const next = Math.max(current, Math.min(100, Number(proposal.min_fulfillment || 0)));
  if (!next || next <= current) {
    return { applied: false, reason: '建议阈值未高于当前阈值' };
  }
  const updated = saveWorkflow({ id: workflowId, config: { min_fulfillment: next } });
  return { applied: true, changes: { min_fulfillment: { from: current, to: next } }, workflow: updated };
}

function auditByWorkflowConditions(item, config, customRules = null) {
  const rules = normalizeAuditRules(customRules);
  if (rules.length) {
    const metricSource = {
      monthly_orders: ['monthly_orders', 'total_orders', 'sales_count_30d', 'sales_count'],
      monthly_videos: ['monthly_videos', 'videos', 'published_videos'],
      followers: ['fans'],
      fulfillment_rate: ['fulfillment_rate'],
      avg_view: ['avg_view'],
      star: ['star'],
    };
    const values = {};
    const available = {};
    for (const [metric, keys] of Object.entries(metricSource)) {
      const key = keys.find((name) => item[name] !== undefined && item[name] !== null && item[name] !== '');
      available[metric] = Boolean(key);
      values[metric] = metric === 'avg_view' ? rowMetricNumber(item[key]) : Number(item[key] || 0);
    }
    const compare = {
      gte: (actual, expected) => actual >= expected,
      gt: (actual, expected) => actual > expected,
      lte: (actual, expected) => actual <= expected,
      lt: (actual, expected) => actual < expected,
      eq: (actual, expected) => actual === expected,
    };
    const checks = rules.map((rule) => {
      const actual = values[rule.metric];
      const pass = available[rule.metric] && compare[rule.operator](actual, rule.value);
      return {
        name: AUDIT_METRIC_LABELS[rule.metric],
        metric: rule.metric,
        operator: rule.operator,
        expected: rule.value,
        actual,
        weight: rule.weight,
        required: rule.required,
        pass,
        detail: !available[rule.metric]
          ? `${AUDIT_METRIC_LABELS[rule.metric]} 数据缺失`
          : `${AUDIT_METRIC_LABELS[rule.metric]} ${pass ? '达标' : '未达标'}（${actual} ${rule.operator} ${rule.value}）`,
      };
    });
    const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0) || 1;
    const score = Math.round(checks.filter((check) => check.pass).reduce((sum, check) => sum + check.weight, 0) / totalWeight * 100);
    const requiredFailed = checks.filter((check) => check.required && !check.pass);
    return {
      score,
      recommendation: requiredFailed.length || score < Number(config.audit_min_score || 70) ? 'manual_review' : 'auto_pass',
      reason: requiredFailed.length
        ? `必需指标未达标：${requiredFailed.map((check) => check.detail).join('，')}`
        : `指标得分 ${score}，${score >= Number(config.audit_min_score || 70) ? '达到审核线' : '未达到审核线'}`,
      checks,
      rules,
      rule_source: 'product_profile',
    };
  }
  const checks = [];
  const category = String(config.category || '').trim().toLowerCase();
  const itemCategory = String(item.category || '').toLowerCase();
  checks.push({
    enabled: Number(config.min_star || 0) > 0,
    pass: Number(item.star || 0) >= Number(config.min_star || 0),
    ok: '星级达标',
    fail: `星级不足(${Number(item.star || 0)}/${Number(config.min_star || 0)})`,
  });
  checks.push({
    enabled: Number(config.min_fans || 0) > 0,
    pass: Number(item.fans || 0) >= Number(config.min_fans || 0),
    ok: '粉丝达标',
    fail: `粉丝不足(${Number(item.fans || 0)}/${Number(config.min_fans || 0)})`,
  });
  checks.push({
    enabled: Number(config.min_fulfillment || 0) > 0,
    pass: Number(item.fulfillment_rate || 0) >= Number(config.min_fulfillment || 0),
    ok: '履约率达标',
    fail: `履约率不足(${Number(item.fulfillment_rate || 0)}/${Number(config.min_fulfillment || 0)}%)`,
  });
  checks.push({
    enabled: Number(config.min_avg_view || 0) > 0,
    pass: rowMetricNumber(item.avg_view) >= Number(config.min_avg_view || 0),
    ok: '均播放达标',
    fail: `均播放不足(${rowMetricNumber(item.avg_view)}/${Number(config.min_avg_view || 0)})`,
  });
  checks.push({
    enabled: Number(config.min_orders || 0) > 0,
    pass: Number(item.total_orders ?? item.sales_count ?? 0) >= Number(config.min_orders || 0),
    ok: '近30天销量达标',
    fail: `近30天销量不足(${Number(item.total_orders ?? item.sales_count ?? 0)}/${Number(config.min_orders || 0)})`,
  });
  checks.push({
    enabled: Boolean(category),
    pass: itemCategory.includes(category),
    ok: '类目匹配',
    fail: `类目不匹配(${item.category || '未填写'})`,
  });
  const active = checks.filter((item) => item.enabled);
  const failed = active.filter((item) => !item.pass);
  const passed = active.filter((item) => item.pass);
  return {
    score: failed.length ? 0 : 100,
    recommendation: failed.length ? 'manual_review' : 'auto_pass',
    reason: (failed.length ? failed.map((item) => item.fail) : passed.map((item) => item.ok)).join('，') || '未设置硬性审核条件，自动通过',
    checks: active.map((item) => ({ name: item.ok, pass: item.pass, detail: item.pass ? item.ok : item.fail })),
  };
}

function agentScoreCandidate(item, config) {
  return scoreByReviewStandard(item, getReviewStandard(), 'invite');
}

function agentScoreSample(sample, config) {
  return scoreByReviewStandard({
    ...sample,
    total_orders: sample.total_orders ?? sample.sales_count ?? 0,
    monthly_videos: sample.monthly_videos ?? sample.videos,
  }, getReviewStandard(), 'sample');
}

function scoreByReviewStandard(item, standard, thresholdType) {
  const ordersValue = item.monthly_orders ?? item.total_orders ?? item.sales_count_30d ?? item.sales_count;
  const viewsValue = item.monthly_avg_view ?? item.avg_view;
  const videosValue = item.monthly_videos ?? item.videos ?? item.published_videos;
  const orders = Number(ordersValue || 0);
  const views = rowMetricNumber(viewsValue);
  const videos = Number(videosValue || 0);
  const conversion = videos > 0 ? orders / videos : 0;
  const missing = [ordersValue, viewsValue, videosValue].some((value) => value === undefined || value === null || value === '');
  const fanScore = fansScoreForValue(Number(item.fans || item.followers || 0), standard);
  const checks = [
    { name: '粉丝数', metric: 'fans', actual: Number(item.fans || item.followers || 0), base: standard.fans_hard_limit, weight: fanScore, score: fanScore },
    { name: '30天成交件数', metric: 'orders', actual: orders, base: standard.orders_base, weight: standard.orders_weight, score: Math.min(orders / standard.orders_base, 1) * standard.orders_weight },
    { name: '30天视频平均播放量', metric: 'views', actual: views, base: standard.views_base, weight: standard.views_weight, score: Math.min(views / standard.views_base, 1) * standard.views_weight },
    { name: '成交件数 ÷ 发布视频数', metric: 'conversion', actual: conversion, base: standard.conversion_base, weight: standard.conversion_weight, score: Math.min(conversion / standard.conversion_base, 1) * standard.conversion_weight },
  ].map((check) => ({
    ...check,
    score: Math.round(check.score * 100) / 100,
    detail: `${check.name}：${Number(check.actual.toFixed ? check.actual.toFixed(2) : check.actual)}，得分 ${Math.round(check.score * 100) / 100}/${check.weight}`,
  }));
  const score = Math.round(checks.reduce((sum, check) => sum + check.score, 0) * 100) / 100;
  const fans = Number(item.fans || item.followers || 0);
  const threshold = thresholdType === 'invite' ? standard.invite_pass_line : standard.sample_pass_line;
  let decision = '通过';
  let recommendation = 'auto_pass';
  let reason = `总分 ${score}，达到${thresholdType === 'invite' ? '邀约筛选' : '样品审核'}通过线 ${threshold}`;
  if (fans < standard.fans_hard_limit) {
    decision = '不通过';
    recommendation = 'manual_review';
    reason = `粉丝数 ${fans} 低于硬门槛 ${standard.fans_hard_limit}`;
  } else if (missing) {
    decision = standard.missing_data_action === '不通过' ? '不通过' : '存疑';
    recommendation = 'manual_review';
    reason = standard.missing_data_action === '不通过' ? '缺少30天数据，按当前标准不通过' : '缺少30天数据，需人工确认';
  } else if (score < threshold) {
    decision = '不通过';
    recommendation = 'manual_review';
    reason = `总分 ${score} 未达到通过线 ${threshold}`;
  }
  return {
    score,
    recommendation,
    decision,
    reason,
    checks: checks.map((check) => ({ ...check, pass: check.score > 0 })),
    score_details: checks,
    review_standard_version: standard.version,
    rule_source: 'review_standards',
    score_formula: 'min(实际值÷基准值, 1)×权重；总分为三项之和；视频数为0时第三项计0分',
  };
}

function fansScoreForValue(fans, standard) {
  if (fans < standard.fans_hard_limit) return 0;
  if (fans < 5000) return standard.fans_score_1000;
  if (fans < 50000) return standard.fans_score_5000;
  if (fans < 200000) return standard.fans_score_50000;
  return standard.fans_score_200000;
}

function recordLearningEvent({ workflowId, eventType, uid, sampleId, input, outcome, lesson }) {
  db.prepare(`
    INSERT INTO agent_learning_events (workflow_id, event_type, uid, sample_id, input_json, outcome, lesson)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workflowId || null, eventType, uid || null, sampleId || null, JSON.stringify(input || {}), outcome || '', lesson || '');
}

function buildOptimizationReport(workflowId = null) {
  const workflow = getWorkflow(workflowId);
  const sent = Number(db.prepare("SELECT COUNT(*) AS c FROM invitation_records WHERE status = 'sent'").get().c || 0);
  const invitationTotal = Number(db.prepare('SELECT COUNT(*) AS c FROM invitation_records').get().c || 0);
  const applied = Number(db.prepare(`
    SELECT COUNT(DISTINCT uid) AS c FROM samples
    WHERE uid IN (SELECT uid FROM invitation_records)
  `).get().c || 0);
  const fulfilled = Number(db.prepare(`
    SELECT COUNT(DISTINCT uid) AS c FROM samples
    WHERE uid IN (SELECT uid FROM invitation_records)
      AND status IN ('approved','assigned','shipped','published')
  `).get().c || 0);
  const published = Number(db.prepare(`
    SELECT COUNT(DISTINCT uid) AS c FROM samples
    WHERE uid IN (SELECT uid FROM invitation_records) AND status = 'published'
  `).get().c || 0);
  const learning = db.prepare(`
    SELECT event_type, outcome, COUNT(*) AS count
    FROM agent_learning_events
    WHERE workflow_id = ? OR workflow_id IS NULL
    GROUP BY event_type, outcome ORDER BY count DESC
  `).all(workflow.id);
  const templates = db.prepare(`
    SELECT t.id, t.name, COUNT(r.id) AS sends,
      SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
      COUNT(DISTINCT CASE WHEN s.status IN ('approved','assigned','shipped','published') THEN s.uid END) AS cooperated
    FROM invitation_templates t
    LEFT JOIN invitation_records r ON r.template_id = t.id
    LEFT JOIN samples s ON s.uid = r.uid
    WHERE t.active = 1 GROUP BY t.id ORDER BY cooperated DESC, sent DESC
  `).all();
  const suggestions = [];
  if (invitationTotal && sent / invitationTotal < 0.7) {
    suggestions.push({
      suggestion_type: 'delivery', title: '检查邀约发送失败率',
      reason: `当前邀约记录 ${invitationTotal} 条，成功发送 ${sent} 条，成功率 ${Math.round(sent / invitationTotal * 100)}%。建议先检查店铺授权、达人 open_id 和 API 限流。`,
      proposal: { action: 'keep_manual_send', send_success_rate: sent / invitationTotal },
    });
  }
  if (applied && fulfilled / applied < 0.5) {
    suggestions.push({
      suggestion_type: 'audit', title: '提高样品审核中的履约风险提示',
      reason: `邀约关联达人 ${applied} 位，进入有效合作 ${fulfilled} 位，履约转化 ${Math.round(fulfilled / applied * 100)}%。建议提高履约率/历史内容质量门槛，并保留人工复核。`,
      proposal: { action: 'review_thresholds', min_fulfillment: Math.max(Number(workflow.config.min_fulfillment || 0), 80) },
    });
  }
  if (fulfilled && published / fulfilled < 0.5) {
    suggestions.push({
      suggestion_type: 'followup', title: '优化寄样后的跟进节奏',
      reason: `有效合作 ${fulfilled} 位，已发布 ${published} 位，发布转化 ${Math.round(published / fulfilled * 100)}%。建议启用寄样后 3 天确认、7 天提醒两段式话术。`,
      proposal: { action: 'add_followup_sequence', intervals_days: [3, 7] },
    });
  }
  const replySignals = learning.filter((row) => row.event_type === 'creator_reply');
  if (replySignals.length) {
    suggestions.push({
      suggestion_type: 'copy', title: '根据达人回复持续优化话术',
      reason: `已累计 ${replySignals.reduce((n, row) => n + Number(row.count || 0), 0)} 条达人回复学习记录。建议将高频正向回复对应话术做 A/B 测试，暂不直接覆盖现有模板。`,
      proposal: { action: 'ab_test_invitation_copy', source: 'creator_reply_events' },
    });
  }
  return { workflow, metrics: { invitation_total: invitationTotal, sent, applied, fulfilled, published }, learning, templates, suggestions };
}

function saveOptimizationSuggestions(workflowId, suggestions) {
  const insert = db.prepare(`
    INSERT INTO agent_optimization_suggestions (workflow_id, suggestion_type, title, reason, proposal_json, expected_impact)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  for (const item of suggestions) ids.push(Number(insert.run(workflowId, item.suggestion_type, item.title, item.reason, JSON.stringify(item.proposal || {}), String(item.expected_impact || '需启用后观察实际变化')).lastInsertRowid));
  return ids;
}

function experimentVariant(experimentId, uid) {
  const experiment = db.prepare('SELECT * FROM agent_experiments WHERE id = ? AND status = \'running\'').get(Number(experimentId));
  if (!experiment) return null;
  const variants = db.prepare('SELECT * FROM agent_experiment_variants WHERE experiment_id = ? ORDER BY id').all(experiment.id);
  if (!variants.length) return null;
  const total = variants.reduce((sum, item) => sum + Math.max(1, Number(item.weight || 0)), 0);
  let hash = 0;
  for (const char of String(uid || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  let cursor = hash % total;
  for (const variant of variants) {
    cursor -= Math.max(1, Number(variant.weight || 0));
    if (cursor < 0) return { experiment, variant };
  }
  return { experiment, variant: variants[variants.length - 1] };
}

function experimentReport(experimentId) {
  const experiment = db.prepare('SELECT * FROM agent_experiments WHERE id = ?').get(Number(experimentId));
  if (!experiment) return null;
  const variants = db.prepare(`
    SELECT v.id, v.name, v.template_id, v.weight,
      COUNT(r.id) AS records,
      SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
      COUNT(DISTINCT CASE WHEN s.id IS NOT NULL THEN s.uid END) AS applied,
      COUNT(DISTINCT CASE WHEN s.status IN ('approved','assigned','shipped','published') THEN s.uid END) AS cooperated,
      COUNT(DISTINCT CASE WHEN s.status = 'published' THEN s.uid END) AS published
    FROM agent_experiment_variants v
    LEFT JOIN invitation_records r ON r.experiment_variant_id = v.id
    LEFT JOIN samples s ON s.uid = r.uid
    WHERE v.experiment_id = ?
    GROUP BY v.id ORDER BY v.id
  `).all(experiment.id).map((row) => ({
    ...row,
    send_rate: row.records ? Number(row.sent || 0) / Number(row.records) : 0,
    cooperation_rate: row.sent ? Number(row.cooperated || 0) / Number(row.sent) : 0,
    publish_rate: row.cooperated ? Number(row.published || 0) / Number(row.cooperated) : 0,
  }));
  const enough = variants.every((row) => Number(row.sent || 0) >= Number(experiment.min_samples || 30));
  const winner = enough ? [...variants].sort((a, b) => b.cooperation_rate - a.cooperation_rate || b.publish_rate - a.publish_rate)[0] : null;
  return { experiment, variants, enough_data: enough, winner: winner ? { id: winner.id, name: winner.name, reason: '以有效合作率优先，视频发布率作为并列判断' } : null };
}

function leastLoadBdId(config) {
  const ids = (config.bd_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT b.id, COUNT(s.id) AS load
    FROM bd_members b
    LEFT JOIN samples s ON s.bd_id = b.id AND s.library_added_at IS NULL
    WHERE b.active = 1 AND b.id IN (${placeholders})
    GROUP BY b.id
    ORDER BY load ASC, b.id ASC
  `).all(...ids);
  return rows[0]?.id || ids[0] || null;
}

function workflowBdIds(config) {
  const ids = (config.bd_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM bd_members WHERE active = 1 AND id IN (${placeholders}) ORDER BY id`).all(...ids);
  const active = new Set(rows.map((row) => Number(row.id)));
  return ids.filter((id) => active.has(id));
}

function bdIdForWorkflowTask(config, index) {
  const ids = workflowBdIds(config);
  if (!ids.length) return null;
  if (config.assign_mode === 'least_load' || ids.length === 1) return leastLoadBdId(config);
  return ids[index % ids.length];
}

function insertWorkflowTask(workflowId, type, status, item, audit, payload = {}) {
  const taskKey = item.sample_id || (type === 'invite' ? `invite:${item.uid || item.creator_handle || item.creator_name}` : null);
  db.prepare(`
    INSERT INTO agent_workflow_tasks (
      workflow_id, task_type, status, shop_id, uid, creator_name, creator_handle,
      sample_id, score, recommendation, reason, payload_json, review_standard_version,
      score_details_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id, task_type, uid, sample_id) DO UPDATE SET
      status = CASE
        WHEN agent_workflow_tasks.status IN ('executed','admin_rejected','awaiting_reply') THEN agent_workflow_tasks.status
        ELSE excluded.status
      END,
      shop_id = excluded.shop_id,
      creator_name = excluded.creator_name,
      creator_handle = excluded.creator_handle,
      score = excluded.score,
      recommendation = excluded.recommendation,
      reason = excluded.reason,
      payload_json = excluded.payload_json,
      review_standard_version = excluded.review_standard_version,
      score_details_json = excluded.score_details_json,
      updated_at = excluded.updated_at
  `).run(
    workflowId,
    type,
    status,
    item.shop_id || '',
    item.uid || '',
    item.creator_name || '',
    item.creator_handle || '',
    taskKey,
    audit.score,
    audit.recommendation,
    audit.reason,
    JSON.stringify(payload),
    audit.review_standard_version || null,
    JSON.stringify(audit.score_details || audit.checks || []),
    nowText(),
    nowText()
  );
}

function generateWorkflowQueue(workflowId = null) {
  const workflow = getWorkflow(workflowId);
  const config = workflow.config;
  const candidateQuery = {
    source: config.source,
    shop: config.shop,
  };
  const candidates = listInviteCandidates(candidateQuery);
  const diagnostics = inviteCandidateDiagnostics(candidateQuery);
  const inviteSettings = getAgentSettings();
  // Keep the per-run target separate from the daily cap. A scheduled run may
  // happen more than once (or be triggered manually), so both limits must be
  // applied before creating new invite tasks.
  const runTarget = Math.max(1, Number(inviteSettings.invite_target_count || config.invite_target_count || 50));
  const dailyLimit = Math.max(1, Math.min(
    Number(inviteSettings.invite_daily_limit || runTarget),
    Number(config.invite_daily_limit || runTarget)
  ));
  const maxPerCreator = Math.max(1, Number(config.invite_max_per_creator || 1));
  const today = nowText().slice(0, 10);
  const todayCreated = db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_workflow_tasks
    WHERE workflow_id = ?
      AND task_type = 'invite'
      AND date(created_at) = ?
  `).get(workflow.id, today).c;
  const remainingToday = Math.max(0, dailyLimit - Number(todayCreated || 0));
  const inviteLimit = Math.min(runTarget, remainingToday);
  let remainingInviteSlots = inviteLimit;
  let inviteCount = 0;
  for (const candidate of candidates) {
    if (remainingInviteSlots <= 0) break;
    if (Number(candidate.invited_count || 0) >= maxPerCreator) continue;
    const audit = agentScoreCandidate(candidate, config);
    if (audit.recommendation !== 'auto_pass') continue;
    const profile = getProductAuditProfile(candidate.product_id || config.product_ids?.[0]);
    insertWorkflowTask(workflow.id, 'invite', 'admin_approved', candidate, audit, { candidate, config_snapshot: config, audit_profile: profile });
    inviteCount += 1;
    remainingInviteSlots -= 1;
  }

  const sampleRows = db.prepare(`
    SELECT
      s.*,
      p.name AS product_name,
      p.sku AS product_sku,
      COALESCE(l.star, 0) AS star,
      COALESCE(s.sales_count, 0) AS total_orders
    FROM samples s
    LEFT JOIN products p ON p.id = s.product_id
    LEFT JOIN creator_library l ON l.uid = s.uid
    WHERE s.library_added_at IS NULL
      AND s.status IN ('pending','approved')
      AND (s.bd_id IS NULL OR s.status = 'pending')
      ${config.shop && config.shop !== 'all' ? 'AND s.shop_id = ?' : ''}
    ORDER BY s.applied_at DESC
    LIMIT 200
  `).all(...(config.shop && config.shop !== 'all' ? [config.shop] : []));
  let sampleCount = 0;
  for (const sample of sampleRows) {
    const item = { ...sample, sample_id: sample.id };
    const conditionAudit = agentScoreSample(item, config);
    const messageAudit = {
      score: conditionAudit.score,
      recommendation: 'pending_reply',
      reason: '已收到样品申请，Agent 自动确认达人是否能拍摄并发布',
    };
    insertWorkflowTask(workflow.id, 'sample_message', 'admin_approved', item, messageAudit, {
      phase: 'creator_content_confirmation',
      sample: item,
      config_snapshot: config,
      condition_audit: conditionAudit,
      audit_profile: getProductAuditProfile(item.product_id),
      report: {
        basic_data: { uid: item.uid, name: item.creator_name, handle: item.creator_handle, fans: item.fans, category: item.category, avg_view: item.avg_view, monthly_videos: item.monthly_videos, orders_30d: item.total_orders, star: item.star },
        decision: conditionAudit.recommendation === 'auto_pass' ? '回复后建议通过' : '回复后建议人工复核',
        reason: conditionAudit.reason,
        checks: conditionAudit.checks || [],
        score: conditionAudit.score,
        rule_source: conditionAudit.rule_source || 'workflow_defaults',
      },
    });
    sampleCount += 1;
  }
  return {
    workflow,
    invite_count: inviteCount,
    invite_target: inviteLimit,
    invite_daily_limit: dailyLimit,
    invite_shortfall: Math.max(0, inviteLimit - inviteCount),
    sample_count: sampleCount,
    diagnostics,
  };
}

function workflowTasks(workflowId, limit = 120) {
  return db.prepare(`
    SELECT t.*, b.name AS assigned_bd_name,
      s.status AS sample_application_status,
      CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS has_sample_application
    FROM agent_workflow_tasks t
    LEFT JOIN bd_members b ON b.id = t.assigned_bd_id
    LEFT JOIN samples s ON CAST(s.id AS TEXT) = CAST(t.sample_id AS TEXT)
    WHERE t.workflow_id = ?
    ORDER BY
      CASE t.status WHEN 'agent_review' THEN 1 WHEN 'admin_approved' THEN 2 WHEN 'failed' THEN 3 WHEN 'executed' THEN 4 ELSE 5 END,
      t.updated_at DESC,
      t.id DESC
    LIMIT ?
  `).all(workflowId, limit).map((row) => ({ ...row, payload: parseJsonObject(row.payload_json, {}) }));
}

async function sendWorkflowInvitations(tasks, workflow) {
  const config = workflow.config;
  const templateId = Number(config.template_id || 0);
  const template = db.prepare('SELECT * FROM invitation_templates WHERE id = ? AND active = 1').get(templateId);
  if (!template) throw new Error('工作流未配置有效邀约模板');
  const productIds = (config.product_ids || []).map(Number).filter(Boolean);
  const productPlaceholders = productIds.map(() => '?').join(',');
  const products = productIds.length ? db.prepare(`SELECT * FROM products WHERE id IN (${productPlaceholders})`).all(...productIds) : [];
  if ((template.type || 'dm') === 'collab' && !products.length) throw new Error('合作邀约工作流必须配置商品');

  const insertRecord = db.prepare(`
    INSERT INTO invitation_records (
      shop_id, source, uid, creator_name, creator_handle, creator_open_id,
      template_id, template_type, product_id, product_ids, commission_rate, target_collaboration_id, send_mode, sample_approval_mode,
      sample_apply_link, channel, message, status, provider_message, created_at, sent_at, experiment_id, experiment_variant_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  for (const task of tasks) {
    const creator = task.payload?.candidate || task.payload || {};
    const assignment = experimentVariant(config.experiment_id, creator.uid || task.uid);
    const selectedTemplate = assignment?.variant?.template_id
      ? db.prepare('SELECT * FROM invitation_templates WHERE id = ? AND active = 1').get(assignment.variant.template_id)
      : template;
    if (!selectedTemplate) throw new Error('A/B 测试版本未配置有效邀约模板');
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(creator.shop_id || task.shop_id || config.shop) ||
      db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get();
    const nextId = nextInvitationRecordId();
    const applyLink = selectedTemplate.type === 'collab' ? sampleApplyLink(nextId) : null;
    const templateCommission = templateCommissionRate(selectedTemplate.id);
    const message = renderInvitationMessage(selectedTemplate, creator, shop, products, nextId, {
      commission_rate: templateCommission,
      omit_sample_apply_link: selectedTemplate.type === 'collab' && config.send_mode === 'auto',
    });
    let sendResult = { status: 'pending', provider_message: '工作流手动邀约模式：已生成记录，未自动发送 TikTok 私信' };
    let targetCollaborationId = null;
    if (config.send_mode === 'auto') {
      try {
        let cards = [];
        if (selectedTemplate.type === 'collab') {
          const target = await createTargetCollaboration({
            shop,
            creator,
            products,
            message,
            commissionRate: templateCommission,
            sampleApprovalMode: config.sample_approval_mode,
          });
          if (target.pending) {
            sendResult = { status: 'pending', provider_message: target.pending };
          } else {
            targetCollaborationId = target.targetCollaborationId;
            cards = [{ msg_type: 'TARGET_COLLABORATION_CARD', content: { target_collaboration_id: targetCollaborationId } }];
            sendResult = await sendTikTokInvitation({ shop, creator, message, cards });
          }
        } else {
          sendResult = await sendTikTokInvitation({ shop, creator, message, cards });
        }
      } catch (error) {
        sendResult = { status: 'failed', provider_message: error.message || 'TikTok 私信发送失败' };
      }
    }
    const now = nowText();
    const record = insertRecord.run(
      shop?.id || task.shop_id || config.shop || null,
      `workflow:${workflow.id}`,
      task.uid,
      task.creator_name,
      task.creator_handle,
      creator.creator_open_id || creator.uid || task.uid,
      selectedTemplate.id,
      selectedTemplate.type || 'dm',
      products[0]?.id || null,
      products.length ? JSON.stringify(products.map((item) => item.id)) : null,
      templateCommission,
      targetCollaborationId,
      config.send_mode,
      config.sample_approval_mode,
      applyLink,
      'im',
      message,
      sendResult.status,
      sendResult.provider_message,
      now,
      sendResult.status === 'sent' ? now : null,
      assignment?.experiment?.id || null,
      assignment?.variant?.id || null
    );
    const recordId = Number(record.lastInsertRowid);
    db.prepare(`
      UPDATE agent_workflow_tasks
      SET status = ?, invitation_record_id = ?, updated_at = ?, executed_at = ?
      WHERE id = ?
    `).run(sendResult.status === 'failed' ? 'failed' : 'executed', recordId, now, now, task.id);
    results.push({ task_id: task.id, record_id: recordId, status: sendResult.status });
  }
  return results;
}

function sampleConfirmationMessage(config, sample, template = null, shop = null, product = null) {
  if (template) return renderInvitationMessage(template, sample, shop, product);
  return String(config.auto_reply_template || '').trim() ||
    `您好，您申请的样品我们已收到。请确认收到样品后是否可以拍摄并发布 TikTok 视频；如果可以，请回复预计发布时间和内容形式。`;
}

function judgeSampleReply(replyText, sample, config) {
  const text = String(replyText || '').trim().toLowerCase();
  const negativeSignals = text.match(/不能|不可以|无法|不会|拒绝|取消|不拍|不发|できません|無理|投稿できない|撮影できない|can't|cannot|not able|no\b|sorry/gi) || [];
  const positiveSignals = text.match(/可以拍|可以发|可以發布|可以发布|愿意拍|愿意发|确认可以|確認できます|できます|可能です|ok\b|yes\b|sure\b|will\b|can\b|available\b|拍摄并发布|撮影して投稿/gi) || [];
  const conditionAudit = agentScoreSample(sample, config);
  if (!text) {
    return { score: 0, recommendation: 'manual_review', reason: '未录入达人回复', reply_signals: [] };
  }
  if (negativeSignals.length || (positiveSignals.length && negativeSignals.length)) {
    return { score: 0, recommendation: 'manual_review', reason: `回复包含拒绝或矛盾表述，需人工确认：${replyText}`, reply_signals: negativeSignals };
  }
  if (!positiveSignals.length) {
    return { score: 0, recommendation: 'manual_review', reason: `回复意向不明确，需人工跟进：${replyText}`, reply_signals: [] };
  }
  if (conditionAudit.recommendation !== 'auto_pass') {
    return { ...conditionAudit, recommendation: 'review_pass', reason: `达人已回复可拍摄，但条件未全满足，建议管理员复核：${conditionAudit.reason}`, reply_signals: positiveSignals };
  }
  return { score: 100, recommendation: 'auto_pass', reason: `达人回复可拍摄并发布，条件满足：${replyText}`, reply_signals: positiveSignals };
}

async function sendWorkflowSampleMessages(tasks, workflow) {
  const config = workflow.config;
  const insertRecord = db.prepare(`
    INSERT INTO invitation_records (
      shop_id, source, uid, creator_name, creator_handle, creator_open_id,
      template_id, template_type, product_id, product_ids, commission_rate, target_collaboration_id, send_mode, sample_approval_mode,
      sample_apply_link, channel, message, status, provider_message, created_at, sent_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  for (const task of tasks) {
    const sample = task.payload?.sample || task.payload || {};
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(sample.shop_id || task.shop_id || config.shop) ||
      db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get();
    const confirmationTemplate = config.confirmation_template_id
      ? db.prepare("SELECT * FROM invitation_templates WHERE id = ? AND active = 1 AND type = 'confirmation'").get(config.confirmation_template_id)
      : null;
    const product = sample.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(sample.product_id) : null;
    const message = sampleConfirmationMessage(config, sample, confirmationTemplate, shop, product);
    let sendResult;
    try {
      sendResult = await sendTikTokInvitation({ shop, creator: { ...sample, creator_open_id: sample.uid || task.uid }, message });
    } catch (error) {
      sendResult = { status: 'failed', provider_message: error.message || '确认消息发送失败' };
    }
    const now = nowText();
    const record = insertRecord.run(
      shop?.id || task.shop_id || config.shop || null,
      `workflow_sample:${workflow.id}`,
      task.uid,
      task.creator_name,
      task.creator_handle,
      sample.uid || task.uid,
      confirmationTemplate?.id || null,
      'confirmation',
      sample.product_id || null,
      sample.product_id ? JSON.stringify([sample.product_id]) : null,
      Number(sample.commission_rate || config.commission_rate || 0),
      null,
      'auto',
      config.sample_approval_mode,
      null,
      'im',
      message,
      sendResult.status,
      sendResult.provider_message,
      now,
      sendResult.status === 'sent' ? now : null
    );
    const nextStatus = sendResult.status === 'failed' ? 'failed' : 'awaiting_reply';
    db.prepare(`
      UPDATE agent_workflow_tasks
      SET status = ?, invitation_record_id = ?, reason = ?, updated_at = ?, executed_at = ?
      WHERE id = ?
    `).run(nextStatus, Number(record.lastInsertRowid), sendResult.status === 'failed' ? sendResult.provider_message : '确认消息已发送，等待达人回复', now, now, task.id);
    results.push({ task_id: task.id, record_id: Number(record.lastInsertRowid), status: sendResult.status });
  }
  return results;
}

const workflowRuns = new Map();

async function executeWorkflow(workflowId = null, options = {}) {
  const workflow = getWorkflow(workflowId);
  const runKey = String(workflow.id);
  if (workflowRuns.has(runKey)) return workflowRuns.get(runKey);
  const run = (async () => {
    const inviteTasks = options.invite === false ? [] : workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'invite' && task.status === 'admin_approved');
    const inviteResults = await sendWorkflowInvitations(inviteTasks, workflow);
    const inboxTasks = options.followup === false ? [] : workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'inbox_message' && task.status === 'admin_approved');
    const inbox_reply_results = await sendWorkflowInboxReplies(inboxTasks, workflow);
    const messageTasks = options.review === false ? [] : workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'sample_message' && task.status === 'admin_approved');
    const sample_message_results = await sendWorkflowSampleMessages(messageTasks, workflow);
    const sampleTasks = options.assign === false ? [] : workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'sample_audit' && task.status === 'admin_approved' && task.payload?.phase === 'final_sample_review');
    let assigned = 0;
    for (const [index, task] of sampleTasks.entries()) {
      if (!task.sample_id) continue;
      const bdId = bdIdForWorkflowTask(workflow.config, index);
      const updates = [];
      const params = [];
      updates.push("status = CASE WHEN status = 'pending' THEN 'approved' ELSE status END");
      if (bdId) { updates.push('bd_id = ?'); params.push(bdId); }
      params.push(task.sample_id);
      db.prepare(`UPDATE samples SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      markSampleLibraryReady(task.sample_id);
      if (bdId) {
        notifyBdAssigned(task.sample_id).catch((error) => console.error(`[wecom] workflow notification error for sample ${task.sample_id}:`, error.message));
      }
      db.prepare('UPDATE agent_workflow_tasks SET status = ?, assigned_bd_id = ?, updated_at = ?, executed_at = ? WHERE id = ?')
        .run('executed', bdId || null, nowText(), nowText(), task.id);
      assigned += 1;
    }
    return { invite_results: inviteResults, inbox_reply_results, sample_message_results, assigned_samples: assigned };
  })();
  workflowRuns.set(runKey, run);
  try { return await run; } finally { workflowRuns.delete(runKey); }
}

function workflowList() {
  return db.prepare(`
    SELECT
      w.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status = 'agent_review' THEN 1 ELSE 0 END) AS review_count,
      SUM(CASE WHEN t.status = 'admin_approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN t.status = 'executed' THEN 1 ELSE 0 END) AS executed_count,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM agent_workflows w
    LEFT JOIN agent_workflow_tasks t ON t.workflow_id = w.id
    WHERE w.active = 1
    GROUP BY w.id
    ORDER BY w.id DESC
  `).all().map((row) => ({ ...row, config: parseJsonObject(row.config_json, {}) }));
}

function sampleApplyLink(recordId) {
  return `${publicBaseUrl()}/tk/sample-apply?invite=${recordId}`;
}

function templateCommissionRate(templateId) {
  const row = db.prepare('SELECT commission_rate FROM agent_template_terms WHERE template_id = ?').get(Number(templateId || 0));
  return row && row.commission_rate !== null && row.commission_rate !== undefined ? Number(row.commission_rate) : 0;
}

function nextInvitationRecordId() {
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'invitation_records'").get()?.seq;
  if (seq !== undefined && seq !== null) return Number(seq) + 1;
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM invitation_records').get().id || 1);
}

function productLink(product, recordId) {
  return product?.product_url || sampleApplyLink(recordId);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function renderInvitationMessage(template, creator, shop, product = null, recordId = null, options = {}) {
  const applyLink = options.omit_sample_apply_link ? '' : (recordId ? sampleApplyLink(recordId) : '');
  const products = Array.isArray(product) ? product : (product ? [product] : []);
  const firstProduct = products[0] || null;
  const vars = {
    creator_name: creator.creator_name || creator.uid,
    creator_handle: creator.creator_handle || '',
    uid: creator.uid || '',
    shop_name: shop?.name || creator.shop_name || '店铺',
    product_name: products.map((item) => item.name).filter(Boolean).join(' / '),
    product_sku: products.map((item) => item.sku).filter(Boolean).join(' / '),
    product_link: firstProduct ? productLink(firstProduct, recordId) : '',
    sample_apply_link: applyLink,
    commission_rate: options.commission_rate ? percentText(options.commission_rate) : '',
    commission: options.commission_rate ? percentText(options.commission_rate) : '',
  };
  return String(template.content || '').replace(/\{\{([a-z_]+)\}\}/g, (_, key) => vars[key] ?? '');
}

function productCardsForInvitation(products = []) {
  return products
    .filter((product) => firstText(product.external_product_id))
    .map((product) => ({
      msg_type: 'PRODUCT_CARD',
      content: { product_id: firstText(product.external_product_id) },
    }));
}

function pickTargetCollaborationId(data) {
  return firstText(
    data?.target_collaboration_id,
    data?.target_collaboration?.id,
    data?.target_collaboration?.target_collaboration_id,
    data?.id
  );
}

function commissionRateToTikTok(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 100);
}

function targetCollaborationEndTime() {
  const days = Number(process.env.TK_TARGET_COLLABORATION_DAYS || 30);
  return String(Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000));
}

function sellerContactInfo() {
  return {
    email: process.env.TK_SELLER_CONTACT_EMAIL || 'bd@aojimiya123.top',
    phone_number: process.env.TK_SELLER_CONTACT_PHONE || '',
    whatsapp: process.env.TK_SELLER_CONTACT_WHATSAPP || '',
    telegram: process.env.TK_SELLER_CONTACT_TELEGRAM || '',
    line: process.env.TK_SELLER_CONTACT_LINE || '',
  };
}

async function createTargetCollaboration({ shop, creator, products, message, commissionRate, sampleApprovalMode }) {
  if (!shop?.access_token || !shop?.shop_cipher) {
    return { pending: '店铺未完成 TikTok 授权，已生成待发送记录' };
  }
  if (!creator.creator_open_id) {
    return { pending: '缺少 creator_open_id，已生成待后台私信发送记录' };
  }
  if (process.env.TK_INVITE_EXECUTE !== '1') {
    return { pending: 'TK_INVITE_EXECUTE 未开启，当前仅生成待发送记录' };
  }
  const tiktokProducts = (products || [])
    .filter((product) => firstText(product.external_product_id))
    .map((product) => ({
      id: firstText(product.external_product_id),
      target_commission_rate: commissionRateToTikTok(commissionRate),
      shop_ads_commission_rate: commissionRateToTikTok(commissionRate),
    }));
  if (!tiktokProducts.length) {
    return { pending: '所选商品缺少 TikTok product_id，无法创建合作卡片' };
  }

  const body = {
    name: `${shop.name || 'Shop'} 合作邀约 ${dateText(new Date())}`,
    message: message || '',
    end_time: targetCollaborationEndTime(),
    products: tiktokProducts,
    creator_user_open_ids: [creator.creator_open_id],
    seller_contact_info: sellerContactInfo(),
    free_sample_rule: {
      has_free_sample: true,
      is_sample_approval_exempt: sampleApprovalMode === 'auto',
    },
  };
  const data = await tiktokRequest({
    path: process.env.TK_TARGET_COLLABORATION_PATH || '/affiliate_seller/202508/target_collaborations',
    method: 'POST',
    query: { shop_cipher: shop.shop_cipher },
    body,
    accessToken: shop.access_token,
    shopId: shop.id,
  });
  const targetCollaborationId = pickTargetCollaborationId(data);
  if (!targetCollaborationId) {
    throw new Error(`TikTok Target Collaboration 创建成功但未返回 target_collaboration_id：${JSON.stringify(data).slice(0, 300)}`);
  }
  return { targetCollaborationId, response: data };
}

function pickConversationId(data) {
  return firstText(
    data?.conversation_id,
    data?.conversation?.conversation_id,
    data?.conversation?.id,
    data?.id,
    data?.conversation_list?.[0]?.conversation_id,
    data?.conversations?.[0]?.conversation_id
  );
}

function conversationMessagePath(pathTemplate, conversationId) {
  if (String(pathTemplate || '').includes('{conversation_id}')) {
    return String(pathTemplate).replace('{conversation_id}', encodeURIComponent(conversationId));
  }
  return pathTemplate;
}

async function createTikTokConversation({ shop, creator }) {
  const conversationPath = process.env.TK_IM_CONVERSATION_PATH || '/affiliate_seller/202508/conversations';
  if (!shop?.access_token || !shop?.shop_cipher) {
    return { pending: '店铺未完成 TikTok 授权，已生成待发送记录' };
  }
  if (!creator.creator_open_id) {
    return { pending: '缺少 creator_open_id，已生成待后台私信发送记录' };
  }
  if (process.env.TK_INVITE_EXECUTE !== '1') {
    return { pending: 'TK_INVITE_EXECUTE 未开启，当前仅生成待发送记录' };
  }

  const conversation = await tiktokRequest({
    path: conversationPath,
    method: 'POST',
    query: { shop_cipher: shop.shop_cipher },
    body: { creator_open_id: creator.creator_open_id },
    accessToken: shop.access_token,
    shopId: shop.id,
  });
  const conversationId = pickConversationId(conversation);
  if (!conversationId) {
    throw new Error(`TikTok 会话创建成功但未返回 conversation_id：${JSON.stringify(conversation).slice(0, 300)}`);
  }
  return { conversationId };
}

async function sendTikTokImMessage({ shop, conversationId, body }) {
  const messagePath = process.env.TK_IM_SEND_PATH || '/affiliate_seller/202412/conversations/{conversation_id}/messages';
  const messageRequest = {
    path: conversationMessagePath(messagePath, conversationId),
    method: 'POST',
    accessToken: shop.access_token,
    shopId: shop.id,
  };
  return tiktokRequest({ ...messageRequest, query: { shop_cipher: shop.shop_cipher }, body });
}

async function sendTikTokInvitation({ shop, creator, message, cards = [] }) {
  const conversation = await createTikTokConversation({ shop, creator });
  if (conversation.pending) {
    return { status: 'pending', provider_message: conversation.pending };
  }
  const conversationId = conversation.conversationId;

  const textBody = {
    msg_type: 'TEXT',
    content: JSON.stringify({ content: message }),
  };
  const textData = await sendTikTokImMessage({ shop, conversationId, body: textBody });
  const cardResults = [];
  for (const card of cards) {
    if (!card?.content) continue;
    const data = await sendTikTokImMessage({
      shop,
      conversationId,
      body: {
        msg_type: card.msg_type,
        content: JSON.stringify(card.content),
      },
    });
    cardResults.push({ msg_type: card.msg_type, response: data });
  }
  return {
    status: 'sent',
    provider_message: JSON.stringify({ conversation_id: conversationId, text: textData, cards: cardResults }).slice(0, 500),
  };
}

function inboxHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 48);
}

function apiList(data, keys = []) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return Array.isArray(data) ? data : [];
}

function messageText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return messageText(parsed);
    } catch (_) {
      return value;
    }
  }
  if (typeof value === 'object') return firstText(value.text, value.content, value.body, value.message, value.title, value.description);
  return String(value);
}

function normalizeInboxMessage(raw, conversation, shopId) {
  const sender = raw.sender || raw.from || raw.user || {};
  const direction = String(raw.direction || raw.sender_type || '').toLowerCase();
  const creatorOpenId = firstText(raw.creator_open_id, raw.creator_user_id, sender.creator_open_id, sender.open_id, conversation.creator_open_id, conversation.creator_user_id);
  const messageId = firstText(raw.message_id, raw.id, raw.msg_id);
  const receivedAt = firstText(raw.created_at, raw.create_time, raw.timestamp, raw.sent_at, nowText());
  const text = messageText(raw.text || raw.content || raw.body || raw.message || raw.payload);
  const isInbound = direction ? !/(seller|merchant|shop|outbound|sent)/i.test(direction) : !Boolean(raw.is_self || raw.from_seller);
  return {
    external_message_id: messageId || inboxHash(`${shopId}|${conversation.conversation_id || conversation.id}|${receivedAt}|${text}`),
    shop_id: shopId,
    conversation_id: firstText(raw.conversation_id, conversation.conversation_id, conversation.id),
    creator_open_id: creatorOpenId,
    uid: firstText(raw.uid, raw.creator_uid, creatorOpenId),
    creator_name: firstText(raw.creator_name, sender.creator_name, conversation.creator_name, conversation.name),
    direction: isInbound ? 'inbound' : 'outbound',
    message_type: firstText(raw.msg_type, raw.message_type, raw.type, 'text'),
    message_text: text,
    raw_json: JSON.stringify(raw),
    received_at: receivedAt,
  };
}

function classifyInboxMessage(text, sample = null) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return { classification: 'empty', recommendation: 'manual_review', score: 0, reason: '消息没有可识别文本' };
  if (/(不能|不可以|无法|拒绝|取消|不拍|不发|no|can't|cannot|not interested|できません|無理)/i.test(value)) {
    return { classification: 'negative', recommendation: 'manual_review', score: 0, reason: '达人表达拒绝或无法合作，需要人工处理' };
  }
  if (/(多少钱|怎么申请|如何申请|地址|佣金|合作|样品|sample|price|apply|commission|where|when|可以|愿意|确认|ok|yes|sure|can|available|できます)/i.test(value)) {
    const audit = sample ? agentScoreSample(sample, getWorkflow().config) : { recommendation: 'auto_pass', score: 80, reason: '消息包含合作意向或业务问题' };
    return {
      classification: /(多少钱|佣金|price|commission)/i.test(value) ? 'commercial_question' : 'positive_intent',
      recommendation: audit.recommendation === 'auto_pass' ? 'auto_reply_candidate' : 'manual_review',
      score: audit.score,
      reason: audit.reason,
    };
  }
  return { classification: 'other', recommendation: 'manual_review', score: 30, reason: '消息意图不明确，建议人工查看' };
}

function inboxReplyText(workflow, message) {
  const template = String(workflow?.config?.auto_reply_template || getAgentSettings().followup_template || '').trim();
  return template
    .replace(/\{\{creator_name\}\}/g, message.creator_name || message.uid || '您好')
    .replace(/\{\{reply_text\}\}/g, message.message_text || '');
}

async function processInboxMessage(row, workflow) {
  const sample = row.uid
    ? db.prepare(`SELECT s.*, COALESCE(l.star, 0) AS star, COALESCE(s.sales_count, 0) AS total_orders FROM samples s LEFT JOIN creator_library l ON l.uid = s.uid WHERE s.uid = ? ORDER BY s.applied_at DESC LIMIT 1`).get(row.uid)
    : null;
  const audit = classifyInboxMessage(row.message_text, sample);
  db.prepare('UPDATE agent_inbox_messages SET uid = COALESCE(NULLIF(?, \'\'), uid), classification = ?, processed_at = ? WHERE id = ?')
    .run(row.uid || '', audit.classification, nowText(), row.id);
  if (audit.recommendation === 'auto_reply_candidate') {
    insertWorkflowTask(workflow.id, 'inbox_message', String(process.env.TK_AGENT_AUTO_REPLY || '').toLowerCase() === 'true' ? 'admin_approved' : 'agent_review', { ...row, sample_id: row.external_message_id }, audit, { inbox_message: row, audit, sample, config_snapshot: workflow.config });
  } else {
    insertWorkflowTask(workflow.id, 'inbox_message', 'agent_review', { ...row, sample_id: row.external_message_id }, audit, { inbox_message: row, audit, sample, config_snapshot: workflow.config });
  }
  return audit;
}

async function syncInboxForShop(shop, workflow = getWorkflow()) {
  if (!shop?.access_token || !shop.shop_cipher) return { shop_id: shop?.id, status: 'skipped', message: '店铺未授权或缺少 shop_cipher', received: 0 };
  const conversationPath = process.env.TK_IM_CONVERSATION_PATH || '/affiliate_seller/202508/conversations';
  const messagePath = process.env.TK_IM_MESSAGES_PATH || '/affiliate_seller/202412/conversations/{conversation_id}/messages';
  const conversationsResponse = await tiktokRequest({ path: conversationPath, method: 'GET', accessToken: shop.access_token, shopId: shop.id, query: { shop_cipher: shop.shop_cipher, page_size: 100 }, body: {} });
  const conversations = apiList(conversationsResponse, ['conversations', 'conversation_list', 'items', 'data']);
  let received = 0;
  let processed = 0;
  for (const conversation of conversations) {
    const conversationId = firstText(conversation.conversation_id, conversation.id);
    if (!conversationId) continue;
    const response = await tiktokRequest({ path: conversationMessagePath(messagePath, conversationId), method: 'GET', accessToken: shop.access_token, shopId: shop.id, query: { shop_cipher: shop.shop_cipher, page_size: 100 }, body: {} });
    for (const raw of apiList(response, ['messages', 'message_list', 'items', 'data'])) {
      const item = normalizeInboxMessage(raw, { ...conversation, conversation_id: conversationId }, shop.id);
      if (item.direction !== 'inbound') continue;
      const result = db.prepare(`INSERT OR IGNORE INTO agent_inbox_messages (external_message_id, shop_id, conversation_id, creator_open_id, uid, creator_name, direction, message_type, message_text, raw_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.external_message_id, item.shop_id, item.conversation_id, item.creator_open_id, item.uid, item.creator_name, item.direction, item.message_type, item.message_text, item.raw_json, item.received_at);
      if (!Number(result.changes || 0)) continue;
      const inserted = db.prepare('SELECT * FROM agent_inbox_messages WHERE id = ?').get(Number(result.lastInsertRowid));
      received += 1;
      await processInboxMessage(inserted, workflow);
      processed += 1;
    }
  }
  return { shop_id: shop.id, status: 'success', conversations: conversations.length, received, processed };
}

async function ingestInboxEvent(payload, workflowId = null) {
  const event = payload?.data || payload?.event || payload || {};
  const shopId = firstText(event.shop_id, event.shop?.id, event.data?.shop_id);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId) || db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get();
  const workflow = getWorkflow(workflowId || null);
  const conversation = event.conversation || event;
  const rawMessages = apiList(event, ['messages', 'message_list', 'items'])
    .concat(event.message ? [event.message] : []);
  const results = [];
  for (const raw of rawMessages) {
    const item = normalizeInboxMessage(raw, conversation, shop.id);
    if (item.direction !== 'inbound') continue;
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO agent_inbox_messages
        (external_message_id, shop_id, conversation_id, creator_open_id, uid, creator_name, direction, message_type, message_text, raw_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.external_message_id, item.shop_id, item.conversation_id, item.creator_open_id, item.uid, item.creator_name, item.direction, item.message_type, item.message_text, item.raw_json, item.received_at);
    if (!Number(inserted.changes || 0)) continue;
    const row = db.prepare('SELECT * FROM agent_inbox_messages WHERE id = ?').get(Number(inserted.lastInsertRowid));
    const audit = await processInboxMessage(row, workflow);
    results.push({ id: row.id, external_message_id: row.external_message_id, classification: audit.classification, recommendation: audit.recommendation });
  }
  if (String(process.env.TK_AGENT_AUTO_REPLY || '').toLowerCase() === 'true' && results.length) {
    const tasks = workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'inbox_message' && task.status === 'admin_approved');
    const replies = await sendWorkflowInboxReplies(tasks, workflow);
    results.forEach((item) => { item.reply = replies.find((reply) => reply.message_id === item.id) || null; });
  }
  return { success: true, shop_id: shop.id, received: results.length, results };
}

async function sendWorkflowInboxReplies(tasks, workflow) {
  const results = [];
  for (const task of tasks) {
    const row = task.payload?.inbox_message || {};
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(row.shop_id || task.shop_id);
    const text = inboxReplyText(workflow, row);
    let sendResult;
    try {
      if (!row.conversation_id) throw new Error('消息缺少 conversation_id，无法回复');
      const response = await sendTikTokImMessage({
        shop,
        conversationId: row.conversation_id,
        body: { msg_type: 'TEXT', content: JSON.stringify({ content: text }) },
      });
      sendResult = { status: 'sent', provider_message: JSON.stringify(response).slice(0, 500) };
    } catch (error) {
      sendResult = { status: 'failed', provider_message: error.message || '自动回复发送失败' };
    }
    db.prepare('UPDATE agent_inbox_messages SET reply_status = ?, reply_text = ?, processed_at = ? WHERE id = ?')
      .run(sendResult.status, text, nowText(), row.id);
    db.prepare('UPDATE agent_workflow_tasks SET status = ?, reason = ?, updated_at = ?, executed_at = ? WHERE id = ?')
      .run(sendResult.status === 'sent' ? 'executed' : 'failed', sendResult.provider_message, nowText(), nowText(), task.id);
    recordLearningEvent({ workflowId: workflow.id, eventType: 'inbox_auto_reply', uid: row.uid, input: { message: row.message_text, reply: text }, outcome: sendResult.status, lesson: sendResult.provider_message });
    results.push({ task_id: task.id, message_id: row.id, status: sendResult.status, provider_message: sendResult.provider_message });
  }
  return results;
}
function importEnvAuthorizationToShop(shopId = 'oku') {
  const existing = db.prepare('SELECT access_token, shop_cipher FROM shops WHERE id = ?').get(shopId);
  if (existing?.access_token && existing?.shop_cipher) return false;
  const accessToken = process.env.TK_ACCESS_TOKEN || '';
  const refreshToken = process.env.TK_REFRESH_TOKEN || '';
  const shopCipher = process.env.TK_SHOP_CIPHER || process.env.TK_SHOP_ID || '';

  if (!accessToken || !shopCipher) return false;

  db.prepare(`
    UPDATE shops
    SET access_token = ?, refresh_token = ?, shop_cipher = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, shopCipher, shopId);

  return true;
}

importEnvAuthorizationToShop('oku');
ensureSyncSchema(db);

function notifySyncFailure(shopId, source, message) {
  const settings = getAgentSettings();
  const webhook = db.prepare("SELECT value FROM agent_settings WHERE key = 'notify_webhook'").get()?.value || '';
  if (!settings.notify_failure_enabled || !webhook || !/^https?:\/\//i.test(webhook)) return;
  void fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'sync_failed', shop_id: shopId, source, message, created_at: nowText() }) }).catch((error) => console.warn('[notify] webhook failed:', error.message));
}

function writeSyncLog(shopId, source, status, message) {
  db.prepare(`
    INSERT INTO sync_logs (shop_id, source, status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, source, status, message, nowText());
  if (status === 'failed') notifySyncFailure(shopId, source, message);
}

async function syncOneShop(shop, source) {
  const hasApiConfig = Boolean(shop.access_token && shop.shop_cipher);
  if (!hasApiConfig) {
    const status = 'skipped';
    const message = '未配置 TikTok API Token，已完成本地同步检查';
    db.prepare(`
      UPDATE shops
      SET last_sync_at = ?, last_sync_status = ?, last_sync_message = ?
      WHERE id = ?
    `).run(nowText(), status, message, shop.id);

    writeSyncLog(shop.id, source, status, message);
    return { shop_id: shop.id, shop_name: shop.name, status, message };
  }

  try {
    const detail = await syncTikTokShop(db, shop);
    const status = 'success';
    const sampleText = detail.samples?.status === 'success'
      ? `，样品申请 ${detail.samples.total} 条`
      : `，样品申请未同步（${detail.samples?.message || '未配置接口'}）`;
    const affiliateText = detail.affiliateOrders
      ? `，联盟订单 ${detail.affiliateOrders.total} 单/${detail.affiliateOrders.lines} 行`
      : '';
    const creatorText = detail.affiliateCreators?.status === 'success'
      ? `，联盟达人池 ${detail.affiliateCreators.total} 人，其中近30天销量 ${detail.affiliateCreators.with_sales_30d} 人`
      : (detail.affiliateCreators?.message ? `，联盟达人池未同步（${detail.affiliateCreators.message}）` : '');
    const message = `店铺数据同步完成：商品 ${detail.products.total} 条，订单 ${detail.orders.total} 条${affiliateText}${creatorText}${sampleText}`;

    db.prepare(`
      UPDATE shops
      SET last_sync_at = ?, last_sync_status = ?, last_sync_message = ?
      WHERE id = ?
    `).run(nowText(), status, message, shop.id);

    writeSyncLog(shop.id, source, status, message);
    return { shop_id: shop.id, shop_name: shop.name, status, message, detail };
  } catch (error) {
    const status = 'failed';
    const message = error.message || 'TikTok API 同步失败';

    db.prepare(`
      UPDATE shops
      SET last_sync_at = ?, last_sync_status = ?, last_sync_message = ?
      WHERE id = ?
    `).run(nowText(), status, message, shop.id);

    writeSyncLog(shop.id, source, status, message);
    return { shop_id: shop.id, shop_name: shop.name, status, message };
  }
}

async function syncAllShops(source = 'manual', shopId = 'all') {
  const requestedShop = String(shopId || 'all');
  const shops = db.prepare(`
    SELECT *
    FROM shops
    ${requestedShop !== 'all' ? 'WHERE id = ?' : ''}
    ORDER BY id
  `).all(...(requestedShop !== 'all' ? [requestedShop] : []));
  const results = [];
  for (const shop of shops) {
    results.push(await syncOneShop(shop, source));
  }
  notifyOverdueUnpublishedSamples();
  return {
    source,
    synced_at: nowText(),
    total: results.length,
    results,
  };
}

function msUntilNextSchedule() {
  const now = new Date();
  const next = new Date(now);
  const settings = getAgentSettings();
  next.setHours(settings.sample_sync_hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return { next, ms: next.getTime() - now.getTime() };
}

function scheduleShopSync() {
  const { next, ms } = msUntilNextSchedule();
  console.log(`[sync] next shop sync at ${next.toLocaleString()}`);
  syncTimer = setTimeout(async () => {
    try {
      const result = await syncSamplesForShops('schedule-samples', 'all', 0);
      console.log(`[sync] scheduled sample sync finished: ${result.total} shops`);
    } catch (error) {
      console.error('[sync] scheduled shop sync failed:', error);
      writeSyncLog(null, 'schedule', 'failed', error.message || '同步失败');
    } finally {
      scheduleShopSync();
    }
  }, ms);
}

let syncTimer = null;
let agentTimer = null;
const wecomNotificationDedupe = new Map();

function shouldSkipWecomNotification(key, windowMs = 60000) {
  const now = Date.now();
  for (const [itemKey, sentAt] of wecomNotificationDedupe.entries()) {
    if (now - sentAt > windowMs) wecomNotificationDedupe.delete(itemKey);
  }
  const lastSentAt = wecomNotificationDedupe.get(key);
  if (lastSentAt && now - lastSentAt < windowMs) return true;
  wecomNotificationDedupe.set(key, now);
  return false;
}

function startShopSyncScheduler() {
  if (syncTimer) return;
  scheduleShopSync();
}

function agentScheduleDelay() {
  const now = new Date();
  const next = new Date(now);
  const settings = getAgentSettings();
  next.setHours(settings.agent_daily_hour, settings.agent_daily_minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return { next, ms: next.getTime() - now.getTime() };
}

async function runScheduledAgent() {
  const workflow = getWorkflow();
  const config = workflow.config;
  // Auto-run is opt-in because it can send external TikTok messages.
  if (String(process.env.TK_AGENT_AUTORUN || '').toLowerCase() !== 'true') return;
  if (getAgentRuntime().paused) {
    recordAgentRun('auto_review', 'scheduled', 'paused', { result: '全部 Agent 已暂停' });
    return;
  }
  try {
    const activeFlows = new Set(getAgentFlowStates().filter((item) => item.active).map((item) => item.key));
    if (!activeFlows.size) return;
    await syncSamplesForShops('schedule-agent-samples', config.shop || 'all', 0);
    const inboxShops = db.prepare(`SELECT * FROM shops ${config.shop && config.shop !== 'all' ? 'WHERE id = ?' : ''} ORDER BY id`)
      .all(...(config.shop && config.shop !== 'all' ? [config.shop] : []));
    for (const shop of inboxShops) {
      try { await syncInboxForShop(shop, workflow); }
      catch (error) { writeSyncLog(shop.id, 'schedule-agent-inbox', 'failed', error.message || '收件箱同步失败'); }
    }
    const queued = activeFlows.has('auto_invite') || activeFlows.has('auto_review') || activeFlows.has('auto_assign')
      ? generateWorkflowQueue(workflow.id)
      : { invite_count: 0, sample_count: 0 };
    const executed = await executeWorkflow(workflow.id, {
      invite: activeFlows.has('auto_invite'),
      review: activeFlows.has('auto_review'),
      assign: activeFlows.has('auto_assign'),
      followup: activeFlows.has('bd_followup'),
    });
    if (activeFlows.has('auto_invite')) recordAgentRun('auto_invite', 'scheduled', 'success', { result: `生成邀约队列 ${queued.invite_count} 条`, invite_count: queued.invite_count });
    if (activeFlows.has('auto_review')) recordAgentRun('auto_review', 'scheduled', 'success', { result: `生成审核任务 ${queued.sample_count} 条`, sample_count: queued.sample_count });
    if (activeFlows.has('auto_assign')) recordAgentRun('auto_assign', 'scheduled', 'success', { result: `执行分配 ${executed.assigned_samples} 条`, assigned_samples: executed.assigned_samples });
    if (activeFlows.has('bd_followup')) recordAgentRun('bd_followup', 'scheduled', 'success', { result: '完成跟进巡检', inbox_replies: executed.inbox_reply_results.length });
    writeSyncLog(null, 'schedule-agent', 'success', `Agent巡检完成：邀约队列 ${queued.invite_count}，审核报告 ${queued.sample_count}，执行邀约 ${executed.invite_results.length}`);
  } catch (error) {
    writeSyncLog(null, 'schedule-agent', 'failed', error.message || 'Agent定时任务失败');
    console.error('[agent] scheduled run failed:', error);
  }
}

function startAgentScheduler() {
  if (agentTimer) return;
  const schedule = () => {
    const { next, ms } = agentScheduleDelay();
    console.log(`[agent] next workflow run at ${next.toLocaleString()}`);
    agentTimer = setTimeout(async () => {
      try { await runScheduledAgent(); } finally { agentTimer = null; schedule(); }
    }, ms);
  };
  schedule();
}

// ════════════════════════════════════════
//  店铺
// ════════════════════════════════════════
app.get('/api/shops', (req, res) => {
  const shops = db.prepare(`
    SELECT shops.id, shops.name, shops.color, shops.last_sync_at, shops.last_sync_status, shops.last_sync_message,
      (SELECT created_at FROM sync_logs
       WHERE sync_logs.shop_id = shops.id
         AND sync_logs.status = 'success'
         AND sync_logs.source IN ('samples-manual', 'schedule-samples', 'manual')
       ORDER BY sync_logs.id DESC LIMIT 1) AS last_success_sync_at
    FROM shops
  `).all();
  res.json(shops);
});

app.get('/api/sync/status', (req, res) => {
  const shops = db.prepare(`
    SELECT shops.id, shops.name, shops.color, shops.last_sync_at, shops.last_sync_status, shops.last_sync_message,
      (SELECT created_at FROM sync_logs
       WHERE sync_logs.shop_id = shops.id
         AND sync_logs.status = 'success'
         AND sync_logs.source IN ('samples-manual', 'schedule-samples', 'manual')
       ORDER BY sync_logs.id DESC LIMIT 1) AS last_success_sync_at
    FROM shops
    ORDER BY shops.id
  `).all();
  const logs = db.prepare(`
    SELECT id, shop_id, source, status, message, created_at
    FROM sync_logs
    ORDER BY id DESC
    LIMIT 20
  `).all();
  const { next } = msUntilNextSchedule();
  res.json({ shops, logs, next_sync_at: next.toISOString() });
});

app.get('/api/agent/settings', (req, res) => {
  res.json(getAgentSettings());
});

app.get('/api/agent/overview', (req, res) => {
  res.json(agentOverviewData());
});

app.put('/api/agent/runtime', (req, res) => {
  const paused = Boolean(req.body?.paused);
  db.prepare('UPDATE agent_runtime_state SET paused = ?, updated_at = ? WHERE id = 1').run(paused ? 1 : 0, nowText());
  res.json(agentOverviewData());
});

app.get('/api/agent/flows', (req, res) => {
  res.json({ flows: getAgentFlowStates() });
});

app.put('/api/agent/flows/:flowKey', (req, res) => {
  const flowKey = String(req.params.flowKey || '');
  if (!Object.prototype.hasOwnProperty.call(AGENT_FLOW_LABELS, flowKey)) return res.status(404).json({ error: 'Agent任务流不存在' });
  const active = req.body?.active !== false;
  db.prepare('UPDATE agent_flow_states SET active = ?, updated_at = ? WHERE flow_key = ?').run(active ? 1 : 0, nowText(), flowKey);
  res.json({ success: true, flow: getAgentFlowStates().find((item) => item.key === flowKey) });
});

app.get('/api/agent/run-logs', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 10)));
  const rows = db.prepare('SELECT * FROM agent_run_logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows.map((row) => ({ ...row, flow_label: AGENT_FLOW_LABELS[row.flow_key] || row.flow_key, summary: parseJsonObject(row.summary_json, {}) })));
});

app.post('/api/agent/flows/:flowKey/trial', (req, res) => {
  try {
    const flowKey = String(req.params.flowKey || '');
    if (!Object.prototype.hasOwnProperty.call(AGENT_FLOW_LABELS, flowKey)) return res.status(404).json({ error: 'Agent任务流不存在' });
    const workflow = getWorkflow();
    const config = workflow.config;
    let summary;
    if (flowKey === 'auto_invite') {
      const candidates = listInviteCandidates({ source: config.source, shop: config.shop, min_star: config.min_star, min_fans: config.min_fans, min_fulfillment: config.min_fulfillment, min_avg_view: config.min_avg_view, min_orders: config.min_orders, category: config.category });
      summary = { result: '试运行完成，未创建任务、未发送邀约', candidate_count: candidates.length };
    } else if (flowKey === 'auto_review') {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM samples WHERE status IN ('pending','approved') AND library_added_at IS NULL").get();
      summary = { result: '试运行完成，未修改样品状态', pending_samples: Number(pending?.c || 0) };
    } else if (flowKey === 'auto_assign') {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM agent_workflow_tasks WHERE task_type = 'sample_audit' AND status = 'admin_approved'").get();
      summary = { result: '试运行完成，未分配 BD', assignable_tasks: Number(pending?.c || 0) };
    } else {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM samples WHERE status IN ('shipped','approved','assigned')").get();
      summary = { result: '试运行完成，未发送跟进消息', followup_candidates: Number(pending?.c || 0) };
    }
    recordAgentRun(flowKey, 'trial', 'success', summary);
    res.json({ success: true, flow_key: flowKey, mode: 'trial', summary, overview: agentOverviewData() });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Agent试运行失败' });
  }
});

app.get('/api/agent/review-standards', (req, res) => {
  res.json({
    standard: getReviewStandard(),
    versions: db.prepare('SELECT version, created_at FROM review_standards ORDER BY version DESC LIMIT 50').all(),
  });
});

app.put('/api/agent/review-standards', (req, res) => {
  try {
    res.json({ success: true, standard: saveReviewStandard(req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message || '保存审核标准失败' });
  }
});

app.get('/api/agent/product-audit-profiles', (req, res) => {
  const productIds = String(req.query.product_ids || '')
    .split(',').map(Number).filter(Boolean);
  const rows = productIds.length
    ? productIds.map((id) => getProductAuditProfile(id)).filter(Boolean)
    : db.prepare('SELECT * FROM agent_product_audit_profiles ORDER BY product_id').all()
      .map((row) => ({ ...row, rules: normalizeAuditRules(parseJsonObject(row.rules_json, [])) }));
  res.json(rows);
});

app.put('/api/agent/product-audit-profiles/:productId', (req, res) => {
  try {
    res.json({ success: true, profile: saveProductAuditProfile(req.params.productId, req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message || '保存商品审核模板失败' });
  }
});

app.put('/api/agent/settings', (req, res) => {
  try {
    const settings = saveAgentSettings(req.body || {});
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (agentTimer) {
      clearTimeout(agentTimer);
      agentTimer = null;
    }
    startShopSyncScheduler();
    startAgentScheduler();
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message || '保存 Agent 配置失败' });
  }
});

app.post('/api/agent/settings/test-ai', (req, res) => {
  const settings = getAgentSettings();
  res.json({ success: Boolean(settings.ai_api_key), tested: true, message: settings.ai_api_key ? 'AI 接口配置已保存（本次仅校验配置，未调用外部 AI）' : '尚未配置 API Key，未发起请求' });
});

app.post('/api/agent/settings/test-notify', (req, res) => {
  const settings = getAgentSettings();
  res.json({ success: Boolean(settings.notify_webhook), tested: true, message: settings.notify_webhook ? '通知地址格式已保存（本次为模拟测试，未向外部发送）' : '尚未配置通知地址，未发起请求' });
});

app.get('/api/agent/workflow', (req, res) => {
  const workflow = getWorkflow(req.query.id ? Number(req.query.id) : null);
  const config = workflow.config || {};
  const diagnostics = inviteCandidateDiagnostics({
    source: config.source,
    shop: config.shop,
    min_star: config.min_star,
    min_fans: config.min_fans,
    min_fulfillment: config.min_fulfillment,
    min_avg_view: config.min_avg_view,
    min_orders: config.min_orders,
    category: config.category,
  });
  res.json({
    workflow,
    tasks: workflowTasks(workflow.id),
    diagnostics,
  });
});

app.get('/api/agent/sample-applications', (req, res) => {
  try {
    const shop = String(req.query.shop || 'all');
    const limit = Math.min(1000, Math.max(20, Number(req.query.limit || 500)));
    const rows = db.prepare(`
      SELECT s.*, p.name AS product_name, p.sku AS product_sku,
        p.emoji AS product_emoji, p.image_url AS product_image_url,
        sh.name AS shop_name
      FROM samples s
      LEFT JOIN products p ON p.id = s.product_id
      LEFT JOIN shops sh ON sh.id = s.shop_id
      WHERE s.status <> 'cancelled'
        AND (? = 'all' OR s.shop_id = ?)
        AND EXISTS (
          SELECT 1 FROM agent_workflow_tasks at
          WHERE CAST(at.sample_id AS TEXT) = CAST(s.id AS TEXT)
            AND at.task_type IN ('sample_message', 'sample_audit')
        )
      ORDER BY datetime(s.applied_at) DESC, s.id DESC
      LIMIT ?
    `).all(shop, shop, limit);
    const taskRows = db.prepare(`
      SELECT * FROM agent_workflow_tasks
      WHERE task_type IN ('sample_message', 'sample_audit')
      ORDER BY id DESC
    `).all();
    const bySample = new Map();
    for (const task of taskRows) {
      const key = String(task.sample_id || '');
      if (!key || bySample.has(key)) continue;
      bySample.set(key, { ...task, payload: parseJsonObject(task.payload_json, {}) });
    }
    res.json(rows.map((row) => {
      const task = bySample.get(String(row.id));
      const payload = task?.payload || {};
      const audit = payload.reply_audit || payload.condition_audit || {};
      const reply = payload.creator_reply || '';
      const canShoot = task?.task_type === 'sample_audit' && payload.phase === 'final_sample_review'
        ? (['auto_pass', 'review_pass'].includes(task.recommendation) ? '是' : '否')
        : (task?.status === 'awaiting_reply' ? '待回复' : (reply ? '否' : '待确认'));
      return {
        ...row,
        has_sample_application: true,
        score: Number(task?.score ?? audit.score ?? 0),
        can_shoot: canShoot,
        agent_analysis: task?.reason || audit.reason || '等待 Agent 处理',
        task_status: task?.status || 'pending',
        task_type: task?.task_type || 'sample_message',
        task_id: task?.id || null,
        review_standard_version: task?.review_standard_version || null,
        score_details: parseJsonObject(task?.score_details_json, audit.checks || []),
        report: payload.report || null,
        is_new: row.applied_at && Date.now() - new Date(String(row.applied_at).replace(' ', 'T')).getTime() <= 86400000,
      };
    }));
  } catch (error) {
    res.status(400).json({ error: error.message || '读取 Agent 样品申请失败' });
  }
});

app.get('/api/agent/workflows', (req, res) => {
  res.json({ workflows: workflowList() });
});

app.get('/api/agent/workflows/:id/preview', (req, res) => {
  try {
    const workflow = getWorkflow(Number(req.params.id || 0));
    const config = workflow.config;
    const template = db.prepare('SELECT id, name, type, content FROM invitation_templates WHERE id = ? AND active = 1').get(Number(config.template_id || 0));
    const candidateQuery = {
      source: config.source, shop: config.shop, min_star: config.min_star, min_fans: config.min_fans,
      min_fulfillment: config.min_fulfillment, min_avg_view: config.min_avg_view,
      min_orders: config.min_orders, category: config.category,
    };
    const candidates = listInviteCandidates(candidateQuery);
    const sampleArgs = config.shop && config.shop !== 'all' ? [config.shop] : [];
    const sampleRows = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
      FROM samples
      WHERE library_added_at IS NULL AND status IN ('pending','approved')
        AND (bd_id IS NULL OR status = 'pending')
        ${config.shop && config.shop !== 'all' ? 'AND shop_id = ?' : ''}
    `).get(...sampleArgs);
    const missing = [];
    if (!template) missing.push('未配置有效邀约模板');
    if (!config.shop || config.shop === 'all') missing.push('建议将工作流绑定到具体店铺');
    if (!config.bd_ids?.length) missing.push('未配置参与分配的 BD');
    if (config.source === 'shop_pool' && inviteCandidateDiagnostics(candidateQuery).pool.requires_sync) missing.push('联盟中心达人池或近30天销量尚未同步');
    res.json({
      workflow: { id: workflow.id, name: workflow.name, config },
      safe_mode: config.send_mode !== 'auto' && config.sample_approval_mode !== 'auto',
      template,
      stages: [
        { key: 'sync', name: '数据同步', action: '先执行店铺/联盟达人同步', ready: true },
        { key: 'invite_candidates', name: '筛选邀约达人', count: candidates.length, ready: candidates.length > 0 },
        { key: 'invite_review', name: '邀约任务确认', action: '生成队列后确认任务', ready: true },
        { key: 'invite_execute', name: '执行邀约', action: config.send_mode === 'auto' ? '将调用 TikTok API' : '仅生成待发送记录，不外发消息', ready: true },
        { key: 'sample_audit', name: '样品申请审核', count: Number(sampleRows?.total || 0), ready: true },
        { key: 'bd_assign', name: 'BD 分配', action: '审核通过后自动分配', ready: Boolean(config.bd_ids?.length) },
      ],
      blockers: missing,
      next: missing.length ? '补齐阻塞项后再生成队列' : '可以生成队列；当前配置可安全试跑',
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '读取工作流预检失败' });
  }
});

app.post('/api/agent/workflows', (req, res) => {
  try {
    const workflow = saveWorkflow(req.body || {}, true);
    res.json({ workflow, tasks: workflowTasks(workflow.id) });
  } catch (error) {
    res.status(400).json({ error: error.message || '新增工作流失败' });
  }
});

app.put('/api/agent/workflow', (req, res) => {
  try {
    res.json(saveWorkflow(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message || '保存工作流失败' });
  }
});

app.post('/api/agent/workflow/queue', (req, res) => {
  try {
    if (req.body && Object.keys(req.body).length) saveWorkflow(req.body);
    const result = generateWorkflowQueue();
    res.json({
      success: true,
      ...result,
      tasks: workflowTasks(result.workflow.id),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '生成工作流队列失败' });
  }
});

app.post('/api/agent/workflows/:id/queue', (req, res) => {
  try {
    const workflowId = Number(req.params.id || 0);
    if (req.body?.name || req.body?.config) saveWorkflow({ id: workflowId, ...(req.body || {}) });
    if (req.body?.reset) {
      db.prepare(`
        DELETE FROM agent_workflow_tasks
        WHERE workflow_id = ?
          AND status NOT IN ('executed')
      `).run(workflowId);
    }
    const result = generateWorkflowQueue(workflowId);
    res.json({
      success: true,
      ...result,
      tasks: workflowTasks(result.workflow.id),
      workflows: workflowList(),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '生成工作流队列失败' });
  }
});

app.post('/api/agent/workflow/tasks/:id/confirm', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const decision = String(req.body?.decision || 'approve');
    const task = db.prepare('SELECT id FROM agent_workflow_tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: '工作流任务不存在' });
    const taskRow = db.prepare('SELECT * FROM agent_workflow_tasks WHERE id = ?').get(id);
    const taskPayload = parseJsonObject(taskRow?.payload_json, {});
    const isSampleApplicationGate = taskRow?.task_type === 'sample_audit' && taskPayload.phase === 'sample_application_review';
    const status = decision === 'reject' ? 'admin_rejected' : (isSampleApplicationGate ? 'application_confirmed' : 'admin_approved');
    db.prepare('UPDATE agent_workflow_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, nowText(), id);
    if (decision !== 'reject' && isSampleApplicationGate) {
      const sample = taskPayload.sample || {};
      const messageAudit = {
        score: taskRow.score || 0,
        recommendation: 'pending_reply',
        reason: '管理员确认样品申请，Agent 将确认达人是否能拍摄并发布',
      };
      insertWorkflowTask(
        taskRow.workflow_id,
        'sample_message',
        'admin_approved',
        { ...sample, sample_id: taskRow.sample_id },
        messageAudit,
        { phase: 'creator_content_confirmation', sample, config_snapshot: getWorkflow(taskRow.workflow_id).config, condition_audit: taskPayload.condition_audit }
      );
      await executeWorkflow(taskRow.workflow_id);
    }
    if (decision !== 'reject' && taskRow?.task_type === 'sample_audit' && taskPayload.phase === 'final_sample_review') {
      await executeWorkflow(taskRow.workflow_id);
    }
    recordLearningEvent({
      workflowId: taskRow?.workflow_id,
      eventType: 'admin_decision',
      sampleId: taskRow?.sample_id,
      outcome: decision,
      lesson: decision === 'approve' ? '人工确认通过，可作为后续相似达人审核的正向样本' : '人工拒绝，后续相似条件应提高风险提示',
    });
    const workflow = getWorkflow(taskRow?.workflow_id || null);
    res.json({ success: true, tasks: workflowTasks(workflow.id) });
  } catch (error) {
    res.status(400).json({ error: error.message || '确认工作流任务失败' });
  }
});

app.post('/api/agent/workflow/tasks/:id/reply', (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const replyText = String(req.body?.reply_text || '').trim();
    if (!replyText) return res.status(400).json({ error: '请填写达人回复内容' });
    const task = db.prepare('SELECT * FROM agent_workflow_tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: '工作流任务不存在' });
    if (task.task_type !== 'sample_message') return res.status(400).json({ error: '只有确认拍摄消息任务可以录入回复' });
    const workflow = getWorkflow(task.workflow_id);
    const payload = parseJsonObject(task.payload_json, {});
    const sample = payload.sample || payload || {};
    const audit = judgeSampleReply(replyText, sample, workflow.config);
    const nextPayload = {
      ...payload,
      creator_reply: replyText,
      creator_replied_at: nowText(),
      reply_audit: audit,
    };
    const messageStatus = ['auto_pass', 'review_pass'].includes(audit.recommendation) ? 'executed' : 'failed';
    db.prepare(`
      UPDATE agent_workflow_tasks
      SET status = ?, recommendation = ?, score = ?, reason = ?, payload_json = ?, updated_at = ?, executed_at = ?
      WHERE id = ?
    `).run(messageStatus, audit.recommendation, audit.score, audit.reason, JSON.stringify(nextPayload), nowText(), nowText(), id);
    if (['auto_pass', 'review_pass'].includes(audit.recommendation)) {
      insertWorkflowTask(workflow.id, 'sample_audit', 'agent_review', { ...sample, sample_id: task.sample_id }, audit, {
        phase: 'final_sample_review',
        sample,
        creator_reply: replyText,
        config_snapshot: workflow.config,
        report: {
          basic_data: {
            uid: sample.uid,
            name: sample.creator_name,
            handle: sample.creator_handle,
            fans: sample.fans,
            avg_view: sample.avg_view,
            monthly_videos: sample.monthly_videos ?? sample.videos,
            orders_30d: sample.total_orders ?? sample.sales_count,
            star: sample.star,
          },
          decision: audit.recommendation === 'auto_pass' ? '建议通过' : '建议人工复核',
          reason: audit.reason,
          checks: audit.checks || [],
          score: audit.score,
          rule_source: audit.rule_source || 'creator_score_table_v1',
          creator_reply: replyText,
        },
      });
    }
    recordLearningEvent({
      workflowId: task.workflow_id,
      eventType: 'creator_reply',
      uid: task.uid,
      sampleId: task.sample_id,
      input: { reply_text: replyText, audit },
      outcome: audit.recommendation,
      lesson: audit.reason,
    });
    res.json({ success: true, tasks: workflowTasks(workflow.id), audit });
  } catch (error) {
    res.status(400).json({ error: error.message || '录入达人回复失败' });
  }
});

app.post('/api/agent/workflow/execute', async (req, res) => {
  try {
    const result = await executeWorkflow();
    const workflow = getWorkflow();
    res.json({ success: true, ...result, tasks: workflowTasks(workflow.id) });
  } catch (error) {
    res.status(400).json({ error: error.message || '执行工作流失败' });
  }
});

app.post('/api/agent/workflows/:id/execute', async (req, res) => {
  try {
    const workflowId = Number(req.params.id || 0);
    const result = await executeWorkflow(workflowId);
    const workflow = getWorkflow(workflowId);
    res.json({ success: true, ...result, tasks: workflowTasks(workflow.id), workflows: workflowList() });
  } catch (error) {
    res.status(400).json({ error: error.message || '执行工作流失败' });
  }
});

app.get('/api/agent/learning', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const rows = db.prepare(`
    SELECT * FROM agent_learning_events
    ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((row) => ({ ...row, input: parseJsonObject(row.input_json, {}) })));
});

app.get('/api/agent/reports', (req, res) => {
  const workflowId = Number(req.query.workflow_id || getWorkflow().id);
  const rows = db.prepare(`
    SELECT id, workflow_id, task_type, status, uid, creator_name, creator_handle, sample_id,
      score, recommendation, reason, payload_json, review_standard_version, score_details_json,
      created_at, updated_at
    FROM agent_workflow_tasks
    WHERE workflow_id = ? AND task_type = 'sample_audit'
    ORDER BY updated_at DESC, id DESC LIMIT 200
  `).all(workflowId);
  res.json(rows.map((row) => ({
    ...row,
    payload: parseJsonObject(row.payload_json, {}),
    score_details: parseJsonObject(row.score_details_json, []),
  })));
});

app.get('/api/agent/inbox', (req, res) => {
  const shop = String(req.query.shop || 'all');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
  const rows = db.prepare(`
    SELECT * FROM agent_inbox_messages
    ${shop !== 'all' ? 'WHERE shop_id = ?' : ''}
    ORDER BY COALESCE(received_at, created_at) DESC, id DESC LIMIT ?
  `).all(...(shop !== 'all' ? [shop, limit] : [limit]));
  res.json(rows);
});

app.post('/api/agent/inbox/sync', async (req, res) => {
  try {
    const shopId = String(req.body?.shop || req.query.shop || 'all');
    const workflow = getWorkflow(Number(req.body?.workflow_id || req.query.workflow_id || 0));
    const shops = db.prepare(`SELECT * FROM shops ${shopId !== 'all' ? 'WHERE id = ?' : ''} ORDER BY id`)
      .all(...(shopId !== 'all' ? [shopId] : []));
    const results = [];
    for (const shop of shops) {
      try {
        results.push(await syncInboxForShop(shop, workflow));
      } catch (error) {
        results.push({ shop_id: shop.id, status: 'failed', message: error.message || '收件箱同步失败' });
      }
    }
    res.json({ success: results.every((item) => item.status !== 'failed'), workflow_id: workflow.id, results });
  } catch (error) {
    res.status(500).json({ error: error.message || '收件箱同步失败' });
  }
});

app.post('/api/agent/inbox/:id/reply', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM agent_inbox_messages WHERE id = ?').get(Number(req.params.id || 0));
    if (!row) return res.status(404).json({ error: '收件消息不存在' });
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(row.shop_id);
    const text = String(req.body?.reply_text || '').trim();
    if (!text) return res.status(400).json({ error: '请填写回复内容' });
    const response = await sendTikTokImMessage({ shop, conversationId: row.conversation_id, body: { msg_type: 'TEXT', content: JSON.stringify({ content: text }) } });
    db.prepare('UPDATE agent_inbox_messages SET reply_status = \'sent\', reply_text = ?, processed_at = ? WHERE id = ?').run(text, nowText(), row.id);
    recordLearningEvent({ workflowId: getWorkflow().id, eventType: 'inbox_manual_reply', uid: row.uid, input: { message: row.message_text, reply: text }, outcome: 'sent', lesson: '人工回复已发送，可作为后续话术学习样本' });
    res.json({ success: true, response });
  } catch (error) {
    res.status(400).json({ error: error.message || '回复达人消息失败' });
  }
});

app.post('/api/webhooks/tiktok/messages', async (req, res) => {
  try {
    const expected = String(process.env.TK_IM_WEBHOOK_SECRET || '').trim();
    const provided = String(req.headers['x-tiktok-webhook-secret'] || req.headers['x-webhook-secret'] || '').trim();
    if (expected && expected !== provided) return res.status(401).json({ error: 'Webhook 签名校验失败' });
    const result = await ingestInboxEvent(req.body || {}, Number(req.query.workflow_id || 0) || null);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'TikTok 消息 Webhook 处理失败' });
  }
});

app.get('/api/agent/optimization', (req, res) => {
  const workflowId = Number(req.query.workflow_id || getWorkflow().id);
  const report = buildOptimizationReport(workflowId);
  const suggestions = db.prepare(`
    SELECT * FROM agent_optimization_suggestions
    WHERE workflow_id = ? ORDER BY id DESC LIMIT 100
  `).all(workflowId).map((row) => ({ ...row, proposal: parseJsonObject(row.proposal_json, {}) }));
  const experiments = db.prepare('SELECT * FROM agent_experiments ORDER BY id DESC LIMIT 20').all().map((row) => ({ ...row, report: experimentReport(row.id) }));
  res.json({ ...report, suggestions, experiments });
});

app.get('/api/agent/optimization/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_optimization_suggestions WHERE id = ?').get(Number(req.params.id || 0));
  if (!row) return res.status(404).json({ error: '优化建议不存在' });
  res.json({ ...row, proposal: parseJsonObject(row.proposal_json, {}), before: parseJsonObject(row.before_json, {}), after: parseJsonObject(row.after_json, {}), operations: db.prepare('SELECT * FROM agent_suggestion_operations WHERE suggestion_id = ? ORDER BY id DESC').all(row.id) });
});

app.post('/api/agent/optimization/generate', (req, res) => {
  try {
    const workflowId = Number(req.body?.workflow_id || getWorkflow().id);
    const report = buildOptimizationReport(workflowId);
    const ids = saveOptimizationSuggestions(workflowId, report.suggestions);
    res.json({ success: true, ...report, created_ids: ids });
  } catch (error) {
    res.status(400).json({ error: error.message || '生成优化建议失败' });
  }
});

app.post('/api/agent/optimization/:id/decision', (req, res) => {
  const id = Number(req.params.id || 0);
  const decision = String(req.body?.decision || 'dismiss') === 'approve' ? 'approved' : 'dismissed';
  const suggestion = db.prepare('SELECT * FROM agent_optimization_suggestions WHERE id = ?').get(id);
  if (!suggestion) return res.status(404).json({ error: '优化建议不存在' });
  if (suggestion.status !== 'pending') return res.status(400).json({ error: '该优化建议已经处理过' });
  let application = { applied: false, reason: '建议已记录，等待人工实施' };
  const before = suggestion.workflow_id ? getWorkflow(suggestion.workflow_id)?.config || {} : {};
  if (decision === 'approved') application = applyOptimizationProposal(suggestion);
  const after = application.workflow?.config || before;
  db.prepare('UPDATE agent_optimization_suggestions SET status = ?, before_json = ?, after_json = ?, decision_at = ?, applied_at = CASE WHEN ? = \'approved\' THEN ? ELSE applied_at END WHERE id = ?')
    .run(decision, JSON.stringify(before), JSON.stringify(after), nowText(), decision, nowText(), id);
  db.prepare('INSERT INTO agent_suggestion_operations (suggestion_id, operation, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, decision === 'approved' ? 'enable' : 'reject', JSON.stringify(before), JSON.stringify(after), nowText());
  recordLearningEvent({
    workflowId: suggestion.workflow_id,
    eventType: 'optimization_decision',
    input: { suggestion_id: id, title: suggestion.title },
    outcome: application.applied ? 'applied' : decision,
    lesson: application.applied ? `优化建议已应用：${JSON.stringify(application.changes)}` : (decision === 'approved' ? application.reason : '优化建议被忽略，保留现有工作流'),
  });
  res.json({ success: true, id, status: decision, application });
});

app.post('/api/agent/optimization/:id/rollback', (req, res) => {
  const id = Number(req.params.id || 0);
  const suggestion = db.prepare('SELECT * FROM agent_optimization_suggestions WHERE id = ?').get(id);
  if (!suggestion) return res.status(404).json({ error: '优化建议不存在' });
  if (suggestion.status !== 'approved') return res.status(400).json({ error: '只有已启用的建议可以回退' });
  const before = parseJsonObject(suggestion.before_json, {});
  const workflow = getWorkflow(suggestion.workflow_id);
  if (!workflow || !Object.keys(before).length) return res.status(400).json({ error: '找不到启用前的版本快照' });
  const restored = saveWorkflow({ id: workflow.id, config: before });
  db.prepare('UPDATE agent_optimization_suggestions SET status = \'rolled_back\', decision_at = ? WHERE id = ?').run(nowText(), id);
  db.prepare('INSERT INTO agent_suggestion_operations (suggestion_id, operation, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'rollback', JSON.stringify(workflow.config || {}), JSON.stringify(restored.config || before), nowText());
  recordLearningEvent({ workflowId: workflow.id, eventType: 'optimization_rollback', input: { suggestion_id: id }, outcome: 'rolled_back', lesson: '优化建议已回退到启用前版本' });
  res.json({ success: true, status: 'rolled_back', workflow: restored });
});

app.get('/api/agent/experiments', (req, res) => {
  const rows = db.prepare('SELECT * FROM agent_experiments ORDER BY id DESC').all();
  res.json(rows.map((row) => ({ ...row, report: experimentReport(row.id) })));
});

app.post('/api/agent/experiments', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];
    if (!name || variants.length < 2) return res.status(400).json({ error: '实验需要名称和至少两个话术版本' });
    const minSamples = Math.max(5, Number(req.body?.min_samples || 30));
    const experiment = db.prepare('INSERT INTO agent_experiments (name, status, min_samples, updated_at) VALUES (?, \'draft\', ?, ?)')
      .run(name, minSamples, nowText());
    const experimentId = Number(experiment.lastInsertRowid);
    const insert = db.prepare('INSERT INTO agent_experiment_variants (experiment_id, name, template_id, weight) VALUES (?, ?, ?, ?)');
    variants.forEach((variant, index) => {
      const templateId = Number(variant.template_id || 0);
      if (!templateId) throw new Error(`第 ${index + 1} 个版本缺少模板`);
      insert.run(experimentId, String(variant.name || `版本 ${String.fromCharCode(65 + index)}`), templateId, Math.max(1, Number(variant.weight || 50)));
    });
    res.json({ success: true, ...experimentReport(experimentId) });
  } catch (error) {
    res.status(400).json({ error: error.message || '创建话术实验失败' });
  }
});

app.post('/api/agent/experiments/:id/status', (req, res) => {
  const id = Number(req.params.id || 0);
  const status = ['draft', 'running', 'paused', 'completed'].includes(String(req.body?.status)) ? String(req.body.status) : 'draft';
  const experiment = db.prepare('SELECT id FROM agent_experiments WHERE id = ?').get(id);
  if (!experiment) return res.status(404).json({ error: '话术实验不存在' });
  db.prepare('UPDATE agent_experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, nowText(), id);
  res.json({ success: true, ...experimentReport(id) });
});

app.get('/api/agent/experiments/:id/report', (req, res) => {
  const report = experimentReport(Number(req.params.id || 0));
  if (!report) return res.status(404).json({ error: '话术实验不存在' });
  res.json(report);
});

const TEMPLATE_SCENES = new Set(['first_invite', 'reinvite', 'sample_followup', 'inquiry', 'shipping_followup', 'publish_followup']);
const TEMPLATE_LANGUAGES = new Set(['zh', 'en', 'ja']);

function normalizeTemplateInput(body = {}) {
  const scene = TEMPLATE_SCENES.has(String(body.scene || 'first_invite')) ? String(body.scene || 'first_invite') : 'first_invite';
  const language = TEMPLATE_LANGUAGES.has(String(body.language || 'zh')) ? String(body.language || 'zh') : 'zh';
  const shopIds = Array.isArray(body.shop_ids) ? body.shop_ids.map(String).filter(Boolean) : [];
  const commissionRate = body.commission_rate === '' || body.commission_rate === undefined || body.commission_rate === null ? null : Number(body.commission_rate);
  return {
    name: String(body.name || '').trim(),
    content: String(body.content || '').trim(),
    channel: String(body.channel || 'im').trim() || 'im',
    type: ['dm', 'collab', 'confirmation'].includes(String(body.type || 'dm')) ? String(body.type || 'dm') : 'dm',
    scene,
    language,
    shopIds,
    productId: body.product_id ? Number(body.product_id) : null,
    commissionRate,
  };
}

function validateTemplateInput(input) {
  if (!input.name || !input.content) throw new Error('缺少模板名称或内容');
  if (input.language === 'zh' && !/[\u3400-\u9fff]/.test(input.content)) throw new Error('中文模板必须包含中文内容');
  if (input.commissionRate !== null && (!Number.isFinite(input.commissionRate) || input.commissionRate < 0 || input.commissionRate > 100)) throw new Error('佣金比例需填写 0-100 之间的数字');
}

function templateStats() {
  return db.prepare(`
    SELECT t.id,
      COUNT(r.id) AS sent_count,
      SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS delivered_count,
      COUNT(DISTINCT CASE WHEN r.status = 'sent' AND EXISTS (SELECT 1 FROM agent_inbox_messages m WHERE m.uid = r.uid AND m.direction = 'inbound' AND datetime(m.received_at) >= datetime(r.created_at)) THEN r.uid END) AS reply_count,
      COUNT(DISTINCT CASE WHEN s.status IN ('approved','assigned','shipped','published') THEN s.uid END) AS accepted_count
    FROM invitation_templates t
    LEFT JOIN invitation_records r ON r.template_id = t.id
    LEFT JOIN samples s ON s.uid = r.uid AND s.applied_at >= r.created_at
    GROUP BY t.id
  `).all().map((row) => {
    const sent = Number(row.sent_count || 0);
    const replies = Number(row.reply_count || 0);
    const accepted = Number(row.accepted_count || 0);
    return { ...row, sent_count: sent, delivered_count: Number(row.delivered_count || 0), reply_count: replies, accepted_count: accepted, reply_rate: sent ? replies / sent : 0, accept_rate: sent ? accepted / sent : 0 };
  });
}

app.get('/api/invitations/templates', (req, res) => {
  ensureInvitationTemplates();
  const stats = new Map(templateStats().map((row) => [Number(row.id), row]));
  const rows = db.prepare(`
    SELECT t.id, t.name, t.channel, t.type, t.scene, t.shop_ids, t.language, t.version, t.product_id, t.content, t.active, COALESCE(a.commission_rate, 0) AS commission_rate
    FROM invitation_templates
    t LEFT JOIN agent_template_terms a ON a.template_id = t.id
    WHERE active = 1
    ORDER BY type, id
  `).all();
  res.json(rows.map((row) => ({ ...row, shop_ids: parseJsonObject(row.shop_ids, []), stats: stats.get(Number(row.id)) || { sent_count: 0, delivered_count: 0, reply_count: 0, accepted_count: 0, reply_rate: 0, accept_rate: 0 } })));
});

app.post('/api/invitations/templates', (req, res) => {
  const input = normalizeTemplateInput(req.body || {});
  try { validateTemplateInput(input); } catch (error) { return res.status(400).json({ error: error.message }); }
  const now = nowText();
  const result = db.prepare(`
    INSERT INTO invitation_templates (name, channel, type, scene, shop_ids, language, version, product_id, content, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)
  `).run(input.name, input.channel, input.type, input.scene, JSON.stringify(input.shopIds), input.language, input.productId, input.content, now, now);
  const templateId = Number(result.lastInsertRowid);
  if (input.commissionRate !== null) db.prepare('INSERT OR REPLACE INTO agent_template_terms (template_id, commission_rate, updated_at) VALUES (?, ?, ?)').run(templateId, input.commissionRate, now);
  db.prepare('INSERT INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(templateId, input.name, input.scene, JSON.stringify(input.shopIds), input.language, input.type, input.productId, input.content, input.commissionRate, now);
  res.json({ id: templateId, ...input, version: 1, shop_ids: input.shopIds, commission_rate: input.commissionRate });
});

app.put('/api/invitations/templates/:id', (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: '模板 ID 不正确' });
  const input = normalizeTemplateInput(req.body || {});
  try { validateTemplateInput(input); } catch (error) { return res.status(400).json({ error: error.message }); }
  const current = db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: '模板不存在' });
  const nextVersion = Number(current.version || 1) + 1;
  const oldCommission = db.prepare('SELECT commission_rate FROM agent_template_terms WHERE template_id = ?').get(id)?.commission_rate ?? null;
  db.prepare('INSERT OR IGNORE INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, current.version || 1, current.name, current.scene || 'first_invite', current.shop_ids || '[]', current.language || 'zh', current.type || 'dm', current.product_id, current.content, oldCommission, current.updated_at || nowText());
  db.prepare(`
    UPDATE invitation_templates
    SET name = ?, channel = ?, type = ?, scene = ?, shop_ids = ?, language = ?, version = ?, product_id = ?, content = ?, updated_at = ?
    WHERE id = ?
  `).run(input.name, input.channel, input.type, input.scene, JSON.stringify(input.shopIds), input.language, nextVersion, input.productId, input.content, nowText(), id);
  db.prepare('INSERT OR REPLACE INTO agent_template_terms (template_id, commission_rate, updated_at) VALUES (?, ?, ?)').run(id, input.commissionRate ?? 0, nowText());
  db.prepare('INSERT INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, nextVersion, input.name, input.scene, JSON.stringify(input.shopIds), input.language, input.type, input.productId, input.content, input.commissionRate, nowText());
  res.json({ success: true, version: nextVersion });
});

app.get('/api/invitations/templates/:id/versions', (req, res) => {
  res.json(db.prepare('SELECT * FROM invitation_template_versions WHERE template_id = ? ORDER BY version DESC').all(Number(req.params.id || 0)).map((row) => ({ ...row, shop_ids: parseJsonObject(row.shop_ids, []) })));
});

app.post('/api/invitations/templates/:id/rollback', (req, res) => {
  const id = Number(req.params.id || 0);
  const version = Number(req.body?.version || 0);
  const current = db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(id);
  const source = db.prepare('SELECT * FROM invitation_template_versions WHERE template_id = ? AND version = ?').get(id, version);
  if (!current || !source) return res.status(404).json({ error: '模板版本不存在' });
  const nextVersion = Number(current.version || 1) + 1;
  const now = nowText();
  const commission = source.commission_rate === null || source.commission_rate === undefined ? null : Number(source.commission_rate);
  db.prepare('INSERT OR IGNORE INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, current.version || 1, current.name, current.scene || 'first_invite', current.shop_ids || '[]', current.language || 'zh', current.type || 'dm', current.product_id, current.content, db.prepare('SELECT commission_rate FROM agent_template_terms WHERE template_id = ?').get(id)?.commission_rate ?? null, current.updated_at || now);
  db.prepare('UPDATE invitation_templates SET name = ?, type = ?, scene = ?, shop_ids = ?, language = ?, version = ?, product_id = ?, content = ?, updated_at = ? WHERE id = ?').run(source.name, source.type, source.scene, source.shop_ids || '[]', source.language, nextVersion, source.product_id, source.content, now, id);
  db.prepare('INSERT OR REPLACE INTO agent_template_terms (template_id, commission_rate, updated_at) VALUES (?, ?, ?)').run(id, commission ?? 0, now);
  db.prepare('INSERT INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, nextVersion, source.name, source.scene, source.shop_ids || '[]', source.language, source.type, source.product_id, source.content, commission, now);
  res.json({ success: true, version: nextVersion });
});

app.post('/api/invitations/templates/:id/preview', (req, res) => {
  const row = db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(Number(req.params.id || 0));
  if (!row) return res.status(404).json({ error: '模板不存在' });
  const body = req.body || {};
  const message = renderInvitationMessage(row, { uid: body.uid || 'creator-demo', creator_name: body.creator_name || '达人示例', creator_handle: body.creator_handle || '@creator_demo' }, { name: body.shop_name || '店铺示例' }, { id: body.product_id, name: body.product_name || '商品示例', sku: body.product_sku || 'SKU-DEMO', product_url: body.product_link || '' }, null, { commission_rate: body.commission ?? 15 });
  res.json({ message });
});

app.delete('/api/invitations/templates/:id', (req, res) => {
  db.prepare('UPDATE invitation_templates SET active = 0, updated_at = ? WHERE id = ?').run(nowText(), req.params.id);
  res.json({ success: true });
});
app.post('/api/invitations/candidates', (req, res) => {
  try {
    const query = req.body || {};
    res.json({ candidates: listInviteCandidates(query), diagnostics: inviteCandidateDiagnostics(query) });
  } catch (error) {
    res.status(400).json({ error: error.message || '筛选邀约达人失败' });
  }
});

app.get('/api/invitations/records', (req, res) => {
  const shop = String(req.query.shop || 'all');
  const rows = db.prepare(`
    SELECT r.*, t.name AS template_name, t.type AS template_type_from_template, p.name AS product_name, s.name AS shop_name
    FROM invitation_records r
    LEFT JOIN invitation_templates t ON t.id = r.template_id
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN shops s ON s.id = r.shop_id
    ${shop !== 'all' ? 'WHERE r.shop_id = ?' : ''}
    ORDER BY r.id DESC
    LIMIT 80
  `).all(...(shop !== 'all' ? [shop] : []));
  res.json(rows);
});

app.post('/api/invitations/send', async (req, res) => {
  try {
    const templateId = Number(req.body?.template_id || 0);
    const source = String(req.body?.source || 'shop_pool');
    const channel = String(req.body?.channel || 'im');
    const creators = Array.isArray(req.body?.creators) ? req.body.creators : [];
    const requestProductIds = Array.isArray(req.body?.product_ids)
      ? req.body.product_ids.map(Number).filter(Boolean)
      : (req.body?.product_id ? [Number(req.body.product_id)].filter(Boolean) : []);
    const commissionRate = req.body?.commission_rate !== undefined && req.body.commission_rate !== ''
      ? Number(req.body.commission_rate)
      : null;
    const sendMode = String(req.body?.send_mode || 'auto') === 'manual' ? 'manual' : 'auto';
    const sampleApprovalMode = String(req.body?.sample_approval_mode || 'manual') === 'auto' ? 'auto' : 'manual';
    if (!templateId) return res.status(400).json({ error: '请选择邀约模板' });
    if (!creators.length) return res.status(400).json({ error: '请选择至少一位达人' });

    const template = db.prepare('SELECT * FROM invitation_templates WHERE id = ? AND active = 1').get(templateId);
    if (!template) return res.status(404).json({ error: '邀约模板不存在' });
    const templateType = template.type || 'dm';
    const productIds = requestProductIds.length ? requestProductIds : (template.product_id ? [Number(template.product_id)] : []);
    const productPlaceholders = productIds.map(() => '?').join(',');
    const products = productIds.length
      ? db.prepare(`SELECT * FROM products WHERE id IN (${productPlaceholders})`).all(...productIds)
      : [];
    if (templateType === 'collab' && !products.length) return res.status(400).json({ error: '合作邀约必须选择产品' });
    if (templateType === 'collab' && commissionRate !== null && (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100)) {
      return res.status(400).json({ error: '佣金比例需填写 0-100 之间的数字' });
    }

    const insertRecord = db.prepare(`
      INSERT INTO invitation_records (
        shop_id, source, uid, creator_name, creator_handle, creator_open_id,
        template_id, template_type, product_id, product_ids, commission_rate, target_collaboration_id, send_mode, sample_approval_mode,
        sample_apply_link, channel, message, status, provider_message, created_at, sent_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results = [];
    for (const raw of creators.slice(0, 100)) {
      const creator = {
        uid: firstText(raw.uid),
        creator_name: firstText(raw.creator_name, raw.name),
        creator_handle: firstText(raw.creator_handle, raw.handle),
        creator_open_id: firstText(raw.creator_open_id, raw.open_id, raw.uid),
        shop_id: firstText(raw.shop_id, req.body?.shop),
        shop_name: firstText(raw.shop_name),
      };
      if (!creator.uid) continue;
      const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(creator.shop_id) ||
        (creator.shop_id ? null : db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get());
      const nextId = nextInvitationRecordId();
      const applyLink = templateType === 'collab' ? sampleApplyLink(nextId) : null;
      const message = renderInvitationMessage(template, creator, shop, products, nextId, {
        commission_rate: commissionRate,
        omit_sample_apply_link: templateType === 'collab' && sendMode === 'auto',
      });
      let targetCollaborationId = null;
      let sendResult;
      if (sendMode === 'manual') {
        sendResult = { status: 'pending', provider_message: '手动邀约模式：已生成记录，未自动发送 TikTok 私信' };
      } else {
        try {
          let cards = [];
          let targetResponse = null;
          if (templateType === 'collab') {
            const target = await createTargetCollaboration({
              shop,
              creator,
              products,
              message,
              commissionRate,
              sampleApprovalMode,
            });
            if (target.pending) {
              sendResult = { status: 'pending', provider_message: target.pending };
            } else {
              targetCollaborationId = target.targetCollaborationId;
              targetResponse = target.response;
              cards = [{
                msg_type: 'TARGET_COLLABORATION_CARD',
                content: { target_collaboration_id: targetCollaborationId },
              }];
            }
          }
          if (sendResult?.status === 'pending') {
            // keep pending result from target collaboration creation.
          } else {
            sendResult = await sendTikTokInvitation({ shop, creator, message, cards });
            if (targetResponse) {
              sendResult.provider_message = JSON.stringify({
                target_collaboration_id: targetCollaborationId,
                target_response: targetResponse,
                im_response: JSON.parse(sendResult.provider_message || '{}'),
              }).slice(0, 500);
            }
          }
        } catch (error) {
          sendResult = { status: 'failed', provider_message: error.message || 'TikTok 私信发送失败' };
        }
      }
      if (templateType === 'collab' && sendResult.status === 'pending') {
        sendResult.provider_message = `${sendResult.provider_message || '已生成待发送记录'}；合作邀约样品申请链接已生成`;
      }
      const now = nowText();
      const record = insertRecord.run(
        shop?.id || creator.shop_id || null,
        source,
        creator.uid,
        creator.creator_name,
        creator.creator_handle,
        creator.creator_open_id,
        template.id,
        templateType,
        products[0]?.id || null,
        products.length ? JSON.stringify(products.map((item) => item.id)) : null,
        commissionRate,
        targetCollaborationId,
        sendMode,
        sampleApprovalMode,
        applyLink,
        channel,
        message,
        sendResult.status,
        sendResult.provider_message,
        now,
        sendResult.status === 'sent' ? now : null
      );
      results.push({
        id: Number(record.lastInsertRowid),
        uid: creator.uid,
        creator_name: creator.creator_name,
        status: sendResult.status,
        template_type: templateType,
        product_ids: products.map((item) => item.id),
        commission_rate: commissionRate,
        target_collaboration_id: targetCollaborationId,
        send_mode: sendMode,
        sample_approval_mode: sampleApprovalMode,
        sample_apply_link: applyLink,
        provider_message: sendResult.provider_message,
      });
    }

    res.json({
      success: true,
      total: results.length,
      sent: results.filter((item) => item.status === 'sent').length,
      pending: results.filter((item) => item.status === 'pending').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '创建邀约任务失败' });
  }
});

app.post('/api/invitations/records/:id/retry', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const record = db.prepare('SELECT * FROM invitation_records WHERE id = ?').get(id);
    if (!record) return res.status(404).json({ error: '邀约记录不存在' });
    if (record.status === 'sent') return res.json({ success: true, status: 'sent', provider_message: record.provider_message });

    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(record.shop_id);
    const creator = {
      uid: record.uid,
      creator_name: record.creator_name,
      creator_handle: record.creator_handle,
      creator_open_id: record.creator_open_id || record.uid,
      shop_id: record.shop_id,
    };

    let sendResult;
    try {
      sendResult = await sendTikTokInvitation({ shop, creator, message: record.message });
    } catch (error) {
      sendResult = { status: 'failed', provider_message: error.message || 'TikTok 私信发送失败' };
    }

    const now = nowText();
    db.prepare(`
      UPDATE invitation_records
      SET status = ?, provider_message = ?, sent_at = ?
      WHERE id = ?
    `).run(
      sendResult.status,
      sendResult.provider_message,
      sendResult.status === 'sent' ? now : record.sent_at,
      id
    );

    res.json({
      success: sendResult.status === 'sent',
      id,
      status: sendResult.status,
      provider_message: sendResult.provider_message,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '重试发送失败' });
  }
});

app.get('/api/tiktok/auth/status', (req, res) => {
  const shops = db.prepare(`
    SELECT id, name, color, access_token, refresh_token, shop_cipher, token_expires_at, last_sync_at, last_sync_status, last_sync_message
    FROM shops
    ORDER BY id
  `).all().map((shop) => ({
    app_key: getAppConfig(shop.id).appKey || '',
    service_id: getAppConfig(shop.id).serviceId || '',
    id: shop.id,
    name: shop.name,
    color: shop.color,
    authorized: Boolean(shop.access_token && shop.refresh_token && shop.shop_cipher),
    has_access_token: Boolean(shop.access_token),
    has_refresh_token: Boolean(shop.refresh_token),
    has_shop_cipher: Boolean(shop.shop_cipher),
    auto_refresh_enabled: Boolean(shop.refresh_token),
    token_expires_at: shop.token_expires_at || null,
    token_expiring: shop.token_expires_at ? new Date(shop.token_expires_at).getTime() - Date.now() < 7 * 86400000 : false,
    last_sync_at: shop.last_sync_at,
    last_sync_status: shop.last_sync_status,
    last_sync_message: shop.last_sync_message,
    auth_url: buildTikTokAuthorizeUrl(shop.id),
  }));

  res.json({
    app_key: process.env.TK_APP_KEY || '',
    redirect_uri: oauthCallbackUrl(),
    app_secret: getAppSecretStatus(),
    shops,
  });
});

app.get('/api/tiktok/oauth/url', (req, res) => {
  const shopId = String(req.query.shop || 'oku');
  const shop = db.prepare('SELECT id FROM shops WHERE id = ?').get(shopId);
  if (!shop) return res.status(404).json({ error: '店铺不存在' });
  res.json({ shop: shopId, url: buildTikTokAuthorizeUrl(shopId), redirect_uri: oauthCallbackUrl() });
});

app.post('/api/sync/shops', async (req, res) => {
  try {
    const result = await syncAllShops('manual', req.body?.shop || req.query.shop || 'all');
    res.json(result);
  } catch (error) {
    writeSyncLog(null, 'manual', 'failed', error.message || '同步失败');
    res.status(500).json({ error: error.message || '同步失败' });
  }
});

async function syncSamplesForShops(source = 'samples-manual', shopId = 'all', incrementalDays = 30) {
  const requestedShop = String(shopId || 'all');
  const shops = db.prepare(`SELECT * FROM shops ${requestedShop !== 'all' ? 'WHERE id = ?' : ''} ORDER BY id`)
    .all(...(requestedShop !== 'all' ? [requestedShop] : []));
  const results = [];
  for (const shop of shops) {
    if (!shop.access_token || !shop.shop_cipher) {
      results.push({ shop_id: shop.id, shop_name: shop.name, status: 'skipped', message: '店铺未授权或缺少 shop_cipher' });
      continue;
    }
    try {
      const samples = await syncSampleApplications(db, shop, { incrementalDays });
      const mode = samples.mode === 'full' ? '全量校准' : '快速增量';
      const message = `样品${mode}同步完成：扫描 ${samples.scanned_pages} 页/${samples.total} 条，新增 ${samples.created} 条，更新 ${samples.updated} 条`;
      db.prepare(`UPDATE shops SET last_sync_at = ?, last_sync_status = 'success', last_sync_message = ? WHERE id = ?`)
        .run(nowText(), message, shop.id);
      writeSyncLog(shop.id, source, 'success', message);
      results.push({ shop_id: shop.id, shop_name: shop.name, status: 'success', message, detail: { samples } });
    } catch (error) {
      const message = error.message || '样品同步失败';
      db.prepare(`UPDATE shops SET last_sync_at = ?, last_sync_status = 'failed', last_sync_message = ? WHERE id = ?`)
        .run(nowText(), message, shop.id);
      writeSyncLog(shop.id, source, 'failed', message);
      results.push({ shop_id: shop.id, shop_name: shop.name, status: 'failed', message });
    }
  }
  return { success: results.every(row => row.status === 'success'), total: results.length, results };
}

app.post('/api/sync/samples', async (req, res) => {
  try {
    const shop = req.body?.shop || req.query.shop || 'all';
    const days = Math.min(90, Math.max(1, Number(req.body?.days || req.query.days || 30)));
    res.json(await syncSamplesForShops('samples-manual', shop, days));
  } catch (error) {
    res.status(500).json({ error: error.message || '样品同步失败' });
  }
});

app.post('/api/sync/products', async (req, res) => {
  try {
    ensureSyncSchema(db);
    const requestedShop = String(req.body?.shop || req.query.shop || 'all');
    const shops = db.prepare(`
      SELECT *
      FROM shops
      ${requestedShop !== 'all' ? 'WHERE id = ?' : ''}
      ORDER BY id
    `).all(...(requestedShop !== 'all' ? [requestedShop] : []));
    const results = [];
    for (const shop of shops) {
      if (!shop.access_token || !shop.shop_cipher) {
        results.push({ shop_id: shop.id, status: 'skipped', message: '店铺未授权或缺少 shop_cipher' });
        continue;
      }
      const detail = await syncProducts(db, shop);
      const imageBackfill = await syncMissingProductImages(db, shop);
      const missing = db.prepare("SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND COALESCE(image_url, '') = ''").get(shop.id).c;
      const message = `商品同步完成：${detail.total} 条，补图 ${imageBackfill.updated} 条，缺图 ${missing} 条`;
      writeSyncLog(shop.id, 'products', 'success', message);
      results.push({ shop_id: shop.id, shop_name: shop.name, status: 'success', ...detail, image_backfill: imageBackfill, missing_images: missing, message });
    }
    res.json({ success: true, shops: results });
  } catch (error) {
    const message = error.message || '商品同步失败';
    writeSyncLog(null, 'products', 'failed', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/sync/affiliate-creators', async (req, res) => {
  try {
    ensureSyncSchema(db);
    const shopId = String(req.body?.shop || req.query.shop || 'all');
    const shops = db.prepare(`
      SELECT *
      FROM shops
      ${shopId !== 'all' ? 'WHERE id = ?' : ''}
      ORDER BY id
    `).all(...(shopId !== 'all' ? [shopId] : []));
    if (!shops.length) return res.status(404).json({ error: '店铺不存在' });

    const results = [];
    for (const shop of shops) {
      if (!shop.access_token || !shop.shop_cipher) {
        results.push({ shop_id: shop.id, shop_name: shop.name, status: 'skipped', message: '店铺未授权或缺少 shop_cipher' });
        continue;
      }
      const result = await syncAffiliateCreators(db, shop);
      const message = result.status === 'success'
        ? `联盟中心达人池同步完成：${result.total} 人，其中近30天销量 ${result.with_sales_30d} 人`
        : result.message;
      writeSyncLog(shop.id, 'affiliate-creators', result.status === 'success' ? 'success' : 'skipped', message);
      results.push({ shop_id: shop.id, shop_name: shop.name, ...result, message });
    }
    res.json({ success: true, shops: results });
  } catch (error) {
    const message = error.message || '联盟中心达人池同步失败';
    writeSyncLog(null, 'affiliate-creators', 'failed', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/sync/affiliate-orders', async (req, res) => {
  try {
    ensureSyncSchema(db);
    const shopId = String(req.body?.shop || req.query.shop || 'oku');
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
    if (!shop) return res.status(404).json({ error: '店铺不存在' });
    if (!shop.access_token || !shop.shop_cipher) return res.status(400).json({ error: '店铺未授权或缺少 shop_cipher' });

    const result = await syncAffiliateOrders(db, shop);
    const message = `联盟订单同步完成：${result.total} 单/${result.lines} 行`;
    writeSyncLog(shop.id, 'affiliate-orders', 'success', message);
    db.prepare(`
      UPDATE shops
      SET last_sync_at = ?, last_sync_status = 'success', last_sync_message = ?
      WHERE id = ?
    `).run(nowText(), message, shop.id);
    res.json({ shop_id: shop.id, shop_name: shop.name, ...result, message });
  } catch (error) {
    const shopId = String(req.body?.shop || req.query.shop || 'oku');
    const message = error.message || '联盟订单同步失败';
    writeSyncLog(shopId, 'affiliate-orders', 'failed', message);
    try {
      db.prepare(`
        UPDATE shops
        SET last_sync_at = ?, last_sync_status = 'failed', last_sync_message = ?
        WHERE id = ?
      `).run(nowText(), message, shopId);
    } catch (_) {}
    res.status(500).json({ error: error.message || '联盟订单同步失败' });
  }
});

// ════════════════════════════════════════
//  BD 成员
// ════════════════════════════════════════
app.get('/api/bd', async (req, res) => {
  res.json(await listBdMembers());
});

app.post('/api/bd', (req, res) => {
  const { name, email, wecom_userid } = req.body;
  if (!name) return res.status(400).json({ error: '缺少姓名' });
  const result = db.prepare('INSERT INTO bd_members (name, email, wecom_userid) VALUES (?, ?, ?)').run(name, email || null, wecom_userid || null);
  res.json({ id: Number(result.lastInsertRowid), name, email, wecom_userid });
});

app.patch('/api/bd/:id', (req, res) => {
  const { id } = req.params;
  const allowed = ['name', 'email', 'wecom_userid', 'active', 'max_load'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (key in req.body) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: '没有可更新的字段' });
  params.push(id);
  db.prepare(`UPDATE bd_members SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  商品
// ════════════════════════════════════════
function inviteApplyDetail(inviteId) {
  const invite = db.prepare(`
    SELECT
      r.*,
      t.name AS template_name,
      p.name AS product_name,
      p.sku AS product_sku,
      p.emoji AS product_emoji,
      s.name AS shop_name
    FROM invitation_records r
    LEFT JOIN invitation_templates t ON t.id = r.template_id
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ? AND r.template_type = 'collab'
  `).get(inviteId);
  if (!invite) return null;
  let productIds = [];
  try {
    productIds = JSON.parse(invite.product_ids || '[]').map(Number).filter(Boolean);
  } catch (_) {}
  if (!productIds.length && invite.product_id) productIds = [Number(invite.product_id)];
  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',');
    invite.products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...productIds);
  } else {
    invite.products = [];
  }
  return invite;
}

function renderSampleApplyPage(invite) {
  const products = invite.products?.length ? invite.products : [{ id: invite.product_id, name: invite.product_name || '样品', sku: invite.product_sku || '', emoji: invite.product_emoji || '' }];
  const productOptions = products.map((item) => `<option value="${item.id}">${escapeHtml(`${item.emoji || ''} ${item.name || '样品'}${item.sku ? ` · ${item.sku}` : ''}`.trim())}</option>`).join('');
  const commission = invite.commission_rate !== null && invite.commission_rate !== undefined && invite.commission_rate !== '' ? `<div class="meta">邀约佣金：${escapeHtml(percentText(invite.commission_rate))}</div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>样品申请</title><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#eef2f5;color:#172033}.wrap{max-width:560px;margin:0 auto;padding:28px 16px}.card{background:#fff;border:1px solid #dfe6ee;border-radius:10px;padding:20px;box-shadow:0 8px 30px rgba(15,23,42,.06)}h1{font-size:20px;margin:0 0 6px}.meta{font-size:13px;color:#697586;margin-bottom:16px}.product{border:1px solid #edf1f5;background:#f8fafc;border-radius:8px;padding:12px;margin-bottom:16px}label{display:block;font-size:12px;color:#536173;margin:12px 0 5px}input,textarea,select{width:100%;border:1px solid #d0d7df;border-radius:7px;padding:10px;font:inherit;background:#fff}textarea{min-height:88px;resize:vertical}button{width:100%;height:40px;border:0;border-radius:7px;background:#ef2f55;color:#fff;font-weight:700;margin-top:16px;cursor:pointer}</style></head><body><div class="wrap"><form class="card" method="post" action="/tk/sample-apply?invite=${invite.id}"><h1>${escapeHtml(invite.shop_name)} 样品合作申请</h1><div class="meta">达人：${escapeHtml(invite.creator_name || invite.uid)} ${escapeHtml(invite.creator_handle || '')}</div>${commission}<div class="product"><label>选择申请样品</label><select name="product_id" required>${productOptions}</select></div><label>收件人</label><input name="receiver" required value="${escapeHtml(invite.creator_name || '')}"><label>联系方式</label><input name="contact" required placeholder="手机号 / 邮箱 / Line"><label>收件地址</label><textarea name="address" required></textarea><label>备注</label><textarea name="note" placeholder="尺码、色号或其他样品需求"></textarea><button type="submit">提交样品申请</button></form></div></body></html>`;
}

function handleSampleApplyPage(req, res) {
  const inviteId = Number(req.query.invite || 0);
  const invite = inviteApplyDetail(inviteId);
  if (!invite) return res.status(404).send('邀约链接不存在或已失效');
  res.send(renderSampleApplyPage(invite));
}

function handleSampleApplySubmit(req, res) {
  const inviteId = Number(req.query.invite || 0);
  const invite = inviteApplyDetail(inviteId);
  if (!invite) return res.status(404).send('邀约链接不存在或已失效');
  const allowedProducts = new Set((invite.products || []).map((item) => Number(item.id)));
  const selectedProductId = Number(req.body.product_id || invite.product_id || 0);
  if (!allowedProducts.has(selectedProductId)) return res.status(400).send('选择的样品不在邀约范围内');
  const existing = db.prepare('SELECT id FROM samples WHERE uid = ? AND product_id = ? AND shop_id = ? AND status = ?')
    .get(invite.uid, selectedProductId, invite.shop_id, 'pending');
  if (!existing) {
    const sampleStatus = invite.sample_approval_mode === 'auto' ? 'approved' : 'pending';
    db.prepare(`
      INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, fans, category, collab_type, status, product_id, commission_rate, applied_at, note)
      VALUES (?, ?, ?, ?, ?, 0, '', 'targeted', ?, ?, ?, ?, ?)
    `).run(
      genId(),
      invite.uid,
      invite.shop_id,
      req.body.receiver || invite.creator_name || invite.uid,
      invite.creator_handle || '',
      sampleStatus,
      selectedProductId || null,
      invite.commission_rate || null,
      nowText(),
      `合作邀约ID: ${invite.id}\n样品审批: ${invite.sample_approval_mode === 'auto' ? '自动审批' : '手动审批'}\n联系方式: ${req.body.contact || ''}\n收件地址: ${req.body.address || ''}\n备注: ${req.body.note || ''}`
    );
  }
  res.send('<!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;background:#eef2f5;padding:40px;color:#172033}.card{max-width:480px;margin:auto;background:#fff;border:1px solid #dfe6ee;border-radius:10px;padding:24px;text-align:center}</style><div class="card"><h2>申请已提交</h2><p>我们会尽快审核并安排样品寄送。</p></div>');
}

app.get('/sample-apply', handleSampleApplyPage);
app.get('/tk/sample-apply', handleSampleApplyPage);
app.post('/sample-apply', handleSampleApplySubmit);
app.post('/tk/sample-apply', handleSampleApplySubmit);
app.get('/api/products', (req, res) => {
  const { shop } = req.query;
  let rows;
  if (shop) {
    rows = db.prepare('SELECT * FROM products WHERE shop_id = ?').all(shop);
  } else {
    rows = db.prepare('SELECT * FROM products').all();
  }
  res.json(rows);
});

app.get('/api/orders', (req, res) => {
  const { shop, status } = req.query;
  const where = [];
  const params = [];

  if (shop && shop !== 'all') {
    where.push('shop_id = ?');
    params.push(shop);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  const sql = `
    SELECT *
    FROM orders
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(updated_at, created_at, synced_at) DESC
    LIMIT 200
  `;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/data/bd-report', async (req, res) => {
  await listBdMembers();
  const shop = String(req.query.shop || 'all');
  const bdIds = new Set(String(req.query.bd || '').split(',').map(Number).filter(Number.isInteger).filter((id) => id > 0));
  const period = ['month', 'quarter', 'halfyear', 'year'].includes(req.query.period) ? req.query.period : 'month';
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthCount = { month: 1, quarter: 3, halfyear: 6, year: 12 }[period];
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - monthCount, 1));
  const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - monthCount, 1));
  const sqlDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
  const startText = sqlDate(start);
  const endText = sqlDate(end);

  const sampleWhere = [];
  const sampleArgs = [];
  if (shop !== 'all') { sampleWhere.push('s.shop_id = ?'); sampleArgs.push(shop); }
  const allSamples = db.prepare(`
    SELECT s.*, COALESCE(s.bd_id, l.bd_id) AS owner_bd_id, b.name AS bd_name
    FROM samples s
    LEFT JOIN creator_library l ON l.uid = s.uid
    LEFT JOIN bd_members b ON b.id = COALESCE(s.bd_id, l.bd_id)
    ${sampleWhere.length ? `WHERE ${sampleWhere.join(' AND ')}` : ''}
    ORDER BY datetime(s.applied_at), s.id
  `).all(...sampleArgs);
  const creatorKey = (sample) => {
    const handle = normalizeCreatorHandle(sample.creator_handle);
    return handle ? `handle:${handle}` : `uid:${String(sample.uid || '').trim()}`;
  };
  const uniqueCreatorCount = (samples) => new Set(samples.map(creatorKey).filter((key) => key !== 'uid:')).size;
  const firstSampleByCreator = new Map();
  allSamples.forEach((sample) => {
    const key = creatorKey(sample);
    const appliedAt = String(sample.applied_at || '');
    if (appliedAt && (!firstSampleByCreator.has(key) || appliedAt < firstSampleByCreator.get(key))) {
      firstSampleByCreator.set(key, appliedAt);
    }
  });
  const inRange = (value, from = startText, to = endText) => value && value >= from && value < to;
  const validOwner = (sample) => !bdIds.size || bdIds.has(Number(sample.owner_bd_id));
  const scopedSamples = allSamples.filter(validOwner);
  const periodSamples = scopedSamples.filter((sample) => inRange(sample.applied_at));
  // Only records that passed review and entered the cooperation library count
  // as sample cooperations. `assigned` means assigned but not yet approved.
  const acceptedStatuses = new Set(['approved', 'shipped', 'published']);
  const sqliteTime = (value) => value ? String(value).replace('T', ' ').slice(0, 19) : '';
  const isNew = (sample) => sqliteTime(firstSampleByCreator.get(creatorKey(sample))) === sqliteTime(sample.applied_at);
  const publishedAt = (sample) => sample.published_at || (sample.status === 'published' ? sample.synced_at || sample.library_added_at : null);

  const handleOwners = new Map();
  scopedSamples.forEach((sample) => {
    const handle = normalizeCreatorHandle(sample.creator_handle);
    if (handle && sample.owner_bd_id) handleOwners.set(handle, Number(sample.owner_bd_id));
  });
  const orderWhere = ['order_created_at >= ?', 'order_created_at < ?'];
  const orderArgs = [sqlDate(previousStart), endText];
  if (shop !== 'all') { orderWhere.push('shop_id = ?'); orderArgs.push(shop); }
  let rangeOrders = db.prepare(`SELECT * FROM affiliate_orders WHERE ${orderWhere.join(' AND ')}`).all(...orderArgs);
  if (bdIds.size) rangeOrders = rangeOrders.filter((order) => bdIds.has(handleOwners.get(normalizeCreatorHandle(order.creator_username))));
  const periodOrders = rangeOrders.filter((order) => inRange(order.order_created_at));

  const summarize = (samples, orders) => {
    const targeted = samples.filter((s) => Number(s.commission_rate) >= 0.15);
    const open = samples.filter((s) => s.commission_rate != null && Number(s.commission_rate) < 0.15);
    const received = samples.filter((s) => s.sample_received_at);
    const fulfilled = received.filter((s) => {
      const pub = publishedAt(s);
      if (!pub) return false;
      return new Date(pub).getTime() <= new Date(s.sample_received_at).getTime() + 7 * 86400000;
    });
    const targetedCreators = uniqueCreatorCount(targeted);
    const acceptedTargeted = uniqueCreatorCount(targeted.filter((s) => acceptedStatuses.has(s.status)));
    const receivedCreators = uniqueCreatorCount(received);
    const fulfilledCreators = uniqueCreatorCount(fulfilled);
    return {
      targetedInvites: targetedCreators,
      openInvites: uniqueCreatorCount(open),
      acceptedTargeted,
      sampleCooperations: samples.filter((s) => acceptedStatuses.has(s.status)).length,
      newCooperations: samples.filter((s) => acceptedStatuses.has(s.status) && isNew(s)).length,
      oldCooperations: samples.filter((s) => acceptedStatuses.has(s.status) && !isNew(s)).length,
      receivedCreators,
      fulfilledCreators,
      acceptanceRate: targetedCreators ? Math.round(acceptedTargeted / targetedCreators * 1000) / 10 : null,
      fulfillmentRate: receivedCreators ? Math.round(fulfilledCreators / receivedCreators * 1000) / 10 : null,
      videos: samples.filter((s) => s.status === 'published' && inRange(publishedAt(s))).length,
      conversions: new Set(orders.map((o) => o.external_order_id)).size,
    };
  };
  const metrics = summarize(periodSamples, periodOrders);
  metrics.totalCreators = uniqueCreatorCount(scopedSamples.filter((s) => s.applied_at < endText && s.owner_bd_id));
  metrics.acceptanceRate = metrics.targetedInvites ? Math.round(metrics.acceptedTargeted / metrics.targetedInvites * 1000) / 10 : null;
  metrics.fulfillmentRate = metrics.receivedCreators ? Math.round(metrics.fulfilledCreators / metrics.receivedCreators * 1000) / 10 : null;

  const bdMap = new Map(db.prepare(`SELECT id, name FROM bd_members WHERE active = 1 OR id IN (SELECT DISTINCT bd_id FROM samples WHERE bd_id IS NOT NULL) ORDER BY name`).all().map((b) => [Number(b.id), b.name]));
  const selectedBdIds = bdIds.size ? [...bdIds].filter((id) => bdMap.has(id)) : [...bdMap.keys()];
  const inviteRows = selectedBdIds.map((id) => {
    const rows = periodSamples.filter((s) => Number(s.owner_bd_id) === id);
    const sampleCooperations = scopedSamples.filter((s) => Number(s.owner_bd_id) === id && acceptedStatuses.has(s.status) && inRange(s.library_added_at)).length;
    return { bdId: id, name: bdMap.get(id) || `BD ${id}`, totalCreators: uniqueCreatorCount(scopedSamples.filter((s) => Number(s.owner_bd_id) === id)), targetedInvites: uniqueCreatorCount(rows.filter((s) => Number(s.commission_rate) >= 0.15)), openInvites: uniqueCreatorCount(rows.filter((s) => s.commission_rate != null && Number(s.commission_rate) < 0.15)), sampleCooperations };
  });
  const conversionRows = [];
  selectedBdIds.forEach((id) => {
    const rows = periodSamples.filter((s) => Number(s.owner_bd_id) === id);
    ['new', 'old'].forEach((type) => {
      const typed = rows.filter((s) => isNew(s) === (type === 'new'));
      const received = typed.filter((s) => s.sample_received_at);
      const fulfilled = received.filter((s) => publishedAt(s) && new Date(publishedAt(s)).getTime() <= new Date(s.sample_received_at).getTime() + 7 * 86400000);
      const handles = new Set(typed.map((s) => normalizeCreatorHandle(s.creator_handle)).filter(Boolean));
      const orders = periodOrders.filter((o) => handles.has(normalizeCreatorHandle(o.creator_username)));
      const receivedCreators = uniqueCreatorCount(received);
      const fulfilledCreators = uniqueCreatorCount(fulfilled);
      conversionRows.push({ bdId: id, name: bdMap.get(id) || `BD ${id}`, type, samples: typed.filter((s) => acceptedStatuses.has(s.status)).length, receivedCreators, fulfilledCreators, fulfillmentRate: receivedCreators ? Math.round(fulfilledCreators / receivedCreators * 1000) / 10 : null, videos: typed.filter((s) => s.status === 'published' && inRange(publishedAt(s))).length, conversions: new Set(orders.map((o) => o.external_order_id)).size });
    });
  });

  const trendBuckets = [];
  if (period === 'month') {
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const dailyEnd = tomorrow < end ? tomorrow : end;
    for (let from = new Date(start); from < dailyEnd; from = new Date(from.getTime() + 86400000)) {
      const to = new Date(Math.min(from.getTime() + 86400000, dailyEnd.getTime()));
      trendBuckets.push({ from, to, key: sqlDate(from).slice(0, 10), label: `${from.getUTCMonth() + 1}/${from.getUTCDate()}` });
    }
  } else {
    for (let i = 0; i < monthCount; i += 1) {
      const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1));
      trendBuckets.push({ from, to, key: sqlDate(from).slice(0, 7), label: `${from.getUTCMonth() + 1}月` });
    }
  }
  const trends = trendBuckets.map((bucket) => {
    const { from, to, key, label } = bucket;
    const fromText = sqlDate(from); const toText = sqlDate(to);
    const bucketSamples = scopedSamples.filter((s) => inRange(s.applied_at, fromText, toText));
    const bucketOrders = periodOrders.filter((o) => inRange(o.order_created_at, fromText, toText));
    return { key, label, from: fromText, to: toText, ...summarize(bucketSamples, bucketOrders) };
  });
  const previousSamples = scopedSamples.filter((s) => inRange(s.applied_at, sqlDate(previousStart), startText));
  const previousOrders = rangeOrders.filter((order) => inRange(order.order_created_at, sqlDate(previousStart), startText));
  const previous = summarize(previousSamples, previousOrders);
  const byBd = inviteRows.map((row) => {
    const detail = conversionRows.filter((item) => item.bdId === row.bdId);
    const received = detail.reduce((n, x) => n + x.receivedCreators, 0);
    const fulfilled = detail.reduce((n, x) => n + x.fulfilledCreators, 0);
    return { bdId: row.bdId, name: row.name, invites: row.targetedInvites + row.openInvites, samples: detail.reduce((n, x) => n + x.samples, 0), fulfillment: received ? Math.round(fulfilled / received * 1000) / 10 : 0, videos: detail.reduce((n, x) => n + x.videos, 0), conversions: detail.reduce((n, x) => n + x.conversions, 0) };
  });
  const trendSeries = selectedBdIds.map((id) => ({
    bdId: id,
    name: bdMap.get(id) || `BD ${id}`,
    values: trends.map((trend) => {
      const bucketSamples = scopedSamples.filter((s) => Number(s.owner_bd_id) === id && inRange(s.applied_at, trend.from, trend.to));
      const handles = new Set(bucketSamples.map((s) => normalizeCreatorHandle(s.creator_handle)).filter(Boolean));
      const bucketOrders = periodOrders.filter((o) => inRange(o.order_created_at, trend.from, trend.to) && handles.has(normalizeCreatorHandle(o.creator_username)));
      return { key: trend.key, label: trend.label, ...summarize(bucketSamples, bucketOrders) };
    }),
  }));
  res.json({ filters: { shop, bd: selectedBdIds.length === bdMap.size ? 'all' : selectedBdIds, period, start: startText, end: endText }, metrics, previous, bds: [...bdMap].map(([id, name]) => ({ id, name })), inviteRows, conversionRows, trends, trendSeries, byBd });
});

app.get('/api/data/overview', async (req, res) => {
  await listBdMembers();
  const { shop = 'all' } = req.query;
  const scoped = shop && shop !== 'all';
  const shopWhere = scoped ? 'WHERE shop_id = ?' : '';
  const shopAnd = scoped ? 'AND shop_id = ?' : '';
  const shopArgs = scoped ? [shop] : [];

  const sampleStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status IN ('approved','assigned','shipped','published') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN collab_type = '' OR collab_type IS NULL THEN 1 ELSE 0 END) AS unset_type
    FROM samples
    ${shopWhere}
  `).get(...shopArgs);

  const orderStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(total_amount), 0) AS amount,
      COUNT(DISTINCT buyer_name) AS buyers
    FROM orders
    ${shopWhere}
  `).get(...shopArgs);

  const bdRows = db.prepare(`
    SELECT
      b.id,
      b.name,
      COUNT(s.id) AS samples,
      COUNT(DISTINCT s.uid) AS creators,
      SUM(CASE WHEN s.status = 'published' THEN 1 ELSE 0 END) AS published
    FROM bd_members b
    LEFT JOIN samples s ON s.bd_id = b.id ${shopAnd}
    WHERE b.active = 1
    GROUP BY b.id, b.name
    ORDER BY creators DESC, samples DESC, b.id
  `).all(...shopArgs);

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM samples
    ${shopWhere}
    GROUP BY status
  `).all(...shopArgs);

  const collabRows = db.prepare(`
    SELECT COALESCE(NULLIF(collab_type, ''), 'unset') AS type, COUNT(*) AS count
    FROM samples
    ${shopWhere}
    GROUP BY COALESCE(NULLIF(collab_type, ''), 'unset')
  `).all(...shopArgs);

  const topCreators = db.prepare(`
    SELECT
      s.uid,
      s.creator_name,
      s.creator_handle,
      s.fans,
      COUNT(*) AS samples,
      SUM(CASE WHEN s.status = 'published' THEN 1 ELSE 0 END) AS published,
      COALESCE(MAX(l.star), 0) AS star
    FROM samples s
    LEFT JOIN creator_library l ON l.uid = s.uid
    WHERE 1 = 1 ${scoped ? 'AND s.shop_id = ?' : ''}
    GROUP BY s.uid, s.creator_name, s.creator_handle, s.fans
    ORDER BY published DESC, samples DESC, fans DESC
    LIMIT 8
  `).all(...shopArgs);

  const syncLogs = db.prepare(`
    SELECT l.id, l.shop_id, s.name AS shop_name, l.source, l.status, l.message, l.created_at
    FROM sync_logs l
    LEFT JOIN shops s ON s.id = l.shop_id
    ${scoped ? 'WHERE l.shop_id = ?' : ''}
    ORDER BY l.id DESC
    LIMIT 8
  `).all(...shopArgs);

  res.json({
    sampleStats,
    orderStats,
    bdRows,
    statusRows,
    collabRows,
    topCreators,
    syncLogs,
  });
});

// ════════════════════════════════════════
//  样品申请列表（核心接口）
// ════════════════════════════════════════
app.get('/api/samples', (req, res) => {
  const { shop, status, search, collab_type } = req.query;

  let sql = `
    SELECT
      s.*, 
      p.sku  AS product_sku,
      p.name AS product_name,
      p.emoji AS product_emoji,
      p.image_url AS product_image_url,
      b.name AS bd_name
    FROM samples s
    LEFT JOIN products p ON s.product_id = p.id
    LEFT JOIN bd_members b ON s.bd_id = b.id
    WHERE 1=1
      AND ${sampleCenterWhere('s')}
  `;
  const params = [];

  if (shop && shop !== 'all') {
    sql += ' AND s.shop_id = ?';
    params.push(shop);
  }
  if (status === 'pending') {
    sql += " AND (s.status = 'pending' OR (s.status = 'approved' AND s.bd_id IS NULL))";
  } else if (status) {
    sql += ' AND s.status = ?';
    params.push(status);
  } else {
    sql += " AND s.status <> 'cancelled'";
  }
  if (collab_type === 'unset') {
    sql += " AND (s.collab_type IS NULL OR s.collab_type = '')";
  } else if (collab_type) {
    sql += ' AND s.collab_type = ?';
    params.push(collab_type);
  }
  if (search) {
    sql += ' AND (s.creator_name LIKE ? OR s.creator_handle LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY s.applied_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// 统计数据（顶部卡片 + Tab计数）—— 按当前店铺筛选
app.get('/api/samples/stats', (req, res) => {
  const { shop } = req.query;
  const centerFilter = sampleCenterWhere('samples');
  const shopFilter = shop && shop !== 'all' ? `WHERE shop_id = ? AND ${centerFilter}` : `WHERE ${centerFilter}`;
  const args = shop && shop !== 'all' ? [shop] : [];

  const activeTotal = db.prepare(`SELECT COUNT(*) AS c FROM samples ${shopFilter} AND status <> 'cancelled'`).get(...args).c;
  const byStatus = {};
  for (const st of ['pending','approved','rejected','assigned','shipped','published','cancelled']) {
    if (st === 'pending') {
      const sql = shop && shop !== 'all'
        ? `SELECT COUNT(*) AS c FROM samples WHERE shop_id = ? AND ${centerFilter} AND (status = 'pending' OR (status = 'approved' AND bd_id IS NULL))`
        : `SELECT COUNT(*) AS c FROM samples WHERE ${centerFilter} AND (status = 'pending' OR (status = 'approved' AND bd_id IS NULL))`;
      byStatus[st] = db.prepare(sql).get(...args).c;
    } else {
      const sql = shop && shop !== 'all'
        ? `SELECT COUNT(*) AS c FROM samples WHERE shop_id = ? AND ${centerFilter} AND status = ?`
        : `SELECT COUNT(*) AS c FROM samples WHERE ${centerFilter} AND status = ?`;
      const a = shop && shop !== 'all' ? [...args, st] : [st];
      byStatus[st] = db.prepare(sql).get(...a).c;
    }
  }
  const assignedBD = db.prepare(
    shop && shop !== 'all'
      ? `SELECT COUNT(*) AS c FROM samples WHERE shop_id=? AND ${centerFilter} AND bd_id IS NOT NULL`
      : `SELECT COUNT(*) AS c FROM samples WHERE ${centerFilter} AND bd_id IS NOT NULL`
  ).get(...args).c;

  res.json({ total: activeTotal, byStatus, assignedBD });
});

// 新建样品申请（手动添加，或未来对接TikTok API写入）
app.post('/api/samples', (req, res) => {
  const id = genId();
  const s = req.body;
  const inheritedBdId = s.bd_id || findExistingLibraryBd(s.uid, s.creator_handle);
  db.prepare(`
    INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, fans, category, collab_type, status, bd_id, product_id, applied_at, videos, avg_view, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    s.uid,
    s.shop_id,
    s.creator_name,
    s.creator_handle || '',
    s.fans || 0,
    s.category || '',
    s.collab_type || '',
    s.status || 'pending',
    inheritedBdId || null,
    s.product_id || null,
    s.applied_at || new Date().toISOString().slice(0,16).replace('T',' '),
    s.videos || 0,
    s.avg_view || '',
    s.note || ''
  );
  res.json({ id });
});

// 更新样品申请的某个字段（状态/合作类型/分配BD/备注）
app.patch('/api/samples/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = ['status', 'collab_type', 'bd_id', 'note'];
  const updates = [];
  const params = [];
  const previous = db.prepare('SELECT status, bd_id FROM samples WHERE id = ?').get(id);
  if (!previous) return res.status(404).json({ error: '样品申请不存在' });

  if (previous.status === 'approved' && req.body.status === 'pending') {
    return res.status(400).json({ error: '已通过记录请使用“撤回审核”操作' });
  }

  const changesBd = 'bd_id' in req.body && Number(previous.bd_id || 0) !== Number(req.body.bd_id || 0);
  const isReassignment = changesBd && Boolean(previous.bd_id);
  if (isReassignment) {
    const user = await currentErpUser(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以修改已分配的 BD' });
  }

  for (const key of allowed) {
    if (key in req.body) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: '没有可更新的字段' });

  params.push(id);
  db.prepare(`UPDATE samples SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  markSampleLibraryReady(id);
  const current = db.prepare('SELECT status, bd_id FROM samples WHERE id = ?').get(id);

  // 如果是分配BD，模拟生成一条通知（实际项目可换成站内信/邮件/webhook）
  if ('bd_id' in req.body && req.body.bd_id && changesBd && !previous.bd_id) {
    const bd = db.prepare('SELECT name, wecom_userid FROM bd_members WHERE id = ?').get(req.body.bd_id);
    console.log(`📨 [通知] 已将样品 ${id} 分配给 BD: ${bd?.name}`);
    notifyBdAssigned(id).catch((error) => {
      console.error(`[wecom] unexpected notification error for sample ${id}:`, error.message);
    });
  } else if (
    'status' in req.body &&
    current?.bd_id &&
    ['approved', 'published'].includes(String(current.status || '')) &&
    String(current.status || '') !== String(previous?.status || '')
  ) {
    console.log(`📨 [通知] 样品 ${id} 状态变为 ${current.status}，通知负责 BD`);
    notifyBdAssigned(id, current.status === 'published' ? '新的视频已发布' : '新的样品分配通知').catch((error) => {
      console.error(`[wecom] unexpected status notification error for sample ${id}:`, error.message);
    });
  }
  notifyOverdueUnpublishedSamples(id);

  res.json({ success: true });
});

// 撤回已通过的审核：仅管理员且记录尚未进入分配、物流或发布流程时允许。
app.post('/api/samples/:id/withdraw-approval', async (req, res) => {
  const user = await currentErpUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以撤回审核' });

  const sample = db.prepare(`
    SELECT id, status, bd_id, sample_received_at, published_at
    FROM samples
    WHERE id = ?
  `).get(req.params.id);
  if (!sample) return res.status(404).json({ error: '样品申请不存在' });
  if (sample.status !== 'approved') {
    return res.status(409).json({ error: '只能撤回状态为“已通过”的记录' });
  }
  if (sample.bd_id) {
    return res.status(409).json({ error: '该记录已分配 BD，不能撤回审核' });
  }
  if (sample.sample_received_at) {
    return res.status(409).json({ error: '该记录已进入物流或签收流程，不能撤回审核' });
  }
  if (sample.published_at) {
    return res.status(409).json({ error: '该记录已发布，不能撤回审核' });
  }

  const result = db.prepare(`
    UPDATE samples
    SET status = 'pending', library_added_at = NULL
    WHERE id = ?
      AND status = 'approved'
      AND bd_id IS NULL
      AND sample_received_at IS NULL
      AND published_at IS NULL
  `).run(req.params.id);
  if (result.changes !== 1) {
    return res.status(409).json({ error: '记录状态已变更，请刷新后重试' });
  }

  res.json({ success: true });
});

app.delete('/api/samples/:id', (req, res) => {
  db.prepare('DELETE FROM samples WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  合作达人库（按 UID 聚合）
// ════════════════════════════════════════
function libraryCountForShop(shop = 'all') {
  const activeStatuses = ['approved', 'shipped', 'published'];
  const where = [
    `status IN (${activeStatuses.map(() => '?').join(',')})`,
    'library_added_at IS NOT NULL',
  ];
  const params = [...activeStatuses];
  if (shop && shop !== 'all') {
    where.push('shop_id = ?');
    params.push(shop);
  }
  return db.prepare(`
    SELECT COUNT(DISTINCT
      CASE
        WHEN COALESCE(creator_handle, '') <> '' THEN 'handle:' || lower(replace(creator_handle, '@', ''))
        ELSE 'uid:' || uid
      END
    ) AS c
    FROM samples
    WHERE ${where.join(' AND ')}
  `).get(...params).c;
}

app.get('/api/library/stats', (req, res) => {
  refreshCreatorLibraryMarkers();
  const shops = db.prepare('SELECT id, name FROM shops ORDER BY id').all();
  const byShop = {};
  shops.forEach((shop) => {
    byShop[shop.id] = libraryCountForShop(shop.id);
  });
  res.json({
    total: libraryCountForShop('all'),
    byShop,
  });
});

app.get('/api/library', async (req, res) => {
  await listBdMembers();
  refreshCreatorLibraryMarkers();
  const { shop, search, star, bd, sort } = req.query;
  const orderRange = affiliateOrderRangeFilter(req.query);

  const activeStatuses = ['approved', 'shipped', 'published'];
  let sql = `
    SELECT
      s.*, 
      p.sku AS product_sku, p.name AS product_name, p.emoji AS product_emoji, p.image_url AS product_image_url,
      b.name AS bd_name
    FROM samples s
    LEFT JOIN products p ON s.product_id = p.id
    LEFT JOIN bd_members b ON s.bd_id = b.id
    WHERE s.status IN (${activeStatuses.map(()=>'?').join(',')})
      AND s.library_added_at IS NOT NULL
  `;
  const params = [...activeStatuses];

  if (shop && shop !== 'all') {
    sql += ' AND s.shop_id = ?';
    params.push(shop);
  }
  sql += ' ORDER BY s.applied_at DESC';
  const rows = db.prepare(sql).all(...params);

  // 优先用 TikTok handle 合并跨店铺达人；没有 handle 时退回 uid。
  const map = {};
  for (const r of rows) {
    const handleKey = normalizeCreatorHandle(r.creator_handle);
    const key = handleKey ? `handle:${handleKey}` : `uid:${r.uid}`;
    if (!map[key]) {
      map[key] = {
        uid: r.uid,
        uids: new Set(),
        name: r.creator_name,
        handle: r.creator_handle,
        fans: r.fans,
        category: r.category,
        shops: new Set(),
        samples: [],
        firstCoopAt: r.library_added_at || r.applied_at || '',
        latestCoopAt: r.library_added_at || r.applied_at || ''
      };
    }
    map[key].uids.add(r.uid);
    map[key].shops.add(r.shop_id);
    map[key].samples.push(r);
    if (Number(r.fans || 0) > Number(map[key].fans || 0)) map[key].fans = r.fans;
    const addedAt = r.library_added_at || r.applied_at || '';
    if (addedAt && (!map[key].firstCoopAt || addedAt < map[key].firstCoopAt)) map[key].firstCoopAt = addedAt;
    if (addedAt && (!map[key].latestCoopAt || addedAt > map[key].latestCoopAt)) map[key].latestCoopAt = addedAt;
  }

  let creators = Object.values(map).map(c => ({
    ...c,
    shops: [...c.shops],
    uids: [...c.uids],
    samples: c.samples.sort((a, b) => String(b.library_added_at || b.applied_at || '').localeCompare(String(a.library_added_at || a.applied_at || ''))),
  }));

  // 补充 library 表里的星级/备注
  const libRows = db.prepare('SELECT * FROM creator_library').all();
  const libMap = {};
  for (const l of libRows) libMap[l.uid] = l;

  const historicalBdByUid = new Map();
  const historicalBdByHandle = new Map();
  db.prepare(`
    SELECT uid, creator_handle, bd_id
    FROM samples
    WHERE bd_id IS NOT NULL
    ORDER BY datetime(applied_at) DESC, id DESC
  `).all().forEach((sample) => {
    const uid = String(sample.uid || '').trim();
    const handle = normalizeCreatorHandle(sample.creator_handle);
    if (uid && !historicalBdByUid.has(uid)) historicalBdByUid.set(uid, sample.bd_id);
    if (handle && !historicalBdByHandle.has(handle)) historicalBdByHandle.set(handle, sample.bd_id);
  });

  creators = creators.map(c => {
    const latestSample = c.samples[0] || null;
    const libraryBdId = c.uids.map(uid => libMap[uid]?.bd_id).find(Boolean) || null;
    const historicalBdId = c.uids.map(uid => historicalBdByUid.get(uid)).find(Boolean)
      || historicalBdByHandle.get(normalizeCreatorHandle(c.handle))
      || null;
    return {
      ...c,
      star: c.uids.map(uid => libMap[uid]?.star || 0).reduce((max, value) => Math.max(max, value), 0),
      libNote: c.uids.map(uid => libMap[uid]?.note).find(Boolean) || '',
      bd_id: latestSample?.bd_id || libraryBdId || historicalBdId,
      bd_name: ''
    };
  });
  const bdRows = db.prepare('SELECT id, name FROM bd_members WHERE active = 1').all();
  const bdMap = {};
  bdRows.forEach(b => { bdMap[b.id] = b.name; });
  creators = creators.map(c => {
    const cooperationCount = c.samples.length;
    const orderWhere = [];
    const orderParams = [];
    if (shop && shop !== 'all') {
      orderWhere.push('shop_id = ?');
      orderParams.push(shop);
    }
    orderWhere.push('creator_username = ?');
    orderParams.push(normalizeCreatorHandle(c.handle));
    orderRange.where.forEach((clause) => orderWhere.push(clause));
    orderParams.push(...orderRange.params);
    const orderStats = db.prepare(`
      SELECT
        COUNT(DISTINCT external_order_id) AS order_count,
        COALESCE(SUM(quantity), 0) AS item_count,
        COALESCE(SUM(sales_amount), 0) AS sales_amount,
        COALESCE(SUM(commission_amount), 0) AS commission_amount,
        MAX(currency) AS currency
      FROM affiliate_orders
      WHERE ${orderWhere.join(' AND ')}
    `).get(...orderParams);
    const totalOrders = Number(orderStats?.order_count || 0);
    return {
      ...c,
      bd_name: c.bd_id ? (bdMap[c.bd_id] || '') : '',
      cooperationCount,
      totalOrders,
      affiliateItemCount: Number(orderStats?.item_count || 0),
      affiliateSalesAmount: Number(orderStats?.sales_amount || 0),
      affiliateCommissionAmount: Number(orderStats?.commission_amount || 0),
      affiliateCurrency: orderStats?.currency || '',
      orderRangeLabel: orderRange.label,
      orderRangeStart: orderRange.start || '',
      orderRangeEnd: orderRange.end || ''
    };
  });

  // 搜索 / 星级 / 过滤
  if (search) {
    const q = search.toLowerCase();
    creators = creators.filter(c => (c.name + c.handle + c.uid + c.uids.join('')).toLowerCase().includes(q));
  }
  if (star) {
    creators = creators.filter(c => c.star == star);
  }
  if (bd) {
    creators = creators.filter(c => String(c.bd_id || '') === String(bd));
  }

  const sortKey = sort || 'latest_desc';
  creators.sort((a, b) => {
    if (sortKey === 'latest_asc') return String(a.latestCoopAt || '').localeCompare(String(b.latestCoopAt || ''));
    if (sortKey === 'latest_desc') return String(b.latestCoopAt || '').localeCompare(String(a.latestCoopAt || ''));
    if (sortKey === 'first_asc') return String(a.firstCoopAt || '').localeCompare(String(b.firstCoopAt || ''));
    if (sortKey === 'first_desc') return String(b.firstCoopAt || '').localeCompare(String(a.firstCoopAt || ''));
    if (sortKey === 'count_desc') return (b.cooperationCount || 0) - (a.cooperationCount || 0);
    if (sortKey === 'count_asc') return (a.cooperationCount || 0) - (b.cooperationCount || 0);
    if (sortKey === 'orders_desc') return (b.totalOrders || 0) - (a.totalOrders || 0);
    if (sortKey === 'orders_asc') return (a.totalOrders || 0) - (b.totalOrders || 0);
    return String(b.latestCoopAt || '').localeCompare(String(a.latestCoopAt || ''));
  });

  res.json(creators);
});

app.post('/api/library/auto-star', (req, res) => {
  const shop = String(req.body?.shop || req.query.shop || 'all');
  const range = affiliateOrderRangeFilter({ order_range: '90d' });
  const activeStatuses = ['approved', 'shipped', 'published'];
  let sql = `
    SELECT uid, creator_handle
    FROM samples
    WHERE status IN (${activeStatuses.map(() => '?').join(',')})
      AND library_added_at IS NOT NULL
  `;
  const params = [...activeStatuses];
  if (shop && shop !== 'all') {
    sql += ' AND shop_id = ?';
    params.push(shop);
  }

  const creators = new Map();
  db.prepare(sql).all(...params).forEach((row) => {
    const handle = normalizeCreatorHandle(row.creator_handle);
    const key = handle ? `handle:${handle}` : `uid:${row.uid}`;
    if (!creators.has(key)) creators.set(key, { handle, uids: new Set() });
    creators.get(key).uids.add(row.uid);
  });

  const saveStar = db.prepare(`
    INSERT INTO creator_library (uid, star, note) VALUES (?, ?, '')
    ON CONFLICT(uid) DO UPDATE SET star = excluded.star
  `);
  const orderSql = `
    SELECT COUNT(DISTINCT external_order_id) AS order_count
    FROM affiliate_orders
    WHERE ${shop && shop !== 'all' ? 'shop_id = ? AND ' : ''}
      creator_username = ?
      AND ${range.where.join(' AND ')}
  `;
  const orderStmt = db.prepare(orderSql);
  let updated = 0;
  const byStar = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  db.exec('BEGIN');
  try {
    for (const creator of creators.values()) {
      const handle = creator.handle;
      const orderArgs = shop && shop !== 'all'
        ? [shop, handle, ...range.params]
        : [handle, ...range.params];
      const orderCount = handle ? Number(orderStmt.get(...orderArgs)?.order_count || 0) : 0;
      const nextStar = starByRecentOrders(orderCount);
      byStar[nextStar] += 1;
      for (const uid of creator.uids) {
        saveStar.run(uid, nextStar);
        updated += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }

  res.json({
    success: true,
    shop,
    range: range.label,
    start: range.start,
    creators: creators.size,
    rows_updated: updated,
    by_star: byStar,
    rule: {
      5: '>100单',
      4: '50-100单',
      3: '30-50单',
      2: '10-30单',
      1: '<10单且已出单',
      0: '未出单'
    }
  });
});

// 设置星级
app.put('/api/library/:uid/star', (req, res) => {
  const { uid } = req.params;
  const { star } = req.body;
  const uids = Array.isArray(req.body.uids) && req.body.uids.length ? req.body.uids : [uid];
  const saveStar = db.prepare(`
    INSERT INTO creator_library (uid, star, note) VALUES (?, ?, '')
    ON CONFLICT(uid) DO UPDATE SET star = ?
  `);
  uids.forEach((item) => saveStar.run(item, star, star));
  res.json({ success: true });
});

// 保存BD备注
app.put('/api/library/:uid/note', (req, res) => {
  const { uid } = req.params;
  const { note } = req.body;
  const uids = Array.isArray(req.body.uids) && req.body.uids.length ? req.body.uids : [uid];
  const saveNote = db.prepare(`
    INSERT INTO creator_library (uid, star, note) VALUES (?, 0, ?)
    ON CONFLICT(uid) DO UPDATE SET note = ?
  `);
  uids.forEach((item) => saveNote.run(item, note, note));
  res.json({ success: true });
});

// 修改合作达人库负责人 BD
app.put('/api/library/:uid/bd', (req, res) => {
  const { uid } = req.params;
  const uids = Array.isArray(req.body.uids) && req.body.uids.length ? req.body.uids : [uid];
  const bdId = req.body.bd_id ? Number(req.body.bd_id) : null;
  if (bdId) {
    const exists = db.prepare('SELECT id FROM bd_members WHERE id = ? AND active = 1').get(bdId);
    if (!exists) return res.status(400).json({ error: 'BD 成员不存在或未启用' });
  }
  const saveBd = db.prepare(`
    INSERT INTO creator_library (uid, star, note, bd_id) VALUES (?, 0, '', ?)
    ON CONFLICT(uid) DO UPDATE SET bd_id = excluded.bd_id
  `);
  uids.forEach((item) => saveBd.run(item, bdId));

  let notificationSampleId = null;
  if (bdId) {
    const latestSample = latestAssignableSampleForUids(uids);
    if (latestSample) {
      notificationSampleId = latestSample.id;
      const updateSamples = db.prepare(`
        UPDATE samples
        SET bd_id = ?,
            library_added_at = CASE
              WHEN library_added_at IS NULL THEN datetime('now')
              ELSE library_added_at
            END
        WHERE uid IN (${[...new Set(uids)].map(() => '?').join(',')})
          AND status IN ('approved', 'shipped', 'published')
      `);
      updateSamples.run(bdId, ...[...new Set(uids)]);
      notifyBdAssigned(notificationSampleId).catch((error) => {
        console.error(`[wecom] unexpected library BD notification error for sample ${notificationSampleId}:`, error.message);
      });
    } else {
      console.warn(`[wecom] no active sample found for library BD assignment: ${uids.join(', ')}`);
    }
  }

  res.json({ success: true, notificationSampleId });
});

// ════════════════════════════════════════
// 【新增】TikTok OAuth 授权回调路由（解决 Cannot GET 404）
// ════════════════════════════════════════
async function handleTikTokOAuthCallback(req, res) {
  try {
    const { code } = req.query;
    const shopId = String(req.query.state || req.query.shop || 'oku');
    if (!code) return res.status(400).send('缺少授权码 code');
    const localShop = db.prepare('SELECT id, name FROM shops WHERE id = ?').get(shopId);
    if (!localShop) return res.status(400).send(`未知店铺：${shopId}`);

    const tokenData = await getTokenByCode(code, shopId);
    const authorizedShops = await getAuthorizedShops(tokenData.access_token, shopId).catch(() => []);
    const authorizedShop = pickAuthorizedShop(localShop, authorizedShops);
    const shopEnvPrefix = `TK_${shopId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    const shopCipher = firstText(
      authorizedShop?.shop_cipher,
      authorizedShop?.cipher,
      authorizedShop?.shop_cipher_text,
      process.env[`${shopEnvPrefix}SHOP_CIPHER`],
      process.env[`${shopEnvPrefix}SHOP_ID`],
      shopId === 'oku' ? process.env.TK_SHOP_CIPHER : '',
      shopId === 'oku' ? process.env.TK_SHOP_ID : ''
    );

    if (!shopCipher) {
      writeSyncLog(shopId, 'oauth', 'failed', '授权成功但未获取到 shop_cipher');
      return res.status(500).send(`授权成功，但没有获取到 ${localShop.name} 的 shop_cipher。请返回系统查看授权状态，或运行 get-shop-cipher.js 检查授权店铺。`);
    }

    db.prepare(`
      UPDATE shops
      SET access_token = ?, refresh_token = ?, shop_cipher = ?, token_expires_at = ?
      WHERE id = ?
    `).run(tokenData.access_token, tokenData.refresh_token || '', shopCipher, tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null, shopId);
    writeSyncLog(shopId, 'oauth', 'success', `${localShop.name} 店铺授权完成`);
    return res.send(`${localShop.name} 店铺授权完成，Token 和 shop_cipher 已保存，可以返回系统执行同步。`);
  } catch (err) {
    const shopId = String(req.query.state || req.query.shop || 'oku');
    writeSyncLog(shopId, 'oauth', 'failed', err.message || '授权失败');
    return res.status(500).send(`授权失败：${err.message}`);
  }
}

app.get('/api/tiktok/oauth/callback', handleTikTokOAuthCallback);
app.get('/tk/api/tiktok/oauth/callback', handleTikTokOAuthCallback);
app.startShopSyncScheduler = startShopSyncScheduler;
app.startAgentScheduler = startAgentScheduler;

module.exports = app;
















