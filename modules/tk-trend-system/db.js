const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.TK_TREND_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'tk-trend.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS trend_products (
    product_id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    shop_id TEXT DEFAULT '',
    shop_name TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trend_rank_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ranking_type TEXT NOT NULL,
    begin_time INTEGER NOT NULL DEFAULT 0,
    end_time INTEGER NOT NULL DEFAULT 0,
    category_key TEXT NOT NULL DEFAULT 'all',
    product_id TEXT NOT NULL REFERENCES trend_products(product_id) ON DELETE CASCADE,
    rank_number INTEGER,
    rank_change INTEGER,
    product_score REAL,
    review_count INTEGER,
    price_min_value REAL,
    price_min_display TEXT DEFAULT '',
    price_max_value REAL,
    price_max_display TEXT DEFAULT '',
    gmv_min_value REAL,
    gmv_min_display TEXT DEFAULT '',
    gmv_max_value REAL,
    gmv_max_display TEXT DEFAULT '',
    click_min_value REAL,
    click_min_display TEXT DEFAULT '',
    click_max_value REAL,
    click_max_display TEXT DEFAULT '',
    ctr_min_value REAL,
    ctr_min_display TEXT DEFAULT '',
    ctr_max_value REAL,
    ctr_max_display TEXT DEFAULT '',
    similar_count INTEGER,
    similar_display TEXT DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ranking_type, begin_time, end_time, category_key, product_id)
  );
  CREATE TABLE IF NOT EXISTS trend_favorites (
    product_id TEXT PRIMARY KEY REFERENCES trend_products(product_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trend_selection_pool (
    product_id TEXT PRIMARY KEY REFERENCES trend_products(product_id) ON DELETE CASCADE,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trend_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ranking_type TEXT NOT NULL,
    source TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    message TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function scalarValue(field) {
  if (field == null) return null;
  if (typeof field === 'number') return field;
  const value = field.value ?? field.min_value?.value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayValue(field) {
  if (field == null) return '';
  return String(field.display ?? field.min_value?.display ?? '');
}

function importResponse(payload, options = {}) {
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows)) throw new Error('响应中缺少 data.rows');
  const rankingType = options.rankingType || 'overall';
  const beginTime = Number(options.beginTime || 0);
  const endTime = Number(options.endTime || 0);
  const categoryKey = String(options.categoryKey || 'all');
  const upsertProduct = db.prepare(`INSERT INTO trend_products
    (product_id, product_name, image_url, shop_id, shop_name, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET product_name=excluded.product_name,
      image_url=excluded.image_url, shop_id=excluded.shop_id, shop_name=excluded.shop_name,
      updated_at=CURRENT_TIMESTAMP`);
  const upsertSnapshot = db.prepare(`INSERT INTO trend_rank_snapshots
    (ranking_type, begin_time, end_time, category_key, product_id, rank_number, rank_change,
     product_score, review_count, price_min_value, price_min_display, price_max_value,
     price_max_display, gmv_min_value, gmv_min_display, gmv_max_value, gmv_max_display,
     click_min_value, click_min_display, click_max_value, click_max_display, ctr_min_value,
     ctr_min_display, ctr_max_value, ctr_max_display, similar_count, similar_display)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ranking_type, begin_time, end_time, category_key, product_id) DO UPDATE SET
      rank_number=excluded.rank_number, rank_change=excluded.rank_change,
      product_score=excluded.product_score, review_count=excluded.review_count,
      price_min_value=excluded.price_min_value, price_min_display=excluded.price_min_display,
      price_max_value=excluded.price_max_value, price_max_display=excluded.price_max_display,
      gmv_min_value=excluded.gmv_min_value, gmv_min_display=excluded.gmv_min_display,
      gmv_max_value=excluded.gmv_max_value, gmv_max_display=excluded.gmv_max_display,
      click_min_value=excluded.click_min_value, click_min_display=excluded.click_min_display,
      click_max_value=excluded.click_max_value, click_max_display=excluded.click_max_display,
      ctr_min_value=excluded.ctr_min_value, ctr_min_display=excluded.ctr_min_display,
      ctr_max_value=excluded.ctr_max_value, ctr_max_display=excluded.ctr_max_display,
      similar_count=excluded.similar_count, similar_display=excluded.similar_display,
      imported_at=CURRENT_TIMESTAMP`);
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const product = row.product_meta || {};
      const shop = row.shop_meta || {};
      const productId = String(product.product_id || row.unique_id || '');
      if (!productId) continue;
      const imageUrl = product.product_image?.thumb_url_list?.[0] || product.product_image?.url_list?.[0] || '';
      upsertProduct.run(productId, String(product.product_name || '未命名商品'), imageUrl,
        String(shop.shop_id || ''), String(shop.shop_name || ''));
      const min = key => row[key]?.min_value || row[key];
      const max = key => row[key]?.max_value || row[key];
      upsertSnapshot.run(rankingType, beginTime, endTime, categoryKey, productId,
        Number(row.product_rank?.rank_number || 0), Number(row.product_rank?.rank_change || 0),
        scalarValue(row.product_score), Number(row.product_review_cnt || 0),
        scalarValue(min('product_price')), displayValue(min('product_price')),
        scalarValue(max('product_price')), displayValue(max('product_price')),
        scalarValue(min('transac_amt')), displayValue(min('transac_amt')),
        scalarValue(max('transac_amt')), displayValue(max('transac_amt')),
        scalarValue(min('click_cnt')), displayValue(min('click_cnt')),
        scalarValue(max('click_cnt')), displayValue(max('click_cnt')),
        scalarValue(min('ctr')), displayValue(min('ctr')),
        scalarValue(max('ctr')), displayValue(max('ctr')),
        scalarValue(row.on_site_similar_cnt), displayValue(row.on_site_similar_cnt));
    }
    db.prepare(`INSERT INTO trend_sync_logs (ranking_type, source, row_count, status, message)
      VALUES (?, ?, ?, 'success', ?)`)
      .run(rankingType, options.source || 'manual-json', rows.length, `接口总数 ${payload.data?.pagination?.total_count ?? rows.length}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { imported: rows.length, total: payload.data?.pagination?.total_count ?? rows.length };
}

module.exports = { db, importResponse };
