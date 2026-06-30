// server.js — TikTok达人管理系统 后端服务
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const db = require('./db');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const { Pool } = require('pg');
const { ensureSyncSchema, syncAffiliateCreators, syncAffiliateOrders, syncMissingProductImages, syncProducts, syncTikTokShop } = require('./syncTikTok');
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
  const activeStatuses = ['approved', 'shipped', 'published'];
  const placeholders = list.map(() => '?').join(',');
  return db.prepare(`
    SELECT id
    FROM samples
    WHERE uid IN (${placeholders})
      AND status IN (${activeStatuses.map(() => '?').join(',')})
    ORDER BY applied_at DESC, id DESC
    LIMIT 1
  `).get(...list, ...activeStatuses);
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
    SELECT id, name, email, wecom_userid, external_user_id, source, active
    FROM bd_members
    WHERE active = 1
    ORDER BY source = 'employee' DESC, id
  `).all();
  return list.map((b) => {
    const load = db.prepare(`SELECT COUNT(DISTINCT uid) AS c FROM samples WHERE bd_id = ?`).get(b.id).c;
    return { ...b, load };
  });
}

async function notifyBdAssigned(sampleId) {
  const webhook = process.env.WECOM_BD_ASSIGN_WEBHOOK || '';
  if (!webhook) {
    console.warn('[wecom] WECOM_BD_ASSIGN_WEBHOOK is empty, skip BD assign notification');
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
    '### 新的样品分配任务',
    `> 达人名称：${detail.creator_name || '-'}`,
    `> TikTok ID：${detail.creator_handle || detail.uid || '-'}`,
    `> 样品名称：${detail.product_name || '-'}`,
    `> 佣金比例：${percentText(detail.commission_rate)}`,
    `> 剩余天数：${daysLeftText(detail.approve_expiration_at)}`,
    mention ? `\n${mention}` : '',
  ].filter(Boolean).join('\n');

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
  product_id INTEGER,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_status TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_message TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_templates ADD COLUMN type TEXT NOT NULL DEFAULT 'dm'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_templates ADD COLUMN product_id INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN template_type TEXT NOT NULL DEFAULT 'dm'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN product_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN product_ids TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN commission_rate REAL'); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN target_collaboration_id TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN send_mode TEXT NOT NULL DEFAULT 'auto'"); } catch (_) {}
try { db.exec("ALTER TABLE invitation_records ADD COLUMN sample_approval_mode TEXT NOT NULL DEFAULT 'manual'"); } catch (_) {}
try { db.exec('ALTER TABLE invitation_records ADD COLUMN sample_apply_link TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE products ADD COLUMN product_url TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE samples ADD COLUMN commission_rate REAL'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN invitation_record_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE agent_workflow_tasks ADD COLUMN assigned_bd_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_count_30d INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_amount_30d REAL'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_currency TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN normalized_handle TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_shop_sales ON affiliate_creators(shop_id, sales_count_30d)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_handle ON affiliate_creators(normalized_handle)'); } catch (_) {}

const DEFAULT_AGENT_SETTINGS = {
  invite_template: '您好，我们是店铺BD，看到您的内容风格和我们的商品很匹配，想邀请您参与样品合作。',
  followup_template: '您好，样品进度想和您确认一下。如已收到样品，方便的话请告知预计发布时间。',
  review_rules: '按近90天出单、内容质量、履约率和沟通效率复盘达人，沉淀复邀和加佣建议。',
  invite_daily_limit: 50,
  audit_min_followers: 1000,
  audit_min_fulfillment: 80,
  assign_strategy: '按店铺、达人类型、BD负载和历史合作经验自动分配',
  followup_interval_days: 3,
};

const DEFAULT_INVITATION_TEMPLATES = [
  {
    name: '样品合作邀约',
    channel: 'im',
    type: 'collab',
    content: '您好 {{creator_name}}，我们是 {{shop_name}} 店铺BD。想邀请您体验 {{product_name}}。您可以直接点击链接申请样品：{{sample_apply_link}}',
  },
  {
    name: '私信初次触达',
    channel: 'im',
    type: 'dm',
    content: '您好 {{creator_name}}，我们是 {{shop_name}} 店铺BD。看到您的内容风格和我们的商品很匹配，想了解是否有合作兴趣。',
  },
  {
    name: '复邀老合作达人',
    channel: 'im',
    type: 'dm',
    content: '您好 {{creator_name}}，感谢之前与 {{shop_name}} 的合作。我们近期有新的商品和活动，想再次邀请您参与推广合作，方便的话可以回复确认档期。',
  },
];

function ensureInvitationTemplates() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM invitation_templates WHERE active = 1').get().c;
  if (count) return;
  const insert = db.prepare(`
    INSERT INTO invitation_templates (name, channel, type, content, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  const now = nowText();
  DEFAULT_INVITATION_TEMPLATES.forEach((tpl) => insert.run(tpl.name, tpl.channel, tpl.type || 'dm', tpl.content, now, now));
}

