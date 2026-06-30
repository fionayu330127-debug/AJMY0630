const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  // The parent ERP shell loads dotenv; standalone mode can run without it.
}

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch {
  Pool = null;
}

const app = express.Router();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config', 'module.config.json');
const DATA_PATH = path.join(ROOT, 'data', 'submissions.json');
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:agimia_erp_2026@127.0.0.1:5432/agimia_erp';
const pool = Pool ? new Pool({ connectionString: DATABASE_URL }) : null;

const statusLabels = new Set(['链接刊登提交', '刊登人填写ASIN', '确认是否已开广告', '刊登异常', '链接上架成功']);
const statusByKey = {
  pending: '链接刊登提交',
  testing: '刊登人填写ASIN',
  passed: '确认是否已开广告',
  failed: '刊登异常',
  converted: '链接上架成功',
};

const submissionFields = [
  'sample_status',
  'listing_status',
  'urgency',
  'submit_date',
  'developer',
  'lister',
  'product_name',
  'product_keywords',
  'brand',
  'store_name',
  'variant_name',
  'source_url',
  'product_image',
  'product_note',
  'price_jp',
  'erp_listed',
  'direct_review',
  'ads_enabled',
  'amazon_asin',
  'product_sku',
];

function normalizeStatus(value) {
  const text = String(value || '').trim();
  if (statusLabels.has(text)) return text;
  if (text === '待审核') return '链接刊登提交';
  if (text === '测品中') return '刊登人填写ASIN';
  if (text === '测品通过') return '确认是否已开广告';
  if (text === '测品失败') return '刊登异常';
  if (text === '已转正式商品') return '链接上架成功';
  return statusByKey[text] || '链接刊登提交';
}

function statusKey(label) {
  if (label === '待审核') return 'pending';
  if (label === '测品中') return 'testing';
  if (label === '测品通过') return 'passed';
  if (label === '测品失败') return 'failed';
  if (label === '已转正式商品') return 'converted';
  return Object.entries(statusByKey).find(([, value]) => value === label)?.[0] || 'pending';
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

async function getCurrentUser(req) {
  if (typeof app.getCurrentUser === 'function') return app.getCurrentUser(req);
  if (!pool) return null;

  const token = parseCookies(req.headers.cookie || '').agi_session;
  if (!token) return null;

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.role, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND u.status = 'active'`,
      [token]
    );
    const user = rows[0];
    if (!user || new Date(user.expires_at).getTime() <= Date.now()) return null;
    return user;
  } catch (error) {
    console.error('load current product-test user failed', error);
    return null;
  }
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readSubmissions() {
  const rows = await readJson(DATA_PATH, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeSubmissions(rows) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function summarize(rows) {
  const summary = { total: rows.length, pending: 0, testing: 0, passed: 0, failed: 0, converted: 0 };
  for (const row of rows) {
    const key = statusKey(row.sample_status);
    summary[key] += 1;
  }
  return summary;
}

app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/api/config', async (req, res) => {
  const config = await readJson(CONFIG_PATH, {});
  res.json(config);
});

function normalizeImageUrl(value, sourceUrl) {
  const text = String(value || '').replaceAll('\\/', '/').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  try {
    return new URL(text, sourceUrl).toString();
  } catch {
    return '';
  }
}

function extractFirstImage(html, sourceUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /"image"\s*:\s*"([^"]+)"/i,
    /"mainPic"\s*:\s*"([^"]+)"/i,
    /"offerImg"\s*:\s*"([^"]+)"/i,
    /"(\/\/[^"]+alicdn\.com\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
    /(https?:\/\/[^"'\s]+alicdn\.com\/[^"'\s]+\.(?:jpg|jpeg|png|webp)[^"'\s]*)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const image = normalizeImageUrl(match?.[1], sourceUrl);
    if (image && isLikelyProductImage(image)) return image;
  }
  const images = collectImageUrls(html, sourceUrl).filter(isLikelyProductImage);
  images.sort((a, b) => imageScore(b) - imageScore(a));
  if (images[0]) return images[0];
  return '';
}

function collectImageUrls(html, sourceUrl) {
  const urls = new Set();
  const patterns = [
    /\/\/[^"'\\\s]+alicdn\.com\/[^"'\\\s]+\.(?:jpg|jpeg|png|webp)[^"'\\\s]*/gi,
    /https?:\/\/[^"'\\\s]+alicdn\.com\/[^"'\\\s]+\.(?:jpg|jpeg|png|webp)[^"'\\\s]*/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const image = normalizeImageUrl(match[0], sourceUrl);
      if (image) urls.add(image);
    }
  }
  return [...urls];
}

function imageScore(url) {
  let score = 0;
  if (/imgextra/i.test(url)) score += 50;
  if (/jpg|jpeg|webp/i.test(url)) score += 20;
  const dimensions = [...url.matchAll(/(?:^|[^\d])(\d{2,4})[x_-](\d{2,4})(?:[^\d]|$)/g)]
    .map((match) => Number(match[1]) * Number(match[2]));
  if (dimensions.length) score += Math.min(Math.max(...dimensions) / 1000, 100);
  if (/tps-\d+-\d+/i.test(url)) score -= 80;
  return score;
}

function isLikelyProductImage(url) {
  if (!url) return false;
  if (/sprite|logo|icon|avatar|loading|placeholder|search|wangwang|aliyun|tps-\d{1,3}-\d{1,3}/i.test(url)) return false;
  if (/alicdn\.com\/imgextra/i.test(url)) return true;
  const dimensions = [...url.matchAll(/(?:^|[^\d])(\d{2,4})[x_-](\d{2,4})(?:[^\d]|$)/g)];
  return dimensions.some((match) => Number(match[1]) >= 300 && Number(match[2]) >= 300);
}

function candidateProductUrls(parsed) {
  const urls = [parsed.toString()];
  const offerId = parsed.pathname.match(/\/offer\/(\d+)\.html/i)?.[1] || parsed.searchParams.get('offerId');
  if (offerId) urls.push(`https://m.1688.com/offer/${offerId}.html`);
  return [...new Set(urls)];
}

app.get('/api/extract-image', async (req, res) => {
  const target = String(req.query.url || '').trim();
  if (!target) return res.status(400).json({ error: '请先填写1688链接' });

  let parsed = null;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: '1688链接格式不正确' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: '仅支持HTTP链接' });
  }

  try {
    for (const candidate of candidateProductUrls(parsed)) {
      const isMobile = candidate.includes('m.1688.com');
      const response = await fetch(candidate, {
        headers: {
          'User-Agent': isMobile
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const html = await response.text();
      const image = extractFirstImage(html, candidate);
      if (image) return res.json({ image, source: candidate });
    }
    return res.status(404).json({ error: '未抓取到产品图片' });
  } catch (error) {
    res.status(502).json({ error: '抓取1688图片失败' });
  }
});

app.get('/api/image-proxy', async (req, res) => {
  const target = String(req.query.url || '').trim();
  let parsed = null;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).send('图片链接格式不正确');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).send('仅支持HTTP图片');
  }

  try {
    const response = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        Referer: 'https://m.1688.com/',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) return res.status(response.status).send('图片加载失败');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (error) {
    res.status(502).send('图片加载失败');
  }
});

