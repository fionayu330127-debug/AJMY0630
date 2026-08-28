const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
const columns = name => db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);

const output = {
  relatedTables: tables.filter(name => /sync|sample|shop|auth/i.test(name)),
  sampleColumns: columns('samples'),
  logs: db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 20').all(),
  lastSuccessfulLogs: db.prepare(`
    SELECT * FROM sync_logs
    WHERE shop_id = 'oku' AND status = 'success'
    ORDER BY id DESC LIMIT 5
  `).all(),
  shops: db.prepare('SELECT * FROM shops').all(),
  okuyoshiStatus: db.prepare(`
    SELECT status, COUNT(*) AS count,
      SUM(CASE WHEN bd_id IS NULL THEN 1 ELSE 0 END) AS without_bd,
      MAX(synced_at) AS last_sync
    FROM samples WHERE shop_id = 'oku'
    GROUP BY status ORDER BY status
  `).all(),
  recentRawSamples: db.prepare(`
    SELECT external_sample_id, applied_at, raw_json
    FROM samples WHERE shop_id = 'oku' AND raw_json IS NOT NULL
    ORDER BY datetime(applied_at) DESC LIMIT 3
  `).all().map(row => {
    let raw = {};
    try { raw = JSON.parse(row.raw_json); } catch {}
    return {
      external_sample_id: row.external_sample_id,
      applied_at: row.applied_at,
      raw_time_fields: {
        apply_time: raw.apply_time,
        create_time: raw.create_time,
        update_time: raw.update_time,
      },
    };
  }),
};

console.log(JSON.stringify(output, null, 2));
