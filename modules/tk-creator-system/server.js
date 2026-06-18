// server.js — TikTok达人管理系统 后端服务
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const db = require('./db');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const { ensureSyncSchema, syncTikTokShop } = require('./syncTikTok');

const app = express();
const PORT = 3001; // 修改端口为3001，和你的ngrok/前端统一

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════
//  工具函数 + TikTok OAuth Token交换函数
// ════════════════════════════════════════
function genId() {
  return 's' + Math.random().toString(36).slice(2, 10);
}

function nowText() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
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
async function getTokenByCode(code) {
  const app_key = process.env.TK_APP_KEY;
  const app_secret = process.env.TK_APP_SECRET;

  if (!app_key || !app_secret) {
    throw new Error('缺少 TK_APP_KEY 或 TK_APP_SECRET，请检查 .env 配置');
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

        // 将token写入本地.env文件
        const envPath = path.join(__dirname, '.env');
        let envText = '';
        try {
          envText = fs.readFileSync(envPath, 'utf8');
        } catch (e) {
          envText = ''; // .env 不存在时从空文件开始
        }

        envText = upsertEnvVar(envText, 'TK_ACCESS_TOKEN', data.data.access_token);
        envText = upsertEnvVar(envText, 'TK_REFRESH_TOKEN', data.data.refresh_token);
        fs.writeFileSync(envPath, envText, 'utf8');

        resolve(data.data);
      });
    });
    req.on('error', reject);
    req.end(); // GET 请求不需要 write body，但仍要调用 end() 才会真正发出去
  });
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
`);

try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_status TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN last_sync_message TEXT'); } catch (_) {}

function importEnvAuthorizationToShop(shopId = 'oku') {
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
    const message = `店铺数据同步完成：商品 ${detail.products.total} 条，订单 ${detail.orders.total} 条`;

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
  setTimeout(async () => {
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

scheduleShopSync();

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

app.post('/api/sync/shops', async (req, res) => {
  try {
    const result = await syncAllShops('manual');
    res.json(result);
  } catch (error) {
    writeSyncLog(null, 'manual', 'failed', error.message || '同步失败');
    res.status(500).json({ error: error.message || '同步失败' });
  }
});

// ════════════════════════════════════════
//  BD 成员
// ════════════════════════════════════════
app.get('/api/bd', (req, res) => {
  const list = db.prepare('SELECT id, name, active FROM bd_members WHERE active = 1').all();
  // 附带当前负责的达人数量（按 uid 去重）
  const withLoad = list.map(b => {
    const load = db.prepare(`SELECT COUNT(DISTINCT uid) AS c FROM samples WHERE bd_id = ?`).get(b.id).c;
    return { ...b, load };
  });
  res.json(withLoad);
});

app.post('/api/bd', (req, res) => {
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: '缺少姓名' });
  const result = db.prepare('INSERT INTO bd_members (name, email) VALUES (?, ?)').run(name, email || null);
  res.json({ id: Number(result.lastInsertRowid), name, email });
});

// ════════════════════════════════════════
//  商品
// ════════════════════════════════════════
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
      b.name AS bd_name
    FROM samples s
    LEFT JOIN products p ON s.product_id = p.id
    LEFT JOIN bd_members b ON s.bd_id = b.id
    WHERE 1=1
  `;
  const params = [];

  if (shop && shop !== 'all') {
    sql += ' AND s.shop_id = ?';
    params.push(shop);
  }
  if (status) {
    sql += ' AND s.status = ?';
    params.push(status);
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
  const shopFilter = shop && shop !== 'all' ? 'WHERE shop_id = ?' : '';
  const args = shop && shop !== 'all' ? [shop] : [];

  const all = db.prepare(`SELECT COUNT(*) AS c FROM samples ${shopFilter}`).get(...args).c;
  const byStatus = {};
  for (const st of ['pending','approved','rejected','assigned','shipped','published']) {
    const sql = shopFilter
      ? `SELECT COUNT(*) AS c FROM samples WHERE shop_id = ? AND status = ?`
      : `SELECT COUNT(*) AS c FROM samples WHERE status = ?`;
    const a = shopFilter ? [...args, st] : [st];
    byStatus[st] = db.prepare(sql).get(...a).c;
  }
  const assignedBD = db.prepare(
    shopFilter ? `SELECT COUNT(*) AS c FROM samples WHERE shop_id=? AND bd_id IS NOT NULL` : `SELECT COUNT(*) AS c FROM samples WHERE bd_id IS NOT NULL`
  ).get(...args).c;

  res.json({ total: all, byStatus, assignedBD });
});

