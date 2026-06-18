const { tiktokRequest } = require('./tiktokApi');

function textOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value);
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return '';
}

function normalizeProduct(raw) {
  const sku = firstText(
    raw.seller_sku,
    raw.skus?.[0]?.seller_sku,
    raw.skus?.[0]?.sku_id,
    raw.product_id,
    raw.id
  );

  return {
    externalId: firstText(raw.product_id, raw.id),
    sku,
    name: firstText(raw.title, raw.name, sku),
    status: firstText(raw.status, raw.audit_status),
    imageUrl: firstText(raw.main_images?.[0]?.url, raw.images?.[0]?.url),
  };
}

function normalizeOrder(raw) {
  return {
    externalId: firstText(raw.order_id, raw.id),
    status: firstText(raw.status, raw.order_status),
    buyerName: firstText(raw.buyer_email, raw.recipient_address?.name, raw.user_id),
    currency: firstText(raw.payment?.currency, raw.currency),
    totalAmount: Number(raw.payment?.total_amount || raw.total_amount || raw.order_amount || 0),
    createdAt: firstText(raw.create_time, raw.created_time, raw.create_time_ms),
    updatedAt: firstText(raw.update_time, raw.updated_time, raw.update_time_ms),
    rawJson: JSON.stringify(raw),
  };
}

function ensureSyncSchema(db) {
  try { db.exec('ALTER TABLE products ADD COLUMN external_product_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN status TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN image_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN synced_at TEXT'); } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      status TEXT,
      buyer_name TEXT,
      currency TEXT,
      total_amount REAL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      synced_at TEXT,
      raw_json TEXT,
      UNIQUE(shop_id, external_order_id),
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
  `);
}

function upsertProduct(db, shopId, product) {
  const existing = product.externalId
    ? db.prepare('SELECT id FROM products WHERE shop_id = ? AND external_product_id = ?').get(shopId, product.externalId)
    : null;

  if (existing) {
    db.prepare(`
      UPDATE products
      SET sku = ?, name = ?, status = ?, image_url = ?, synced_at = datetime('now')
      WHERE id = ?
    `).run(product.sku, product.name, product.status, product.imageUrl, existing.id);
    return 'updated';
  }

  const bySku = product.sku
    ? db.prepare('SELECT id FROM products WHERE shop_id = ? AND sku = ?').get(shopId, product.sku)
    : null;

  if (bySku) {
    db.prepare(`
      UPDATE products
      SET external_product_id = ?, name = ?, status = ?, image_url = ?, synced_at = datetime('now')
      WHERE id = ?
    `).run(product.externalId, product.name, product.status, product.imageUrl, bySku.id);
    return 'updated';
  }

  db.prepare(`
    INSERT INTO products (shop_id, external_product_id, sku, name, emoji, status, image_url, synced_at)
    VALUES (?, ?, ?, ?, '📦', ?, ?, datetime('now'))
  `).run(shopId, product.externalId, product.sku || product.externalId, product.name || product.sku, product.status, product.imageUrl);
  return 'created';
}

function upsertOrder(db, shopId, order) {
  if (!order.externalId) return 'skipped';
  db.prepare(`
    INSERT INTO orders (
      shop_id, external_order_id, status, buyer_name, currency, total_amount,
      created_at, updated_at, synced_at, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(shop_id, external_order_id) DO UPDATE SET
      status = excluded.status,
      buyer_name = excluded.buyer_name,
      currency = excluded.currency,
      total_amount = excluded.total_amount,
      updated_at = excluded.updated_at,
      synced_at = datetime('now'),
      raw_json = excluded.raw_json
  `).run(
    shopId,
    order.externalId,
    order.status,
    order.buyerName,
    order.currency,
    order.totalAmount,
    order.createdAt,
    order.updatedAt,
    order.rawJson
  );
  return 'upserted';
}

async function fetchPaged({ path, body, shop, listKeys }) {
  const items = [];
  let pageToken = '';

  do {
    const data = await tiktokRequest({
      path,
      method: 'POST',
      accessToken: shop.access_token,
      query: {
        shop_cipher: shop.shop_cipher,
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      body,
    });

    const list = listKeys.map((key) => data[key]).find(Array.isArray) || [];
    items.push(...list);
    pageToken = data.next_page_token || '';
  } while (pageToken);

  return items;
}

async function fetchAuthorizedShops(accessToken) {
  const data = await tiktokRequest({
    path: '/authorization/202309/shops',
    method: 'GET',
    accessToken,
    query: {},
    body: {},
  });
  return data.shops || data.shop_list || [];
}

function pickAuthorizedShop(localShop, authorizedShops) {
  if (!authorizedShops.length) return null;
  const localName = textOrEmpty(localShop.name).toLowerCase();
  return authorizedShops.find((shop) => {
    const remoteName = firstText(shop.shop_name, shop.name).toLowerCase();
    const remoteId = firstText(shop.shop_id, shop.id);
    return remoteName.includes(localName) || localName.includes(remoteName) || remoteId === localShop.shop_cipher;
  }) || (authorizedShops.length === 1 ? authorizedShops[0] : null);
}

async function ensureShopCipher(db, shop) {
  const authorizedShops = await fetchAuthorizedShops(shop.access_token);
  const authorizedShop = pickAuthorizedShop(shop, authorizedShops);
  if (!authorizedShop) {
    throw new Error('授权店铺列表中未找到当前店铺，请确认 OKUYOSHI 授权账号是否正确');
  }

  const shopCipher = firstText(authorizedShop.shop_cipher, authorizedShop.cipher, authorizedShop.shop_cipher_text);
  if (!shopCipher) {
    throw new Error('授权店铺接口未返回 shop_cipher');
  }

  if (shop.shop_cipher !== shopCipher) {
    db.prepare('UPDATE shops SET shop_cipher = ? WHERE id = ?').run(shopCipher, shop.id);
    shop.shop_cipher = shopCipher;
  }

  return shop;
}

async function syncProducts(db, shop) {
  const rows = await fetchPaged({
    path: '/product/202309/products/search',
    shop,
    body: {},
    listKeys: ['products', 'product_list'],
  });

  let created = 0;
  let updated = 0;
  for (const raw of rows) {
    const result = upsertProduct(db, shop.id, normalizeProduct(raw));
    if (result === 'created') created += 1;
    if (result === 'updated') updated += 1;
  }

  return { total: rows.length, created, updated };
}

async function syncOrders(db, shop) {
  const now = Math.floor(Date.now() / 1000);
  const days = Number(process.env.TK_ORDER_SYNC_DAYS || 7);
  const rows = await fetchPaged({
    path: '/order/202309/orders/search',
    shop,
    body: {
      create_time_ge: now - days * 24 * 60 * 60,
      create_time_lt: now,
    },
    listKeys: ['orders', 'order_list'],
  });

  let upserted = 0;
  for (const raw of rows) {
    if (upsertOrder(db, shop.id, normalizeOrder(raw)) === 'upserted') upserted += 1;
  }

  return { total: rows.length, upserted };
}

async function syncTikTokShop(db, shop) {
  ensureSyncSchema(db);
  await ensureShopCipher(db, shop);
  const products = await syncProducts(db, shop);
  const orders = await syncOrders(db, shop);
  return { products, orders };
}

module.exports = {
  ensureSyncSchema,
  syncTikTokShop,
};
