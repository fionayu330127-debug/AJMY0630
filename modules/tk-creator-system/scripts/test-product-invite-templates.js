'use strict';

const { DatabaseSync } = require('node:sqlite');
const {
  findProductInviteTemplate,
  resolveInviteTemplate,
  upsertProductInviteTemplate,
  applyProductTemplateOnSave,
} = require('../productInviteTemplates');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE invitation_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'im',
      type TEXT NOT NULL DEFAULT 'dm',
      scene TEXT NOT NULL DEFAULT 'first_invite',
      shop_ids TEXT NOT NULL DEFAULT '[]',
      language TEXT NOT NULL DEFAULT 'zh',
      version INTEGER NOT NULL DEFAULT 1,
      parent_template_id INTEGER,
      product_id INTEGER,
      content TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT '2026-11-23 12:00:00',
      updated_at TEXT NOT NULL DEFAULT '2026-11-23 12:00:00'
    );
  `);
  db.prepare('INSERT INTO products (id, name) VALUES (36, ?), (9, ?)').run('搅拌杯', '餐盒');
  db.prepare(`
    INSERT INTO invitation_templates (id, name, type, scene, language, content, product_id)
    VALUES (1, '样品合作邀约', 'collab', 'first_invite', 'ja', '通用：{{product_name}}のサンプルをご用意しております。', NULL)
  `).run();
  return db;
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`fail  ${name}: ${error.message}`);
  }
}

test('generic template is used when the product has no fixed copy', () => {
  const db = createDb();
  const resolved = resolveInviteTemplate(db, { template_id: 1, base_template_id: 1, product_ids: [36] });
  if (!resolved || resolved.id !== 1) throw new Error('expected generic template');
  if (!String(resolved.content).includes('通用')) throw new Error('expected generic content');
});

test('saving a task can create a product template named after the product', () => {
  const db = createDb();
  const config = applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯专属：{{product_name}} のサンプルをご用意しております。今回は新色です。',
    save_as_product_template: true,
    commission_rate: 15,
  }, { now: '2026-11-23 14:00:00' });
  if (!config.product_template_id) throw new Error('expected product template id');
  const row = findProductInviteTemplate(db, { productId: 36, parentTemplateId: 1, type: 'collab' });
  if (!row || row.name !== '搅拌杯') throw new Error(`expected product name as template name, got ${row && row.name}`);
  if (!row.content.includes('新色')) throw new Error('expected custom content to be saved');
  if (config.save_as_product_template) throw new Error('one-shot flag should not be stored');
});

test('later tasks auto-resolve the product template', () => {
  const db = createDb();
  applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯固定话术',
    save_as_product_template: true,
  }, { now: '2026-11-23 14:00:00' });
  const resolved = resolveInviteTemplate(db, { template_id: 1, base_template_id: 1, product_ids: [36] });
  if (!resolved || resolved.name !== '搅拌杯' || resolved.content !== '搅拌杯固定话术') {
    throw new Error(`expected product template, got ${JSON.stringify(resolved)}`);
  }
});

test('custom text on one task does not overwrite the product template unless asked', () => {
  const db = createDb();
  applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯固定话术',
    save_as_product_template: true,
  }, { now: '2026-11-23 14:00:00' });
  const task = applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '仅本次加一句限时活动',
    save_as_product_template: false,
  }, { now: '2026-11-23 15:00:00' });
  if (task.invite_message_content !== '仅本次加一句限时活动') throw new Error('expected this task to keep custom text');
  const stored = findProductInviteTemplate(db, { productId: 36, parentTemplateId: 1, type: 'collab' });
  if (stored.content !== '搅拌杯固定话术') throw new Error('product template should stay unchanged');
  const sent = resolveInviteTemplate(db, task);
  if (sent.content !== '仅本次加一句限时活动') throw new Error('send path should use this task custom text');
});

test('unchanged product copy is not pinned on the task', () => {
  const db = createDb();
  applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯固定话术',
    save_as_product_template: true,
  }, { now: '2026-11-23 14:00:00' });
  const task = applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯固定话术',
    save_as_product_template: false,
  }, { now: '2026-11-23 15:00:00' });
  if (task.invite_message_content) throw new Error('matching copy should not be pinned');
  upsertProductInviteTemplate(db, {
    product: { id: 36, name: '搅拌杯' },
    baseTemplate: db.prepare('SELECT * FROM invitation_templates WHERE id = 1').get(),
    content: '更新后的固定话术',
    now: '2026-11-23 16:00:00',
  });
  const sent = resolveInviteTemplate(db, task);
  if (sent.content !== '更新后的固定话术') throw new Error('unpinned task should follow later product template edits');
});

test('different products keep separate templates', () => {
  const db = createDb();
  applyProductTemplateOnSave(db, {
    template_id: 1,
    base_template_id: 1,
    product_ids: [36],
    invite_message_content: '搅拌杯话术',
    save_as_product_template: true,
  }, { now: '2026-11-23 14:00:00' });
  const box = resolveInviteTemplate(db, { template_id: 1, base_template_id: 1, product_ids: [9] });
  if (box.content !== '通用：{{product_name}}のサンプルをご用意しております。') throw new Error('other product should still use the generic template');
});

const failed = results.filter((row) => !row.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
