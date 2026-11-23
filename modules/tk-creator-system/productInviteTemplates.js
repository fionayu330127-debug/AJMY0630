'use strict';

function firstProductId(config = {}) {
  const ids = Array.isArray(config.product_ids)
    ? config.product_ids.map(Number).filter(Boolean)
    : String(config.product_ids || '').split(',').map(Number).filter(Boolean);
  return ids[0] || null;
}

function isGenericTemplate(row) {
  return Boolean(row) && !Number(row.product_id || 0);
}

function findProductInviteTemplate(db, {
  productId,
  parentTemplateId = null,
  type = 'collab',
  scene = null,
  language = null,
} = {}) {
  const pid = Number(productId || 0);
  if (!pid) return null;
  const rows = db.prepare(`
    SELECT * FROM invitation_templates
    WHERE active = 1 AND product_id = ? AND type = ?
    ORDER BY updated_at DESC, id DESC
  `).all(pid, type || 'collab');
  if (!rows.length) return null;
  let pool = rows;
  const parentId = Number(parentTemplateId || 0);
  if (parentId) {
    const byParent = pool.filter((row) => Number(row.parent_template_id || 0) === parentId);
    if (byParent.length) pool = byParent;
  }
  if (scene) {
    const byScene = pool.filter((row) => row.scene === scene);
    if (byScene.length) pool = byScene;
  }
  if (language) {
    const byLang = pool.filter((row) => row.language === language);
    if (byLang.length) pool = byLang;
  }
  return pool[0] || null;
}

function loadTemplate(db, id) {
  const templateId = Number(id || 0);
  if (!templateId) return null;
  return db.prepare('SELECT * FROM invitation_templates WHERE id = ? AND active = 1').get(templateId) || null;
}

function resolveInviteTemplate(db, config = {}) {
  const stored = loadTemplate(db, config.template_id);
  const base = loadTemplate(db, config.base_template_id) || (isGenericTemplate(stored) ? stored : loadTemplate(db, stored?.parent_template_id)) || stored;
  const productTpl = findProductInviteTemplate(db, {
    productId: firstProductId(config),
    parentTemplateId: base?.id || null,
    type: base?.type || stored?.type || 'collab',
    scene: base?.scene || stored?.scene || null,
    language: base?.language || stored?.language || null,
  });
  const chosen = productTpl || stored || base;
  if (!chosen) return null;
  const custom = String(config.invite_message_content || '').trim();
  if (custom) return { ...chosen, content: custom, custom_content: true };
  return chosen;
}

function upsertProductInviteTemplate(db, {
  product,
  baseTemplate,
  content,
  shopIds,
  commissionRate = null,
  now,
} = {}) {
  const productId = Number(product?.id || 0);
  const text = String(content || '').trim();
  if (!productId || !text) throw new Error('保存产品邀约模版时需要产品和内容');
  const base = baseTemplate || {};
  const type = base.type || 'collab';
  const scene = base.scene || 'first_invite';
  const language = base.language || 'zh';
  const channel = base.channel || 'im';
  const parentId = Number(base.id || 0) || null;
  const name = String(product.name || '').trim() || `产品邀约模版 ${productId}`;
  const shops = shopIds != null ? shopIds : base.shop_ids;
  const shopJson = typeof shops === 'string' ? shops : JSON.stringify(shops || []);
  const existing = findProductInviteTemplate(db, {
    productId,
    parentTemplateId: parentId,
    type,
    scene,
    language,
  });
  const stamp = now || new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (existing) {
    const nextVersion = Number(existing.version || 1) + 1;
    db.prepare(`
      UPDATE invitation_templates
      SET name = ?, channel = ?, type = ?, scene = ?, shop_ids = ?, language = ?, version = ?, parent_template_id = ?, product_id = ?, content = ?, updated_at = ?
      WHERE id = ?
    `).run(name, channel, type, scene, shopJson, language, nextVersion, parentId, productId, text, stamp, existing.id);
    try {
      db.prepare('INSERT INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(existing.id, nextVersion, name, scene, shopJson, language, type, productId, text, commissionRate, stamp);
    } catch (_) {}
    if (commissionRate != null) {
      try { db.prepare('INSERT OR REPLACE INTO agent_template_terms (template_id, commission_rate, updated_at) VALUES (?, ?, ?)').run(existing.id, commissionRate, stamp); } catch (_) {}
    }
    return db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO invitation_templates (name, channel, type, scene, shop_ids, language, version, parent_template_id, product_id, content, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)
  `).run(name, channel, type, scene, shopJson, language, parentId, productId, text, stamp, stamp);
  const id = Number(result.lastInsertRowid);
  try {
    db.prepare('INSERT INTO invitation_template_versions (template_id, version, name, scene, shop_ids, language, type, product_id, content, commission_rate, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, scene, shopJson, language, type, productId, text, commissionRate, stamp);
  } catch (_) {}
  if (commissionRate != null) {
    try { db.prepare('INSERT OR REPLACE INTO agent_template_terms (template_id, commission_rate, updated_at) VALUES (?, ?, ?)').run(id, commissionRate, stamp); } catch (_) {}
  }
  return db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(id);
}

function applyProductTemplateOnSave(db, config, { now, getProduct } = {}) {
  const next = { ...config };
  const saveFlag = Boolean(next.save_as_product_template);
  delete next.save_as_product_template;
  const content = String(next.invite_message_content || '').trim();
  const baseId = Number(next.base_template_id || (isGenericTemplate({ product_id: null, ...loadTemplate(db, next.template_id) }) ? next.template_id : 0) || next.template_id || 0) || null;
  next.base_template_id = baseId;
  const productId = firstProductId(next);
  const stamp = now || new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (saveFlag) {
    if (!productId) throw new Error('保存产品固定模版前请先选择产品');
    if (!content) throw new Error('保存产品固定模版前请填写邀约话术');
    const product = getProduct ? getProduct(productId) : db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error('未找到所选产品，无法保存产品邀约模版');
    const base = baseId ? db.prepare('SELECT * FROM invitation_templates WHERE id = ?').get(baseId) : null;
    const saved = upsertProductInviteTemplate(db, {
      product,
      baseTemplate: base,
      content,
      commissionRate: next.commission_rate === '' || next.commission_rate == null ? null : Number(next.commission_rate),
      now: stamp,
    });
    next.template_id = saved.id;
    next.product_template_id = saved.id;
    next.invite_message_content = content;
    return next;
  }
  const resolved = resolveInviteTemplate(db, { ...next, invite_message_content: '' });
  if (resolved && Number(resolved.product_id || 0)) {
    next.template_id = resolved.id;
    next.product_template_id = resolved.id;
  } else if (baseId) {
    next.template_id = Number(next.template_id || baseId);
  }
  if (content && resolved && content === String(resolved.content || '').trim()) {
    next.invite_message_content = '';
  } else {
    next.invite_message_content = content;
  }
  return next;
}

module.exports = {
  firstProductId,
  isGenericTemplate,
  findProductInviteTemplate,
  resolveInviteTemplate,
  upsertProductInviteTemplate,
  applyProductTemplateOnSave,
};
