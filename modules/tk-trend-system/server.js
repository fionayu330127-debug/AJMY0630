const path = require('node:path');
const express = require('express');
const { db, importResponse } = require('./db');

const app = express.Router();
const publicDir = path.join(__dirname, 'public');
app.use(express.json({ limit: '30mb' }));
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin') || '';
  if (origin.startsWith('chrome-extension://') || origin.startsWith('edge-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/rankings', (req, res) => {
  const type = String(req.query.type || 'overall');
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
  const keyword = String(req.query.keyword || '').trim();
  const similar = Math.max(0, Number(req.query.similar || 0));
  const where = [`s.ranking_type = ?`, `s.id IN (SELECT MAX(id) FROM trend_rank_snapshots GROUP BY ranking_type, product_id)`];
  const params = [type];
  if (keyword) { where.push(`(p.product_name LIKE ? OR p.shop_name LIKE ? OR p.product_id LIKE ?)`); params.push(...Array(3).fill(`%${keyword}%`)); }
  if (similar) { where.push(`COALESCE(s.similar_count, 0) >= ?`); params.push(similar); }
  const clause = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) count FROM trend_rank_snapshots s JOIN trend_products p ON p.product_id=s.product_id WHERE ${clause}`).get(...params).count;
  const rows = db.prepare(`SELECT s.*, p.product_name, p.image_url, p.shop_name,
      EXISTS(SELECT 1 FROM trend_favorites f WHERE f.product_id=p.product_id) favorite,
      EXISTS(SELECT 1 FROM trend_selection_pool q WHERE q.product_id=p.product_id) in_pool
    FROM trend_rank_snapshots s JOIN trend_products p ON p.product_id=s.product_id
    WHERE ${clause} ORDER BY s.rank_number ASC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ rows, pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
});

app.get('/api/meta', (req, res) => {
  const logs = db.prepare('SELECT * FROM trend_sync_logs ORDER BY id DESC LIMIT 20').all();
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM trend_products) products,
    (SELECT COUNT(*) FROM trend_favorites) favorites,
    (SELECT COUNT(*) FROM trend_selection_pool) pool`).get();
  res.json({ counts, logs });
});

app.post('/api/import', (req, res) => {
  try {
    const { response, rankingType, beginTime, endTime, categoryKey } = req.body || {};
    const result = importResponse(response, { rankingType, beginTime, endTime, categoryKey, source: 'manual-json' });
    res.json({ ok: true, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/import-pages', (req, res) => {
  try {
    const { pages, rankingType, beginTime, endTime, categoryKey } = req.body || {};
    if (!Array.isArray(pages) || !pages.length) throw new Error('缺少分页响应');
    let imported = 0;
    let total = 0;
    for (const response of pages) {
      const result = importResponse(response, {
        rankingType, beginTime, endTime, categoryKey, source: 'browser-extension',
      });
      imported += result.imported;
      total = Math.max(total, result.total);
    }
    res.json({ ok: true, imported, total, pages: pages.length });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

for (const [route, table] of [['favorite', 'trend_favorites'], ['selection', 'trend_selection_pool']]) {
  app.post(`/api/${route}/:productId`, (req, res) => {
    const id = String(req.params.productId);
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE product_id=?`).get(id);
    if (exists) db.prepare(`DELETE FROM ${table} WHERE product_id=?`).run(id);
    else db.prepare(`INSERT INTO ${table} (product_id) VALUES (?)`).run(id);
    res.json({ ok: true, active: !exists });
  });
}

app.use(express.static(publicDir, { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
module.exports = app;