// 新建样品申请（手动添加，或未来对接TikTok API写入）
app.post('/api/samples', (req, res) => {
  const id = genId();
  const s = req.body;
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
    s.bd_id || null,
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

  // 如果是分配BD，模拟生成一条通知（实际项目可换成站内信/邮件/webhook）
  if ('bd_id' in req.body && req.body.bd_id) {
    const bd = db.prepare('SELECT name FROM bd_members WHERE id = ?').get(req.body.bd_id);
    console.log(`📨 [通知] 已将样品 ${id} 分配给 BD: ${bd?.name}`);
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
app.get('/api/library', (req, res) => {
  const { shop, search, star, bd } = req.query;

  const activeStatuses = ['approved', 'assigned', 'shipped', 'published'];
  let sql = `
    SELECT
      s.*, 
      p.sku AS product_sku, p.name AS product_name, p.emoji AS product_emoji,
      b.name AS bd_name
    FROM samples s
    LEFT JOIN products p ON s.product_id = p.id
    LEFT JOIN bd_members b ON s.bd_id = b.id
    WHERE s.status IN (${activeStatuses.map(()=>'?').join(',')})
  `;
  const params = [...activeStatuses];

  if (shop && shop !== 'all') {
    sql += ' AND s.shop_id = ?';
    params.push(shop);
  }
  if (bd) {
    sql += ' AND s.bd_id = ?';
    params.push(bd);
  }

  sql += ' ORDER BY s.applied_at DESC';
  const rows = db.prepare(sql).all(...params);

  // 按 uid 分组聚合
  const map = {};
  for (const r of rows) {
    if (!map[r.uid]) {
      map[r.uid] = {
        uid: r.uid,
        name: r.creator_name,
        handle: r.creator_handle,
        fans: r.fans,
        category: r.category,
        shops: new Set(),
        samples: []
      };
    }
    map[r.uid].shops.add(r.shop_id);
    map[r.uid].samples.push(r);
  }

  let creators = Object.values(map).map(c => ({ ...c, shops: [...c.shops] }));

  // 补充 library 表里的星级/备注
  const libRows = db.prepare('SELECT * FROM creator_library').all();
  const libMap = {};
  for (const l of libRows) libMap[l.uid] = l;

  creators = creators.map(c => ({
    ...c,
    star: libMap[c.uid]?.star || 0,
    libNote: libMap[c.uid]?.note || ''
  }));

  // 搜索 / 星级 / 过滤
  if (search) {
    const q = search.toLowerCase();
    creators = creators.filter(c => (c.name + c.handle + c.uid).toLowerCase().includes(q));
  }
  if (star) {
    creators = creators.filter(c => c.star == star);
  }

  res.json(creators);
});

// 设置星级
app.put('/api/library/:uid/star', (req, res) => {
  const { uid } = req.params;
  const { star } = req.body;
  db.prepare(`
    INSERT INTO creator_library (uid, star, note) VALUES (?, ?, '')
    ON CONFLICT(uid) DO UPDATE SET star = ?
  `).run(uid, star, star);
  res.json({ success: true });
});

// 保存BD备注
app.put('/api/library/:uid/note', (req, res) => {
  const { uid } = req.params;
  const { note } = req.body;
  db.prepare(`
    INSERT INTO creator_library (uid, star, note) VALUES (?, 0, ?)
    ON CONFLICT(uid) DO UPDATE SET note = ?
  `).run(uid, note, note);
  res.json({ success: true });
});

// ════════════════════════════════════════
// 【新增】TikTok OAuth 授权回调路由（解决 Cannot GET 404）
// ════════════════════════════════════════
async function handleTikTokOAuthCallback(req, res) {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('缺少授权码 code');
    const tokenData = await getTokenByCode(code);
    const shopCipher = process.env.TK_SHOP_CIPHER || process.env.TK_SHOP_ID || '';
    db.prepare(`
      UPDATE shops
      SET access_token = ?, refresh_token = ?, shop_cipher = ?
      WHERE id = 'oku'
    `).run(tokenData.access_token, tokenData.refresh_token || '', shopCipher);
    writeSyncLog('oku', 'oauth', 'success', 'OKUYOSHI 店铺授权完成');
    return res.send('OKUYOSHI 店铺授权完成，Token 已保存，可以返回系统执行同步。');
  } catch (err) {
    writeSyncLog('oku', 'oauth', 'failed', err.message || '授权失败');
    return res.status(500).send(`授权失败：${err.message}`);
  }
}

app.get('/api/tiktok/oauth/callback', handleTikTokOAuthCallback);
app.get('/tk/api/tiktok/oauth/callback', handleTikTokOAuthCallback);
// ════════════════════════════════════════
//  启动
// ════════════════════════════════════════
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TikTok creator system running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;

