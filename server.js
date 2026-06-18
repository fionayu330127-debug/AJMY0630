require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const TK_DIR = path.join(__dirname, 'modules', 'tk-creator-system');
const express = require(path.join(TK_DIR, 'node_modules', 'express'));
const tkApp = require(path.join(TK_DIR, 'server.js'));

const app = express();
const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:agimia_erp_2026@127.0.0.1:5432/agimia_erp';

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

app.disable('x-powered-by');
app.use(express.json());
app.use('/tk', tkApp);
app.use(express.static(ROOT, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
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
       WHERE name = $1 AND status = 'active'`,
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

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

async function start() {
  await query('SELECT 1');
  await ensureSeedData();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`奥吉米亚 ERP running at http://127.0.0.1:${PORT}`);
    console.log(`TK 达人管理系统 mounted at http://127.0.0.1:${PORT}/tk/`);
  });
}

start().catch((err) => {
  console.error('ERP server failed to start', err);
  process.exit(1);
});