app.get('/api/submissions', async (req, res) => {
  const user = await getCurrentUser(req);
  const search = String(req.query.search || '').trim().toLowerCase();
  const status = String(req.query.status || 'all').trim();
  const rows = await readSubmissions();
  if (user) {
    let changed = false;
    for (const row of rows) {
      if (!row.submitter_name || row.submitter_name === '链接刊登模块') {
        row.submitter_name = user.name;
        changed = true;
      }
    }
    if (changed) await writeSubmissions(rows);
  }
  let filtered = rows;

  if (status !== 'all' && statusByKey[status]) {
    filtered = filtered.filter((row) => normalizeStatus(row.sample_status) === statusByKey[status]);
  }

  if (search) {
    filtered = filtered.filter((row) => [
      row.product_name,
      row.product_keywords,
      row.lister,
      row.brand,
      row.store_name,
      row.product_note,
      row.source_url,
      row.variant_name,
    ].some((value) => String(value || '').toLowerCase().includes(search)));
  }

  res.json({
    summary: summarize(rows),
    submissions: filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 300),
  });
});

app.post('/api/submissions', async (req, res) => {
  const user = await getCurrentUser(req);
  const payload = {};
  for (const field of submissionFields) {
    payload[field] = String(req.body[field] || '').trim();
  }

  payload.sample_status = normalizeStatus(payload.sample_status);
  if (!payload.product_keywords) return res.status(400).json({ error: '请输入产品关键词' });
  if (!payload.brand) return res.status(400).json({ error: '请输入品牌' });
  if (!payload.store_name) return res.status(400).json({ error: '请输入上架店铺' });

  const rows = await readSubmissions();
  const now = new Date().toISOString();
  const row = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1,
    ...payload,
    submitter_name: String(user?.name || req.body.submitter_name || '').trim() || '链接刊登模块',
    review_note: '',
    created_at: now,
    updated_at: now,
  };
  rows.push(row);
  await writeSubmissions(rows);
  res.json({ ok: true, submission: row });
});

app.patch('/api/submissions/:id', async (req, res) => {
  const user = await getCurrentUser(req);
  const id = Number(req.params.id);
  const rows = await readSubmissions();
  const row = rows.find((item) => Number(item.id) === id);
  if (!row) return res.status(404).json({ error: '链接刊登记录不存在' });

  const editableFields = submissionFields;
  for (const field of editableFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      row[field] = String(req.body[field] || '').trim();
    }
  }
  if (user && (!row.submitter_name || row.submitter_name === '链接刊登模块')) {
    row.submitter_name = user.name;
  }

  row.sample_status = normalizeStatus(row.sample_status);
  if (!row.product_keywords) return res.status(400).json({ error: '请输入产品关键词' });
  if (!row.brand) return res.status(400).json({ error: '请输入品牌' });
  if (!row.store_name) return res.status(400).json({ error: '请输入上架店铺' });

  row.updated_at = new Date().toISOString();
  await writeSubmissions(rows);
  res.json({ ok: true, submission: row });
});

app.patch('/api/submissions/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const rows = await readSubmissions();
  const row = rows.find((item) => Number(item.id) === id);
  if (!row) return res.status(404).json({ error: '链接刊登记录不存在' });

  row.sample_status = normalizeStatus(req.body.sample_status);
  row.review_note = String(req.body.review_note || '').trim();
  row.reviewed_at = new Date().toISOString();
  row.updated_at = row.reviewed_at;
  await writeSubmissions(rows);
  res.json({ ok: true, submission: row });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PRODUCT_TEST_PORT || process.env.PORT || 3011);
  const standalone = express();
  standalone.use('/', app);
  standalone.listen(port, '127.0.0.1', () => {
    console.log(`Product test system running at http://127.0.0.1:${port}`);
  });
}
