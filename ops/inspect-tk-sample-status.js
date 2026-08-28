const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });

console.log('STATUS');
for (const row of db.prepare(`
  SELECT status,
         COUNT(*) AS count,
         SUM(CASE WHEN bd_id IS NOT NULL THEN 1 ELSE 0 END) AS with_bd
  FROM samples
  GROUP BY status
  ORDER BY status
`).all()) console.log(JSON.stringify(row));

console.log('BD_STATUS');
for (const row of db.prepare(`
  SELECT COALESCE(b.name, '未分配') AS bd, s.status, COUNT(*) AS count
  FROM samples s
  LEFT JOIN bd_members b ON b.id = s.bd_id
  WHERE s.bd_id IS NOT NULL
  GROUP BY s.bd_id, s.status
  ORDER BY b.name, s.status
`).all()) console.log(JSON.stringify(row));

console.log('SHOP_STATUS');
for (const row of db.prepare(`
  SELECT s.shop_id, s.status, COUNT(*) AS count,
         SUM(CASE WHEN s.bd_id IS NOT NULL THEN 1 ELSE 0 END) AS with_bd
  FROM samples s
  GROUP BY s.shop_id, s.status
  ORDER BY s.shop_id, s.status
`).all()) console.log(JSON.stringify(row));

console.log('ASSIGNED_ROWS');
for (const row of db.prepare(`
  SELECT s.id, s.shop_id, s.status, s.bd_id, b.name AS bd,
         s.applied_at, s.synced_at
  FROM samples s
  LEFT JOIN bd_members b ON b.id = s.bd_id
  WHERE s.status = 'assigned'
  ORDER BY COALESCE(s.synced_at, s.applied_at) DESC
`).all()) console.log(JSON.stringify(row));

db.close();
