// db.js — 数据库初始化与操作封装
// 使用 Node.js 内置的 node:sqlite（Node 22+ 自带），不需要 npm install 任何数据库包，不需要编译。
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tk-creator.db'));
db.exec('PRAGMA journal_mode = WAL;');

// ──────────────────────────────────────────
// 建表
// ──────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  color     TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT,
  shop_cipher   TEXT
);

CREATE TABLE IF NOT EXISTS bd_members (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  email TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  sku   TEXT NOT NULL,
  name  TEXT NOT NULL,
  emoji TEXT DEFAULT '🧴',
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS samples (
  id            TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  shop_id       TEXT NOT NULL,
  creator_name  TEXT NOT NULL,
  creator_handle TEXT,
  fans          INTEGER DEFAULT 0,
  category      TEXT,
  collab_type   TEXT DEFAULT '',
  status        TEXT DEFAULT 'pending',
  bd_id         INTEGER,
  product_id    INTEGER,
  applied_at    TEXT,
  videos        INTEGER DEFAULT 0,
  avg_view      TEXT,
  note          TEXT DEFAULT '',
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (bd_id) REFERENCES bd_members(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS creator_library (
  uid   TEXT PRIMARY KEY,
  star  INTEGER DEFAULT 0,
  note  TEXT DEFAULT ''
);
`);

// ──────────────────────────────────────────
// 初始数据填充（仅首次运行时）
// ──────────────────────────────────────────
const shopCount = db.prepare('SELECT COUNT(*) AS c FROM shops').get().c;

if (shopCount === 0) {
  console.log('📦 首次运行，正在写入初始演示数据…');

  db.prepare(`INSERT INTO shops (id, name, color) VALUES (?, ?, ?)`).run('oku', 'OKUYOSHI', '#0072c6');
  db.prepare(`INSERT INTO shops (id, name, color) VALUES (?, ?, ?)`).run('mir', 'MIR HOME', '#1a7a3a');

  const insertBD = db.prepare(`INSERT INTO bd_members (name) VALUES (?)`);
  const bdIds = {};
  bdIds['小林'] = Number(insertBD.run('小林 Kobayashi').lastInsertRowid);
  bdIds['田中'] = Number(insertBD.run('田中 Tanaka').lastInsertRowid);
  bdIds['佐藤'] = Number(insertBD.run('佐藤 Sato').lastInsertRowid);
  bdIds['山本'] = Number(insertBD.run('山本 Yamamoto').lastInsertRowid);

  const insertProduct = db.prepare(`INSERT INTO products (shop_id, sku, name, emoji) VALUES (?, ?, ?, ?)`);
  const okuProducts = [
    ['UV-SPF50-01', 'ナチュラルUVクリーム SPF50', '🧴'],
    ['HS-30ML-02', 'ヒアルロン酸美容液 30ml', '💧'],
    ['CM-5PCS-03', 'コラーゲンマスク 5枚入り', '🎭'],
    ['VC-WH-04', 'ビタミンC美白クリーム', '✨'],
  ];
  const mirProducts = [
    ['BD-SET-01', 'バスディフューザーセット', '🛁'],
    ['CL-120-02', 'キャンドルL 120ml', '🕯️'],
    ['PL-WT-03', 'プランター ホワイト', '🌿'],
    ['KT-ORG-04', 'キッチンオーガナイザー', '🧺'],
  ];
  const okuProductIds = okuProducts.map(p => Number(insertProduct.run('oku', ...p).lastInsertRowid));
  const mirProductIds = mirProducts.map(p => Number(insertProduct.run('mir', ...p).lastInsertRowid));

  const insertSample = db.prepare(`
    INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, fans, category, collab_type, status, bd_id, product_id, applied_at, videos, avg_view, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const samples = [
    { id:'s01', uid:'u1001', shop_id:'oku', creator_name:'桜 美容', creator_handle:'@sakura_beauty', fans:1284000, category:'美妆', collab_type:'open', status:'pending', bd_id:null, product_id:okuProductIds[0], applied_at:'2026-06-15 14:23', videos:45, avg_view:'12.3万', note:'' },
    { id:'s02', uid:'u1002', shop_id:'oku', creator_name:'東京ガール', creator_handle:'@tokyofashion', fans:872000, category:'时尚', collab_type:'targeted', status:'assigned', bd_id:bdIds['小林'], product_id:okuProductIds[1], applied_at:'2026-06-15 11:08', videos:89, avg_view:'8.7万', note:'' },
    { id:'s03', uid:'u1003', shop_id:'oku', creator_name:'ゆみ スキンケア', creator_handle:'@yumi_skin', fans:561000, category:'护肤', collab_type:'affiliate', status:'shipped', bd_id:bdIds['田中'], product_id:okuProductIds[2], applied_at:'2026-06-14 18:45', videos:123, avg_view:'5.4万', note:'已确认地址，等待发货' },
    { id:'s04', uid:'u1004', shop_id:'oku', creator_name:'原宿スタイル', creator_handle:'@harajuku_st', fans:2346000, category:'时尚', collab_type:'', status:'pending', bd_id:null, product_id:okuProductIds[3], applied_at:'2026-06-14 09:12', videos:67, avg_view:'21.5万', note:'' },
    { id:'s05', uid:'u1005', shop_id:'oku', creator_name:'ナチュラルケア', creator_handle:'@natural_care', fans:1953000, category:'护肤', collab_type:'targeted', status:'approved', bd_id:bdIds['佐藤'], product_id:okuProductIds[0], applied_at:'2026-06-13 08:55', videos:201, avg_view:'18.9万', note:'' },
    { id:'s06', uid:'u1006', shop_id:'oku', creator_name:'かわいいメイク', creator_handle:'@kawaii_mk', fans:715000, category:'美妆', collab_type:'affiliate', status:'published', bd_id:bdIds['山本'], product_id:okuProductIds[1], applied_at:'2026-06-12 20:14', videos:156, avg_view:'9.2万', note:'视频效果好，计划追加合作' },
    { id:'s07', uid:'u1007', shop_id:'oku', creator_name:'Jビューティ', creator_handle:'@jbeauty_rv', fans:339000, category:'护肤', collab_type:'', status:'pending', bd_id:null, product_id:okuProductIds[2], applied_at:'2026-06-12 14:07', videos:29, avg_view:'3.8万', note:'' },
    { id:'s08', uid:'u1008', shop_id:'oku', creator_name:'東京ライフ', creator_handle:'@tokyo_ls', fans:3121000, category:'生活', collab_type:'targeted', status:'assigned', bd_id:bdIds['小林'], product_id:okuProductIds[3], applied_at:'2026-06-11 11:22', videos:88, avg_view:'28.4万', note:'' },
    { id:'s09', uid:'u2001', shop_id:'mir', creator_name:'インテリア好き', creator_handle:'@interior_jp', fans:456000, category:'家居', collab_type:'open', status:'pending', bd_id:null, product_id:mirProductIds[0], applied_at:'2026-06-15 10:30', videos:38, avg_view:'4.2万', note:'' },
    { id:'s10', uid:'u2002', shop_id:'mir', creator_name:'ホームカフェ', creator_handle:'@homecafe_jp', fans:982000, category:'生活', collab_type:'targeted', status:'assigned', bd_id:bdIds['田中'], product_id:mirProductIds[1], applied_at:'2026-06-14 16:22', videos:72, avg_view:'9.8万', note:'沟通顺畅，已确认寄出' },
    { id:'s11', uid:'u2003', shop_id:'mir', creator_name:'ナチュラルライフ', creator_handle:'@nat_life', fans:234000, category:'家居', collab_type:'affiliate', status:'shipped', bd_id:bdIds['佐藤'], product_id:mirProductIds[2], applied_at:'2026-06-14 09:05', videos:55, avg_view:'2.9万', note:'' },
    { id:'s12', uid:'u2004', shop_id:'mir', creator_name:'ミニマリスト', creator_handle:'@minimalist', fans:1450000, category:'生活', collab_type:'open', status:'approved', bd_id:bdIds['山本'], product_id:mirProductIds[3], applied_at:'2026-06-13 14:20', videos:104, avg_view:'14.2万', note:'' },
    { id:'s13', uid:'u2005', shop_id:'mir', creator_name:'ガーデニング', creator_handle:'@garden_jp', fans:328000, category:'生活', collab_type:'', status:'pending', bd_id:null, product_id:mirProductIds[0], applied_at:'2026-06-12 11:00', videos:44, avg_view:'3.5万', note:'' },
    { id:'s14', uid:'u2006', shop_id:'mir', creator_name:'ルームツアー', creator_handle:'@roomtour_jp', fans:890000, category:'家居', collab_type:'affiliate', status:'published', bd_id:bdIds['小林'], product_id:mirProductIds[3], applied_at:'2026-06-10 09:00', videos:96, avg_view:'10.1万', note:'出单好，升级定向' },
    { id:'s15', uid:'u1003', shop_id:'mir', creator_name:'ゆみ スキンケア', creator_handle:'@yumi_skin', fans:561000, category:'护肤', collab_type:'open', status:'approved', bd_id:bdIds['田中'], product_id:mirProductIds[0], applied_at:'2026-06-10 10:00', videos:123, avg_view:'5.4万', note:'跨店合作' },
    { id:'s16', uid:'u1006', shop_id:'mir', creator_name:'かわいいメイク', creator_handle:'@kawaii_mk', fans:715000, category:'美妆', collab_type:'targeted', status:'shipped', bd_id:bdIds['山本'], product_id:mirProductIds[1], applied_at:'2026-06-11 08:30', videos:156, avg_view:'9.2万', note:'' },
  ];

  for (const s of samples) {
    insertSample.run(
      s.id, s.uid, s.shop_id, s.creator_name, s.creator_handle, s.fans, s.category,
      s.collab_type, s.status, s.bd_id, s.product_id, s.applied_at, s.videos, s.avg_view, s.note
    );
  }

  console.log('✅ 初始数据写入完成');
}

module.exports = db;