ensureInvitationTemplates();
db.prepare(`
  UPDATE invitation_templates
  SET type = 'collab',
      content = CASE
        WHEN content LIKE '%{{sample_apply_link}}%' THEN content
        ELSE '您好 {{creator_name}}，我们是 {{shop_name}} 店铺BD。想邀请您体验 {{product_name}}。您可以直接点击链接申请样品：{{sample_apply_link}}'
      END,
      updated_at = ?
  WHERE active = 1 AND name LIKE '%样品合作邀约%'
`).run(nowText());

function getAgentSettings() {
  const rows = db.prepare('SELECT key, value FROM agent_settings').all();
  const data = { ...DEFAULT_AGENT_SETTINGS };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(data, row.key)) data[row.key] = row.value;
  }
  for (const key of ['invite_daily_limit', 'audit_min_followers', 'audit_min_fulfillment', 'followup_interval_days']) {
    data[key] = Number(data[key] || DEFAULT_AGENT_SETTINGS[key]);
  }
  return data;
}

function saveAgentSettings(input = {}) {
  const current = getAgentSettings();
  const next = { ...current };
  Object.keys(DEFAULT_AGENT_SETTINGS).forEach((key) => {
    if (input[key] !== undefined) next[key] = input[key];
  });
  next.invite_daily_limit = Math.max(1, Number(next.invite_daily_limit || 50));
  next.audit_min_followers = Math.max(0, Number(next.audit_min_followers || 0));
  next.audit_min_fulfillment = Math.max(0, Math.min(100, Number(next.audit_min_fulfillment || 0)));
  next.followup_interval_days = Math.max(1, Number(next.followup_interval_days || 3));
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
    star: Number(row.star || 0),
    total_orders: Number(row.total_orders || 0),
    sales_count_30d: row.sales_count_30d === undefined || row.sales_count_30d === null ? null : Number(row.sales_count_30d || 0),
    sales_amount: Number(row.sales_amount || 0),
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
  const category = String(query.category || '').trim().toLowerCase();
  const search = String(query.search || '').trim().toLowerCase();

  return list.filter((item) => {
    if (minFans && Number(item.fans || 0) < minFans) return false;
    if (minFulfillment && Number(item.fulfillment_rate || 0) < minFulfillment) return false;
    if (minAvgView && Number(item.avg_view || 0) < minAvgView) return false;
    if (minStar && Number(item.star || 0) < minStar) return false;
    if (minOrders && Number(item.total_orders || 0) < minOrders) return false;
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
        ac.sales_count_30d,
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
    min_fans: 1000,
    min_fulfillment: 0,
    min_avg_view: 0,
    min_orders: 0,
    category: '',
    template_id: firstTemplate?.id || '',
    product_ids: firstProduct?.id ? [firstProduct.id] : [],
    commission_rate: 15,
    send_mode: 'manual',
    invite_max_per_creator: 1,
    invite_daily_limit: 50,
    sample_approval_mode: 'manual',
    audit_min_score: 70,
    auto_approve_score: 90,
    bd_ids: bdRows.map((row) => row.id),
    assign_mode: 'round_robin',
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
  config.audit_min_score = Number(config.audit_min_score || 70);
  config.auto_approve_score = Number(config.auto_approve_score || 90);
  config.send_mode = config.send_mode === 'auto' ? 'auto' : 'manual';
  config.sample_approval_mode = config.sample_approval_mode === 'auto' ? 'auto' : 'manual';
  config.assign_mode = config.assign_mode === 'least_load' ? 'least_load' : 'round_robin';
  const name = String(input.name || current?.name || '自动化工作流').trim();
  if (createNew || !current) {
    const now = nowText();
    const result = db.prepare(`
      INSERT INTO agent_workflows (name, active, config_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?)
    `).run(name, JSON.stringify(config), now, now);
    return getWorkflow(result.lastInsertRowid);
  }
  db.prepare('UPDATE agent_workflows SET name = ?, config_json = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(config), nowText(), current.id);
  return getWorkflow(current.id);
}

function auditByWorkflowConditions(item, config) {
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
  };
}

function agentScoreCandidate(item, config) {
  return auditByWorkflowConditions(item, config);
}

function agentScoreSample(sample, config) {
  return auditByWorkflowConditions({
    ...sample,
    avg_view: rowMetricNumber(sample.avg_view),
    total_orders: sample.total_orders ?? sample.sales_count ?? 0,
  }, config);
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
      sample_id, score, recommendation, reason, payload_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    min_star: config.min_star,
    min_fans: config.min_fans,
    min_fulfillment: config.min_fulfillment,
    min_avg_view: config.min_avg_view,
    min_orders: config.min_orders,
    category: config.category,
  };
  const candidates = listInviteCandidates(candidateQuery);
  const diagnostics = inviteCandidateDiagnostics(candidateQuery);
  const inviteLimit = Math.max(1, Number(config.invite_daily_limit || 50));
  const maxPerCreator = Math.max(1, Number(config.invite_max_per_creator || 1));
  const today = nowText().slice(0, 10);
  const todayCreated = db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_workflow_tasks
    WHERE workflow_id = ?
      AND task_type = 'invite'
      AND date(created_at) = ?
  `).get(workflow.id, today).c;
  let remainingInviteSlots = Math.max(0, inviteLimit - Number(todayCreated || 0));
  let inviteCount = 0;
  for (const candidate of candidates) {
    if (remainingInviteSlots <= 0) break;
    if (Number(candidate.invited_count || 0) >= maxPerCreator) continue;
    const audit = agentScoreCandidate(candidate, config);
    insertWorkflowTask(workflow.id, 'invite', 'admin_approved', candidate, audit, { candidate, config_snapshot: config });
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
    if (conditionAudit.recommendation !== 'auto_pass') continue;
    const audit = { score: 100, recommendation: 'pending_reply', reason: '条件匹配，待发送确认拍摄与发布消息' };
    insertWorkflowTask(workflow.id, 'sample_message', 'admin_approved', item, audit, { sample: item, config_snapshot: config, condition_audit: conditionAudit });
    sampleCount += 1;
  }
  return { workflow, invite_count: inviteCount, sample_count: sampleCount, diagnostics };
}

function workflowTasks(workflowId, limit = 120) {
  return db.prepare(`
    SELECT t.*, b.name AS assigned_bd_name
    FROM agent_workflow_tasks t
    LEFT JOIN bd_members b ON b.id = t.assigned_bd_id
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
      sample_apply_link, channel, message, status, provider_message, created_at, sent_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  for (const task of tasks) {
    const creator = task.payload?.candidate || task.payload || {};
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(creator.shop_id || task.shop_id || config.shop) ||
      db.prepare('SELECT * FROM shops ORDER BY id LIMIT 1').get();
    const nextId = nextInvitationRecordId();
    const applyLink = template.type === 'collab' ? sampleApplyLink(nextId) : null;
    const message = renderInvitationMessage(template, creator, shop, products, nextId, {
      commission_rate: config.commission_rate,
      omit_sample_apply_link: template.type === 'collab' && config.send_mode === 'auto',
    });
    let sendResult = { status: 'pending', provider_message: '工作流手动邀约模式：已生成记录，未自动发送 TikTok 私信' };
    let targetCollaborationId = null;
    if (config.send_mode === 'auto') {
      try {
        let cards = [];
        if (template.type === 'collab') {
          const target = await createTargetCollaboration({
            shop,
            creator,
            products,
            message,
            commissionRate: config.commission_rate,
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
      template.id,
      template.type || 'dm',
      products[0]?.id || null,
      products.length ? JSON.stringify(products.map((item) => item.id)) : null,
      Number(config.commission_rate || 0),
      targetCollaborationId,
      config.send_mode,
      config.sample_approval_mode,
      applyLink,
      'im',
      message,
      sendResult.status,
      sendResult.provider_message,
      now,
      sendResult.status === 'sent' ? now : null
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

function sampleConfirmationMessage(config, sample) {
  return String(config.auto_reply_template || '').trim() ||
    `您好，您申请的样品我们已收到。请确认收到样品后是否可以拍摄并发布 TikTok 视频；如果可以，请回复预计发布时间和内容形式。`;
}

function judgeSampleReply(replyText, sample, config) {
  const text = String(replyText || '').trim().toLowerCase();
  const negative = /(不能|不可以|无法|不会|拒绝|取消|不拍|不发|できません|無理|投稿できない|撮影できない|no|can't|cannot|not able|sorry)/i.test(text);
  const positive = /(可以|能|会|愿意|確認|确认|拍摄|拍攝|发布|發布|投稿|撮影|できます|可能|ok|yes|sure|will|can|available)/i.test(text);
  const conditionAudit = agentScoreSample(sample, config);
  if (!text) {
    return { score: 0, recommendation: 'manual_review', reason: '未录入达人回复' };
  }
  if (negative) {
    return { score: 0, recommendation: 'manual_review', reason: `模型判断不可合作：${replyText}` };
  }
  if (!positive) {
    return { score: 0, recommendation: 'manual_review', reason: `回复意向不明确，需人工跟进：${replyText}` };
  }
  if (conditionAudit.recommendation !== 'auto_pass') {
    return { ...conditionAudit, recommendation: 'manual_review', reason: `达人已回复可拍摄，但条件未全满足：${conditionAudit.reason}` };
  }
  return { score: 100, recommendation: 'auto_pass', reason: `达人回复可拍摄并发布，条件满足：${replyText}` };
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
    const message = sampleConfirmationMessage(config, sample);
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
      null,
      'dm',
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

async function executeWorkflow(workflowId = null) {
  const workflow = getWorkflow(workflowId);
  const inviteTasks = workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'invite' && task.status === 'admin_approved');
  const inviteResults = await sendWorkflowInvitations(inviteTasks, workflow);
  const messageTasks = workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'sample_message' && task.status === 'admin_approved');
  const sample_message_results = await sendWorkflowSampleMessages(messageTasks, workflow);
  const sampleTasks = workflowTasks(workflow.id, 300).filter((task) => task.task_type === 'sample_audit' && task.status === 'admin_approved');
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
  return { invite_results: inviteResults, sample_message_results, assigned_samples: assigned };
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

function writeSyncLog(shopId, source, status, message) {
  db.prepare(`
    INSERT INTO sync_logs (shop_id, source, status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, source, status, message, nowText());
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

async function syncAllShops(source = 'manual') {
  const shops = db.prepare('SELECT * FROM shops ORDER BY id').all();
  const results = [];
  for (const shop of shops) {
    results.push(await syncOneShop(shop, source));
  }
  return {
    source,
    synced_at: nowText(),
    total: results.length,
    results,
  };
}

function msUntilNextSchedule() {
  const now = new Date();
  const targets = [7, 12, 18].map((hour) => {
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  });
  const next = targets.sort((a, b) => a - b)[0];
  return { next, ms: next.getTime() - now.getTime() };
}

function scheduleShopSync() {
  const { next, ms } = msUntilNextSchedule();
  console.log(`[sync] next shop sync at ${next.toLocaleString()}`);
  syncTimer = setTimeout(async () => {
    try {
      const result = await syncAllShops('schedule');
      console.log(`[sync] scheduled shop sync finished: ${result.total} shops`);
    } catch (error) {
      console.error('[sync] scheduled shop sync failed:', error);
      writeSyncLog(null, 'schedule', 'failed', error.message || '同步失败');
    } finally {
      scheduleShopSync();
    }
  }, ms);
}

let syncTimer = null;
function startShopSyncScheduler() {
  if (syncTimer) return;
  scheduleShopSync();
}

// ════════════════════════════════════════
//  店铺
// ════════════════════════════════════════
app.get('/api/shops', (req, res) => {
  const shops = db.prepare(`
    SELECT id, name, color, last_sync_at, last_sync_status, last_sync_message
    FROM shops
  `).all();
  res.json(shops);
});

app.get('/api/sync/status', (req, res) => {
  const shops = db.prepare(`
    SELECT id, name, color, last_sync_at, last_sync_status, last_sync_message
    FROM shops
    ORDER BY id
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

app.put('/api/agent/settings', (req, res) => {
  try {
    res.json(saveAgentSettings(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message || '保存 Agent 配置失败' });
  }
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

app.get('/api/agent/workflows', (req, res) => {
  res.json({ workflows: workflowList() });
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

app.post('/api/agent/workflow/tasks/:id/confirm', (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const decision = String(req.body?.decision || 'approve');
    const status = decision === 'reject' ? 'admin_rejected' : 'admin_approved';
    const task = db.prepare('SELECT id FROM agent_workflow_tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: '工作流任务不存在' });
    db.prepare('UPDATE agent_workflow_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, nowText(), id);
    const taskRow = db.prepare('SELECT workflow_id FROM agent_workflow_tasks WHERE id = ?').get(id);
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
    const messageStatus = audit.recommendation === 'auto_pass' ? 'executed' : 'failed';
    db.prepare(`
      UPDATE agent_workflow_tasks
      SET status = ?, recommendation = ?, score = ?, reason = ?, payload_json = ?, updated_at = ?, executed_at = ?
      WHERE id = ?
    `).run(messageStatus, audit.recommendation, audit.score, audit.reason, JSON.stringify(nextPayload), nowText(), nowText(), id);
    if (audit.recommendation === 'auto_pass') {
      insertWorkflowTask(workflow.id, 'sample_audit', 'agent_review', { ...sample, sample_id: task.sample_id }, audit, {
        sample,
        creator_reply: replyText,
        config_snapshot: workflow.config,
      });
    }
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

app.get('/api/invitations/templates', (req, res) => {
  ensureInvitationTemplates();
  const rows = db.prepare(`
    SELECT id, name, channel, type, product_id, content
    FROM invitation_templates
    WHERE active = 1
    ORDER BY type, id
  `).all();
  res.json(rows);
});

app.post('/api/invitations/templates', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const content = String(req.body?.content || '').trim();
  const channel = String(req.body?.channel || 'im').trim() || 'im';
  const type = ['dm', 'collab'].includes(String(req.body?.type || 'dm')) ? String(req.body.type || 'dm') : 'dm';
  const productId = req.body?.product_id ? Number(req.body.product_id) : null;
  if (!name || !content) return res.status(400).json({ error: '缺少模板名称或内容' });
  const now = nowText();
  const result = db.prepare(`
    INSERT INTO invitation_templates (name, channel, type, product_id, content, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(name, channel, type, productId, content, now, now);
  res.json({ id: Number(result.lastInsertRowid), name, channel, type, product_id: productId, content });
});

app.put('/api/invitations/templates/:id', (req, res) => {
  const id = Number(req.params.id || 0);
  const name = String(req.body?.name || '').trim();
  const content = String(req.body?.content || '').trim();
  const channel = String(req.body?.channel || 'im').trim() || 'im';
  const type = ['dm', 'collab'].includes(String(req.body?.type || 'dm')) ? String(req.body.type || 'dm') : 'dm';
  const productId = req.body?.product_id ? Number(req.body.product_id) : null;
  if (!id) return res.status(400).json({ error: '模板 ID 不正确' });
  if (!name || !content) return res.status(400).json({ error: '缺少模板名称或内容' });
  db.prepare(`
    UPDATE invitation_templates
    SET name = ?, channel = ?, type = ?, product_id = ?, content = ?, updated_at = ?
    WHERE id = ?
  `).run(name, channel, type, productId, content, nowText(), id);
  res.json({ success: true });
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
    SELECT id, name, color, access_token, refresh_token, shop_cipher, last_sync_at, last_sync_status, last_sync_message
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
    const result = await syncAllShops('manual');
    res.json(result);
  } catch (error) {
    writeSyncLog(null, 'manual', 'failed', error.message || '同步失败');
    res.status(500).json({ error: error.message || '同步失败' });
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
  const allowed = ['name', 'email', 'wecom_userid', 'active'];
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
app.patch('/api/samples/:id', (req, res) => {
  const { id } = req.params;
  const allowed = ['status', 'collab_type', 'bd_id', 'note'];
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
  db.prepare(`UPDATE samples SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  markSampleLibraryReady(id);

  // 如果是分配BD，模拟生成一条通知（实际项目可换成站内信/邮件/webhook）
  if ('bd_id' in req.body && req.body.bd_id) {
    const bd = db.prepare('SELECT name, wecom_userid FROM bd_members WHERE id = ?').get(req.body.bd_id);
    console.log(`📨 [通知] 已将样品 ${id} 分配给 BD: ${bd?.name}`);
    notifyBdAssigned(id).catch((error) => {
      console.error(`[wecom] unexpected notification error for sample ${id}:`, error.message);
    });
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

  creators = creators.map(c => ({
    ...c,
    star: c.uids.map(uid => libMap[uid]?.star || 0).reduce((max, value) => Math.max(max, value), 0),
    libNote: c.uids.map(uid => libMap[uid]?.note).find(Boolean) || '',
    bd_id: c.uids.map(uid => libMap[uid]?.bd_id).find(Boolean) || c.samples.find(s => s.bd_id)?.bd_id || null,
    bd_name: ''
  }));
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
      SET access_token = ?, refresh_token = ?, shop_cipher = ?
      WHERE id = ?
    `).run(tokenData.access_token, tokenData.refresh_token || '', shopCipher, shopId);
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

module.exports = app;
















