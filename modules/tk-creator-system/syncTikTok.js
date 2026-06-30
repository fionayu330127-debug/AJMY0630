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

function firstImageUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^https?:\/\//i.test(text)) return text;
      continue;
    }
    if (Array.isArray(value)) {
      const nested = firstImageUrl(...value);
      if (nested) return nested;
    } else if (typeof value === 'object') {
      const nested = firstImageUrl(
        value.url,
        value.image_url,
        value.imageUrl,
        value.thumb_url,
        value.thumbUrl,
        value.thumbnail_url,
        value.display_image,
        value.display_url,
        value.preview_image,
        value.main_image,
        value.url_list,
        value.urls,
        value.thumb_urls,
        value.image_urls,
        value.images,
        value.uri
      );
      if (nested) return nested;
    }
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
    imageUrl: firstImageUrl(
      raw.main_images,
      raw.images,
      raw.product_images,
      raw.product_images_info,
      raw.cover_image,
      raw.thumbnail,
      raw.thumbnails,
      raw.image,
      raw.image_url,
      raw.skus?.[0]?.image,
      raw.skus?.[0]?.image_url,
      raw.skus?.[0]?.sku_image,
      raw.skus?.[0]?.sku_image_url
    ),
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

function moneyAmount(value) {
  if (!value || typeof value !== 'object') return 0;
  const num = Number(value.amount || 0);
  return Number.isFinite(num) ? num : 0;
}

function moneyCurrency(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && value.currency) return String(value.currency);
  }
  return '';
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return '';
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    const ms = num > 100000000000 ? num : num * 1000;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(value);
}

function unwrapCreatorPayload(raw) {
  return raw.creator || raw.creator_info || raw.marketplace_creator || raw.influencer || raw.user || raw.data || raw;
}

function normalizeAffiliateCreator(raw) {
  const creator = unwrapCreatorPayload(raw);
  const profile = raw.profile || raw.creator_profile || raw.performance || raw.metrics || raw.data || {};
  const uid = firstText(
    raw.creator_user_open_id,
    raw.creator_open_id,
    raw.open_id,
    raw.creator_id,
    raw.user_id,
    creator.creator_user_open_id,
    creator.creator_open_id,
    creator.open_id,
    creator.creator_id,
    creator.user_id,
    creator.id
  );
  const handle = firstText(
    raw.creator_handle,
    raw.handle,
    raw.username,
    raw.creator_username,
    creator.handle,
    creator.username,
    creator.creator_username,
    profile.username
  );
  const gmv = raw.gmv_30d || raw.gmv || raw.sales_amount_30d || creator.gmv_30d || creator.gmv || {};
  return {
    uid: uid || handle,
    creatorOpenId: firstText(raw.creator_open_id, creator.creator_open_id, uid),
    creatorName: firstText(raw.creator_name, raw.nickname, raw.name, creator.nickname, creator.name, handle, uid),
    creatorHandle: handle,
    normalizedHandle: normalizeCreatorHandle(handle),
    avatarUrl: firstImageUrl(raw.avatar_url, raw.creator_avatar_url, creator.avatar_url, creator.profile_image_url, creator.avatar, profile.avatar_url),
    fans: Number(firstText(raw.follower_count, raw.followers, creator.follower_count, creator.followers, profile.follower_count, 0)) || 0,
    category: firstText(raw.category, raw.category_name, raw.primary_category, creator.category, creator.category_name, profile.category),
    fulfillmentRate: normalizeNumber(firstText(raw.fulfillment_rate, raw.fulfillment_percentage, creator.fulfillment_rate, creator.fulfillment_percentage)),
    avgView: normalizeNumber(firstText(raw.avg_view, raw.average_view, raw.ec_video_view, creator.avg_view, creator.average_view, creator.ec_video_view)),
    salesCount30d: normalizeNumber(firstText(
      raw.sales_count_30d,
      raw.order_count_30d,
      raw.units_sold_30d,
      raw.sold_count_30d,
      raw.completed_order_count_30d,
      raw.units_sold,
      raw.units_sold_count,
      raw.items_sold,
      raw.product_sold_count,
      raw.sales_count,
      raw.sold_count,
      raw.order_count,
      raw.completed_order_count,
      creator.sales_count_30d,
      creator.order_count_30d,
      creator.units_sold_30d,
      creator.sold_count_30d,
      creator.completed_order_count_30d,
      creator.units_sold,
      creator.units_sold_count,
      creator.items_sold,
      creator.product_sold_count,
      creator.sales_count,
      creator.sold_count,
      creator.order_count,
      creator.completed_order_count,
      profile.sales_count_30d,
      profile.order_count_30d,
      profile.units_sold_30d,
      profile.sold_count_30d,
      profile.completed_order_count_30d,
      profile.units_sold,
      profile.sales_count,
      profile.sold_count,
      profile.order_count
    )),
    salesAmount30d: normalizeNumber(firstText(raw.sales_amount_30d, raw.gmv_30d?.amount, raw.gmv?.amount, creator.gmv_30d?.amount, creator.gmv?.amount, gmv.amount)),
    salesCurrency: firstText(raw.sales_currency, raw.gmv_30d?.currency, raw.gmv?.currency, creator.gmv_30d?.currency, creator.gmv?.currency, gmv.currency),
    rawJson: JSON.stringify(raw),
  };
}

