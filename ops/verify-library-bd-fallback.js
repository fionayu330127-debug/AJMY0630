const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const [dbPath, apiJsonPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const apiRows = apiJsonPath ? JSON.parse(fs.readFileSync(apiJsonPath, 'utf8')) : null;

const librarySamples = db.prepare(`
  SELECT id, uid, creator_handle, bd_id, status, applied_at, library_added_at
  FROM samples
  WHERE status IN ('approved', 'shipped', 'published')
    AND library_added_at IS NOT NULL
  ORDER BY applied_at DESC
`).all();
const libraries = new Map(db.prepare('SELECT uid, bd_id FROM creator_library').all().map((row) => [row.uid, row.bd_id]));

const historicalByUid = new Map();
const historicalByHandle = new Map();
for (const sample of db.prepare(`
  SELECT uid, creator_handle, bd_id
  FROM samples
  WHERE bd_id IS NOT NULL
  ORDER BY datetime(applied_at) DESC, id DESC
`).all()) {
  const uid = String(sample.uid || '').trim();
  const handle = String(sample.creator_handle || '').trim().replace(/^@/, '').toLowerCase();
  if (uid && !historicalByUid.has(uid)) historicalByUid.set(uid, sample.bd_id);
  if (handle && !historicalByHandle.has(handle)) historicalByHandle.set(handle, sample.bd_id);
}

const groups = new Map();
for (const sample of librarySamples) {
  const handle = String(sample.creator_handle || '').trim().replace(/^@/, '').toLowerCase();
  const key = handle ? `handle:${handle}` : `uid:${sample.uid}`;
  if (!groups.has(key)) groups.set(key, { handle, uids: new Set(), samples: [] });
  const group = groups.get(key);
  group.uids.add(sample.uid);
  group.samples.push(sample);
}

const expected = new Map();
let fallbackToLibrary = 0;
let fallbackToHistory = 0;
for (const [key, group] of groups) {
  const latest = group.samples.sort((a, b) =>
    String(b.library_added_at || b.applied_at || '').localeCompare(String(a.library_added_at || a.applied_at || ''))
  )[0];
  const latestBd = latest.bd_id || null;
  const libraryBd = [...group.uids].map((uid) => libraries.get(uid)).find(Boolean) || null;
  const historyBd = [...group.uids].map((uid) => historicalByUid.get(String(uid || '').trim())).find(Boolean)
    || historicalByHandle.get(group.handle)
    || null;
  const resolved = latestBd || libraryBd || historyBd || null;
  if (!latestBd && libraryBd) fallbackToLibrary += 1;
  if (!latestBd && !libraryBd && historyBd) fallbackToHistory += 1;
  expected.set(key, resolved);
}

let checked = expected.size;
let mismatches = null;
let oldUnassigned = 0;
let newUnassigned = [...expected.values()].filter((bdId) => !bdId).length;
for (const group of groups.values()) {
  const latest = group.samples.sort((a, b) =>
    String(b.library_added_at || b.applied_at || '').localeCompare(String(a.library_added_at || a.applied_at || ''))
  )[0];
  if (!latest?.bd_id) oldUnassigned += 1;
}

if (apiRows) {
  checked = 0;
  mismatches = 0;
  for (const row of apiRows) {
    const handle = String(row.handle || '').trim().replace(/^@/, '').toLowerCase();
    const key = handle ? `handle:${handle}` : `uid:${row.uid}`;
    if (!expected.has(key)) continue;
    checked += 1;
    if (Number(row.bd_id || 0) !== Number(expected.get(key) || 0)) mismatches += 1;
  }
}

console.log(JSON.stringify({
  apiRows: apiRows?.length ?? null,
  checked,
  fallbackToLibrary,
  fallbackToHistory,
  oldUnassigned,
  newUnassigned,
  mismatches,
}, null, 2));

db.close();