function normalizeAffiliateOrder(raw) {
  const skus = Array.isArray(raw.skus) ? raw.skus : [];
  return skus.map((sku, index) => {
    const creatorUsername = normalizeCreatorHandle(sku.creator_username || sku.creator_user_name || sku.creator_handle);
    const salesAmount = moneyAmount(sku.estimated_commission_base) || moneyAmount(sku.price);
    const commissionAmount = moneyAmount(sku.actual_paid_commission) || moneyAmount(sku.estimated_paid_commission);
    const currency = moneyCurrency(
      sku.estimated_commission_base,
      sku.price,
      sku.actual_paid_commission,
      sku.estimated_paid_commission
    );

    return {
      externalOrderId: firstText(raw.id, raw.order_id),
      lineKey: firstText(sku.sku_id, sku.product_id, sku.content_id, String(index)),
      creatorUsername,
      productId: firstText(sku.product_id),
      skuId: firstText(sku.sku_id),
      contentId: firstText(sku.content_id),
      contentType: firstText(sku.content_type),
      status: firstText(raw.status, sku.settlement_status),
      settlementStatus: firstText(sku.settlement_status),
      orderCreatedAt: normalizeTimestamp(raw.create_time),
      quantity: Number(sku.quantity || 0),
      salesAmount,
      commissionAmount,
      currency,
      rawJson: JSON.stringify({ order: raw, sku }),
    };
  }).filter((row) => row.externalOrderId && row.creatorUsername);
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeCreatorHandle(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function findExistingLibraryBd(db, uid, handle) {
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

function normalizeSampleApplication(raw) {
  const creator = raw.creator || raw.creator_info || raw.influencer || raw.user || {};
  const product = raw.product || raw.product_info || raw.sample_product || {};
  const externalId = firstText(
    raw.sample_application_id,
    raw.application_id,
    raw.sample_request_id,
    raw.request_id,
    raw.id
  );
  const creatorId = firstText(
    raw.creator_id,
    raw.open_id,
    raw.user_id,
    creator.creator_open_id,
    creator.creator_id,
    creator.open_id,
    creator.user_id,
    creator.id
  );

  return {
    externalId,
    uid: creatorId || externalId,
    creatorName: firstText(raw.creator_name, raw.nickname, creator.nickname, creator.name, creator.username, creatorId, externalId),
    creatorHandle: firstText(raw.creator_handle, raw.handle, creator.handle, creator.username),
    creatorAvatarUrl: firstImageUrl(
      raw.creator_avatar_url,
      raw.avatar_url,
      raw.profile_image_url,
      raw.creator_avatar,
      creator.avatar_url,
      creator.profile_image_url,
      creator.avatar,
      creator.image
    ),
    fans: Number(raw.follower_count || raw.followers || creator.follower_count || creator.followers || 0),
    category: firstText(raw.category, raw.category_name, product.category_name),
    collabType: normalizeCollabType(raw),
    status: mapSampleStatus(firstText(raw.status, raw.application_status, raw.sample_status, raw.request_status)),
    externalProductId: firstText(raw.product_id, product.product_id, product.id),
    appliedAt: normalizeTimestamp(firstText(raw.apply_time, raw.applied_at, raw.create_time, raw.created_time)),
    productName: firstText(raw.product_name, raw.product_title, product.title, product.sku_name, product.name),
    productSku: firstText(raw.seller_sku, raw.sku_id, product.seller_sku, product.sku_id),
    productImageUrl: firstImageUrl(
      raw.product_image_url,
      raw.product_images,
      raw.main_images,
      raw.image_url,
      product.sku_image_url,
      product.image_url,
      product.main_images,
      product.images,
      product.cover_image,
      product.thumbnail
    ),
    videos: Number(raw.video_count || raw.content_count || creator.content_count || creator.video_count || 0),
    avgView: firstText(raw.avg_view, raw.average_view, creator.ec_video_view, creator.avg_view, creator.average_view),
    fulfillmentRate: normalizeNumber(firstText(raw.fulfillment_rate, raw.fulfillment_percentage, creator.fulfillment_percentage)),
    salesAmount: normalizeNumber(firstText(raw.sales_amount, raw.gmv?.amount, creator.gmv?.amount)),
    salesCurrency: firstText(raw.sales_currency, raw.gmv?.currency, creator.gmv?.currency),
    salesCount: normalizeNumber(firstText(raw.sales_count, raw.units_sold, raw.sold_count, raw.order_count, raw.completed_order_count, creator.sales_count, creator.units_sold, creator.sold_count, creator.order_count)),
    commissionRate: normalizeNumber(firstText(raw.commission_rate, product.commission_rate)),
    approveExpirationAt: normalizeTimestamp(firstText(raw.approve_expiration_time, raw.expiration_time, raw.end_time, raw.deadline_time)),
    note: firstText(raw.note, raw.reason, raw.message),
    rawJson: JSON.stringify(raw),
  };
}

function normalizeCollabType(raw) {
  const text = firstText(
    raw.collab_type,
    raw.cooperation_type,
    raw.plan_type,
    raw.collaboration_type,
    raw.partner_name,
    raw.service_provider_name,
    raw.provider_name,
    raw.partner_id,
    raw.service_provider_id
  );
  const s = String(text || '').toLowerCase();
  if (!s) return '';
  if (s.includes('partner') || s.includes('service') || s.includes('provider') || s.includes('服务商')) return 'service_provider';
  if (s.includes('target') || s.includes('定向')) return 'targeted';
  if (s.includes('affiliate') || s.includes('联盟')) return 'affiliate';
  if (s.includes('open') || s.includes('公开')) return 'open';
  if (firstText(raw.partner_name, raw.service_provider_name, raw.provider_name, raw.partner_id, raw.service_provider_id)) {
    return 'service_provider';
  }
  return text;
}

function mapSampleStatus(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return 'pending';
  if (s.includes('cancel')) return s.includes('reject') ? 'rejected' : 'cancelled';
  if (['approved', 'approve', 'accepted', 'accept', 'pass', 'passed'].some((x) => s.includes(x))) return 'approved';
  if (['reject', 'rejected', 'declined', 'deny', 'denied'].some((x) => s.includes(x))) return 'rejected';
  if (s.includes('content_pending')) return 'shipped';
  if (['ship', 'shipped', 'sent'].some((x) => s.includes(x))) return 'shipped';
  if (['publish', 'published', 'posted', 'complete', 'completed'].some((x) => s.includes(x))) return 'published';
  if (s === 'unknown') return 'cancelled';
  return 'pending';
}

function ensureSyncSchema(db) {
  try { db.exec('ALTER TABLE products ADD COLUMN external_product_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN status TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN image_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN synced_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN external_sample_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN external_product_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN creator_avatar_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN fulfillment_rate REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN sales_amount REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN sales_currency TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN sales_count INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN commission_rate REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN approve_expiration_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN library_added_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN synced_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE samples ADD COLUMN raw_json TEXT'); } catch (_) {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_shop_external_sample ON samples(shop_id, external_sample_id) WHERE external_sample_id IS NOT NULL'); } catch (_) {}

  db.exec(`
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
  `);
  try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_count_30d INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_amount_30d REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN sales_currency TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE affiliate_creators ADD COLUMN normalized_handle TEXT'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_shop_sales ON affiliate_creators(shop_id, sales_count_30d)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_creators_handle ON affiliate_creators(normalized_handle)'); } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      line_key TEXT NOT NULL,
      creator_username TEXT NOT NULL,
      product_id TEXT,
      sku_id TEXT,
      content_id TEXT,
      content_type TEXT,
      status TEXT,
      settlement_status TEXT,
      order_created_at TEXT,
      quantity INTEGER DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0,
      currency TEXT,
      synced_at TEXT,
      raw_json TEXT,
      UNIQUE(shop_id, external_order_id, line_key, creator_username),
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliate_orders_creator ON affiliate_orders(shop_id, creator_username)'); } catch (_) {}

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

function upsertAffiliateCreator(db, shopId, item) {
  if (!item.uid) return 'skipped';
  db.prepare(`
    INSERT INTO affiliate_creators (
      shop_id, uid, creator_open_id, creator_name, creator_handle, normalized_handle,
      avatar_url, fans, category, fulfillment_rate, avg_view, sales_count_30d,
      sales_amount_30d, sales_currency, profile_json, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(shop_id, uid) DO UPDATE SET
      creator_open_id = COALESCE(NULLIF(excluded.creator_open_id, ''), affiliate_creators.creator_open_id),
      creator_name = COALESCE(NULLIF(excluded.creator_name, ''), affiliate_creators.creator_name),
      creator_handle = COALESCE(NULLIF(excluded.creator_handle, ''), affiliate_creators.creator_handle),
      normalized_handle = COALESCE(NULLIF(excluded.normalized_handle, ''), affiliate_creators.normalized_handle),
      avatar_url = COALESCE(NULLIF(excluded.avatar_url, ''), affiliate_creators.avatar_url),
      fans = excluded.fans,
      category = COALESCE(NULLIF(excluded.category, ''), affiliate_creators.category),
      fulfillment_rate = excluded.fulfillment_rate,
      avg_view = excluded.avg_view,
      sales_count_30d = excluded.sales_count_30d,
      sales_amount_30d = excluded.sales_amount_30d,
      sales_currency = COALESCE(NULLIF(excluded.sales_currency, ''), affiliate_creators.sales_currency),
      profile_json = excluded.profile_json,
      synced_at = datetime('now')
  `).run(
    shopId,
    item.uid,
    item.creatorOpenId,
    item.creatorName,
    item.creatorHandle,
    item.normalizedHandle,
    item.avatarUrl,
    item.fans,
    item.category,
    item.fulfillmentRate,
    item.avgView,
    item.salesCount30d,
    item.salesAmount30d,
    item.salesCurrency,
    item.rawJson
  );
  return 'upserted';
}

function upsertAffiliateOrder(db, shopId, item) {
  db.prepare(`
    INSERT INTO affiliate_orders (
      shop_id, external_order_id, line_key, creator_username, product_id, sku_id,
      content_id, content_type, status, settlement_status, order_created_at,
      quantity, sales_amount, commission_amount, currency, synced_at, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(shop_id, external_order_id, line_key, creator_username) DO UPDATE SET
      product_id = excluded.product_id,
      sku_id = excluded.sku_id,
      content_id = excluded.content_id,
      content_type = excluded.content_type,
      status = excluded.status,
      settlement_status = excluded.settlement_status,
      order_created_at = excluded.order_created_at,
      quantity = excluded.quantity,
      sales_amount = excluded.sales_amount,
      commission_amount = excluded.commission_amount,
      currency = excluded.currency,
      synced_at = datetime('now'),
      raw_json = excluded.raw_json
  `).run(
    shopId,
    item.externalOrderId,
    item.lineKey,
    item.creatorUsername,
    item.productId,
    item.skuId,
    item.contentId,
    item.contentType,
    item.status,
    item.settlementStatus,
    item.orderCreatedAt,
    item.quantity,
    item.salesAmount,
    item.commissionAmount,
    item.currency,
    item.rawJson
  );
}

function findProductId(db, shopId, externalProductId) {
  if (!externalProductId) return null;
  const row = db.prepare('SELECT id FROM products WHERE shop_id = ? AND external_product_id = ?').get(shopId, externalProductId);
  return row?.id || null;
}

function ensureSampleProduct(db, shopId, sample) {
  const existingId = findProductId(db, shopId, sample.externalProductId);
  if (existingId) {
    if (sample.productImageUrl || sample.productName || sample.productSku) {
      db.prepare(`
        UPDATE products
        SET
          image_url = COALESCE(NULLIF(?, ''), image_url),
          name = COALESCE(NULLIF(?, ''), name),
          sku = COALESCE(NULLIF(?, ''), sku)
        WHERE id = ?
      `).run(sample.productImageUrl, sample.productName, sample.productSku, existingId);
    }
    return existingId;
  }
  if (!sample.externalProductId && !sample.productName) return null;

  const sku = sample.productSku || sample.externalProductId || `sample-${Date.now()}`;
  const existingSku = db.prepare('SELECT id FROM products WHERE shop_id = ? AND sku = ?').get(shopId, sku);
  if (existingSku) {
    db.prepare(`
      UPDATE products
      SET
        external_product_id = COALESCE(NULLIF(?, ''), external_product_id),
        image_url = COALESCE(NULLIF(?, ''), image_url),
        name = COALESCE(NULLIF(?, ''), name)
      WHERE id = ?
    `).run(sample.externalProductId, sample.productImageUrl, sample.productName, existingSku.id);
    return existingSku.id;
  }

  const result = db.prepare(`
    INSERT INTO products (shop_id, external_product_id, sku, name, emoji, status, image_url, synced_at)
    VALUES (?, ?, ?, ?, '样', 'sample', ?, datetime('now'))
  `).run(shopId, sample.externalProductId, sku, sample.productName || sku, sample.productImageUrl);
  return Number(result.lastInsertRowid);
}

function upsertSampleApplication(db, shopId, sample) {
  if (!sample.externalId) return 'skipped';
  const productId = ensureSampleProduct(db, shopId, sample);
  const existing = db.prepare('SELECT id FROM samples WHERE shop_id = ? AND external_sample_id = ?').get(shopId, sample.externalId);
  const inheritedBdId = findExistingLibraryBd(db, sample.uid, sample.creatorHandle);

  if (existing) {
    db.prepare(`
      UPDATE samples
      SET uid = ?, creator_name = ?, creator_handle = ?, fans = ?, category = ?,
          collab_type = COALESCE(NULLIF(?, ''), collab_type),
          status = ?, bd_id = CASE
            WHEN ? IN ('pending', 'rejected', 'cancelled') THEN NULL
            WHEN bd_id IS NULL THEN ?
            ELSE bd_id
          END,
          library_added_at = CASE
            WHEN ? IN ('pending', 'assigned', 'rejected', 'cancelled') THEN NULL
            ELSE library_added_at
          END,
          product_id = COALESCE(?, product_id), external_product_id = ?, creator_avatar_url = ?,
          applied_at = COALESCE(NULLIF(?, ''), applied_at), videos = ?, avg_view = ?,
          fulfillment_rate = ?, sales_amount = ?, sales_currency = ?, sales_count = ?, commission_rate = ?, approve_expiration_at = ?,
          note = COALESCE(NULLIF(note, ''), ?), synced_at = datetime('now'), raw_json = ?
      WHERE id = ?
    `).run(
      sample.uid,
      sample.creatorName,
      sample.creatorHandle,
      sample.fans,
      sample.category,
      sample.collabType,
      sample.status,
      sample.status,
      inheritedBdId,
      sample.status,
      productId,
      sample.externalProductId,
      sample.creatorAvatarUrl,
      sample.appliedAt,
      sample.videos,
      sample.avgView,
      sample.fulfillmentRate,
      sample.salesAmount,
      sample.salesCurrency,
      sample.salesCount,
      sample.commissionRate,
      sample.approveExpirationAt,
      sample.note,
      sample.rawJson,
      existing.id
    );
    return 'updated';
  }

  const id = `tk_${sample.externalId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  db.prepare(`
    INSERT INTO samples (
      id, uid, shop_id, creator_name, creator_handle, fans, category, collab_type,
      status, bd_id, product_id, applied_at, videos, avg_view, note,
      external_sample_id, external_product_id, creator_avatar_url,
      fulfillment_rate, sales_amount, sales_currency, sales_count, commission_rate, approve_expiration_at,
      synced_at, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    id,
    sample.uid,
    shopId,
    sample.creatorName,
    sample.creatorHandle,
    sample.fans,
    sample.category,
    sample.collabType,
    sample.status,
    inheritedBdId || null,
    productId,
    sample.appliedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
    sample.videos,
    sample.avgView,
    sample.note,
    sample.externalId,
    sample.externalProductId,
    sample.creatorAvatarUrl,
    sample.fulfillmentRate,
    sample.salesAmount,
    sample.salesCurrency,
    sample.salesCount,
    sample.commissionRate,
    sample.approveExpirationAt,
    sample.rawJson
  );
  return 'created';
}

function upsertProduct(db, shopId, product) {
  const existing = product.externalId
    ? db.prepare('SELECT id FROM products WHERE shop_id = ? AND external_product_id = ?').get(shopId, product.externalId)
    : null;

  if (existing) {
    db.prepare(`
      UPDATE products
      SET sku = ?, name = ?, status = ?, image_url = COALESCE(NULLIF(?, ''), image_url), synced_at = datetime('now')
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
      SET external_product_id = ?, name = ?, status = ?, image_url = COALESCE(NULLIF(?, ''), image_url), synced_at = datetime('now')
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

function parseJsonEnv(name, fallback = {}) {
  const text = process.env[name];
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch (error) {
    throw new Error(`${name} 不是合法 JSON：${error.message}`);
  }
}

function listKeysFromEnv(name, fallback) {
  return String(process.env[name] || fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPaged({ path, body, shop, listKeys, pageSize = 50, maxPages = 0, pageDelayMs = 0 }) {
  const items = [];
  let pageToken = '';
  let searchKey = body?.search_key || '';
  let pageCount = 0;

  do {
    const requestBody = {
      ...(body || {}),
      ...(searchKey ? { search_key: searchKey } : {}),
    };
    const data = await tiktokRequest({
      path,
      method: 'POST',
      accessToken: shop.access_token,
      shopId: shop.id,
      query: {
        shop_cipher: shop.shop_cipher,
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      body: requestBody,
    });

    const list = listKeys.map((key) => data[key]).find(Array.isArray) || [];
    items.push(...list);
    searchKey = searchKey || data.search_key || '';
    pageToken = data.next_page_token || '';
    pageCount += 1;
    if (maxPages && pageCount >= maxPages) break;
    if (pageToken && pageDelayMs > 0) await sleep(pageDelayMs);
  } while (pageToken);

  return items;
}

async function fetchAuthorizedShops(accessToken, shopId) {
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
  const localName = textOrEmpty(localShop.name).toLowerCase();
  return authorizedShops.find((shop) => {
    const remoteName = firstText(shop.shop_name, shop.name).toLowerCase();
    const remoteId = firstText(shop.shop_id, shop.id);
    return remoteName.includes(localName) || localName.includes(remoteName) || remoteId === localShop.shop_cipher;
  }) || (authorizedShops.length === 1 ? authorizedShops[0] : null);
}

async function ensureShopCipher(db, shop) {
  const authorizedShops = await fetchAuthorizedShops(shop.access_token, shop.id);
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

async function syncMissingProductImages(db, shop, limit = 200) {
  const rows = db.prepare(`
    SELECT id, external_product_id
    FROM products
    WHERE shop_id = ?
      AND external_product_id IS NOT NULL
      AND external_product_id <> ''
      AND COALESCE(image_url, '') = ''
    ORDER BY id
    LIMIT ?
  `).all(shop.id, limit);

  let checked = 0;
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    checked += 1;
    try {
      const detail = await tiktokRequest({
        path: `/product/202309/products/${row.external_product_id}`,
        method: 'GET',
        query: { shop_cipher: shop.shop_cipher },
        body: {},
        accessToken: shop.access_token,
        shopId: shop.id,
      });
      const imageUrl = normalizeProduct(detail).imageUrl;
      if (imageUrl) {
        db.prepare('UPDATE products SET image_url = ?, synced_at = datetime(\'now\') WHERE id = ?').run(imageUrl, row.id);
        updated += 1;
      }
    } catch (_) {
      failed += 1;
    }
  }
  const missing = db.prepare("SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND COALESCE(image_url, '') = ''").get(shop.id).c;
  return { checked, updated, failed, missing };
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

async function fetchMarketplaceCreatorPerformance(shop, creatorUserId) {
  const detailPathTemplate = process.env.TK_AFFILIATE_CREATOR_PERFORMANCE_PATH || '';
  if (!detailPathTemplate || !creatorUserId) return null;
  const detailPath = detailPathTemplate.replace('{creator_user_id}', encodeURIComponent(creatorUserId));
  const data = await tiktokRequest({
    path: detailPath,
    method: 'GET',
    accessToken: shop.access_token,
    shopId: shop.id,
    query: { shop_cipher: shop.shop_cipher },
    body: {},
  });
  return data;
}

function mergeCreatorPerformance(base, detail) {
  if (!detail) return base;
  const detailCreator = unwrapCreatorPayload(detail);
  return {
    ...base,
    ...detail,
    creator_open_id: firstText(detail.creator_open_id, detailCreator.creator_open_id, detailCreator.creator_user_id, base.creator_open_id),
    creator_user_id: firstText(detail.creator_user_id, detailCreator.creator_user_id, detail.creator_open_id, base.creator_user_id, base.creator_open_id),
    username: firstText(detail.username, detailCreator.username, base.username),
    nickname: firstText(detail.nickname, detailCreator.nickname, base.nickname),
    follower_count: firstText(detail.follower_count, detailCreator.follower_count, base.follower_count),
    profile: detail.profile || detail.performance || detail.metrics || detailCreator,
  };
}

async function syncAffiliateCreators(db, shop) {
  const creatorPath = process.env.TK_AFFILIATE_CREATOR_POOL_PATH || '';
  if (!creatorPath) {
    return {
      status: 'unsupported',
      total: 0,
      upserted: 0,
      skipped: 0,
      with_sales_30d: 0,
      message: '未配置 TK_AFFILIATE_CREATOR_POOL_PATH，暂未同步联盟中心达人池',
    };
  }

  const rows = await fetchPaged({
    path: creatorPath,
    shop,
    body: parseJsonEnv('TK_AFFILIATE_CREATOR_POOL_BODY', {}),
    listKeys: listKeysFromEnv('TK_AFFILIATE_CREATOR_POOL_LIST_KEYS', 'creators,creator_list,influencers,influencer_list,users,list,data'),
    pageSize: Number(process.env.TK_AFFILIATE_CREATOR_POOL_PAGE_SIZE || 20),
    maxPages: Number(process.env.TK_AFFILIATE_CREATOR_POOL_MAX_PAGES || 5),
    pageDelayMs: Number(process.env.TK_AFFILIATE_CREATOR_POOL_PAGE_DELAY_MS || 800),
  });

  let upserted = 0;
  let skipped = 0;
  let withSales30d = 0;
  let performanceFetched = 0;
  let performanceFailed = 0;
  const detailLimit = Number(process.env.TK_AFFILIATE_CREATOR_PERFORMANCE_LIMIT || rows.length);
  const detailDelayMs = Number(process.env.TK_AFFILIATE_CREATOR_PERFORMANCE_DELAY_MS || 500);
  for (const raw of rows) {
    let merged = raw;
    const base = normalizeAffiliateCreator(raw);
    const creatorUserId = firstText(raw.creator_user_id, raw.creator_open_id, raw.creator_id, base.creatorOpenId, base.uid);
    if (process.env.TK_AFFILIATE_CREATOR_PERFORMANCE_PATH && performanceFetched < detailLimit && creatorUserId) {
      try {
        const detail = await fetchMarketplaceCreatorPerformance(shop, creatorUserId);
        performanceFetched += 1;
        merged = mergeCreatorPerformance(raw, detail);
        if (detailDelayMs > 0) await sleep(detailDelayMs);
      } catch (_) {
        performanceFailed += 1;
      }
    }
    const item = normalizeAffiliateCreator(merged);
    if (item.salesCount30d !== null && item.salesCount30d !== undefined) withSales30d += 1;
    const result = upsertAffiliateCreator(db, shop.id, item);
    if (result === 'upserted') upserted += 1;
    if (result === 'skipped') skipped += 1;
  }

  return { status: 'success', total: rows.length, upserted, skipped, with_sales_30d: withSales30d, performance_fetched: performanceFetched, performance_failed: performanceFailed };
}

async function syncAffiliateOrders(db, shop) {
  const now = Math.floor(Date.now() / 1000);
  const days = Number(process.env.TK_AFFILIATE_ORDER_SYNC_DAYS || process.env.TK_ORDER_SYNC_DAYS || 90);
  const rows = await fetchPaged({
    path: process.env.TK_AFFILIATE_ORDER_SYNC_PATH || '/affiliate_seller/202410/orders/search',
    shop,
    body: {
      create_time_ge: now - days * 24 * 60 * 60,
      create_time_lt: now,
    },
    listKeys: ['orders'],
  });

  let lines = 0;
  let skipped = 0;
  for (const raw of rows) {
    const items = normalizeAffiliateOrder(raw);
    if (!items.length) {
      skipped += 1;
      continue;
    }
    for (const item of items) {
      upsertAffiliateOrder(db, shop.id, item);
      lines += 1;
    }
  }

  return { total: rows.length, lines, skipped };
}

async function syncSampleApplications(db, shop) {
  const samplePath = process.env.TK_SAMPLE_SYNC_PATH || '';
  if (!samplePath) {
    return {
      status: 'unsupported',
      total: 0,
      created: 0,
      updated: 0,
      message: 'TikTok Shop 样品申请 Open API 路径尚未配置，当前只同步商品和订单',
    };
  }

  const rows = await fetchPaged({
    path: samplePath,
    shop,
    body: {},
    listKeys: ['sample_applications', 'sample_requests', 'applications', 'requests', 'samples', 'list'],
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of rows) {
    const result = upsertSampleApplication(db, shop.id, normalizeSampleApplication(raw));
    if (result === 'created') created += 1;
    if (result === 'updated') updated += 1;
    if (result === 'skipped') skipped += 1;
  }

  return { status: 'success', total: rows.length, created, updated, skipped };
}

async function syncTikTokShop(db, shop) {
  ensureSyncSchema(db);
  await ensureShopCipher(db, shop);
  const products = await syncProducts(db, shop);
  const orders = await syncOrders(db, shop);
  const affiliateOrders = await syncAffiliateOrders(db, shop);
  const affiliateCreators = await syncAffiliateCreators(db, shop);
  const samples = await syncSampleApplications(db, shop);
  return { products, orders, affiliateOrders, affiliateCreators, samples };
}

module.exports = {
  ensureSyncSchema,
  syncAffiliateCreators,
  syncAffiliateOrders,
  syncMissingProductImages,
  syncProducts,
  syncTikTokShop,
};
