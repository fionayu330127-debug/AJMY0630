#!/usr/bin/env node
// Offline tests for sample-center Agent review coverage (auto, manual, unmatched).

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureSampleReviewTasks,
  attachSampleReviewFields,
  isSampleCenterReviewWorkflow,
  SAMPLE_CENTER_REVIEW_SOURCE,
} = require('../sampleCenterReview');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      run_state TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE invitation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT,
      source TEXT NOT NULL,
      uid TEXT NOT NULL,
      creator_name TEXT,
      creator_handle TEXT,
      template_type TEXT NOT NULL DEFAULT 'dm',
      product_id INTEGER,
      product_ids TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE samples (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      shop_id TEXT,
      creator_name TEXT,
      creator_handle TEXT,
      status TEXT DEFAULT 'pending',
      product_id INTEGER,
      applied_at TEXT,
      bd_id INTEGER,
      library_added_at TEXT,
      fans INTEGER,
      videos INTEGER,
      avg_view REAL,
      sales_count INTEGER
    );
    CREATE TABLE agent_workflow_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      shop_id TEXT,
      uid TEXT,
      creator_name TEXT,
      creator_handle TEXT,
      sample_id TEXT,
      score INTEGER DEFAULT 0,
      recommendation TEXT,
      reason TEXT,
      payload_json TEXT,
      review_standard_version INTEGER,
      score_details_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(workflow_id, task_type, uid, sample_id)
    );
  `);
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (9, '自动化工作流 2026/11/16 下午2:21:46', 1, 'paused', '{"source":"marketplace_search"}', '2026-11-16 06:22:21', '2026-11-19 12:24:07')`).run();
  return db;
}

function scoreSample(sample) {
  return {
    score: 80,
    recommendation: 'auto_pass',
    reason: `scored ${sample.id}`,
    checks: [{ name: '粉丝数', pass: true }],
    review_standard_version: 1,
  };
}

test('ensures Agent review tasks for workflow, manual, and unmatched applications', () => {
  const db = createDb();
  const insertInvite = db.prepare(`INSERT INTO invitation_records
    (shop_id, source, uid, template_type, product_id, product_ids, status, created_at, sent_at)
    VALUES (?, ?, ?, 'collab', ?, ?, 'sent', ?, ?)`);
  const insertSample = db.prepare(`INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, status, product_id, applied_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);

  insertInvite.run('oku', 'workflow:9', 'auto-uid', 9, '[9]', '2026-11-19 13:00:00', '2026-11-19 13:00:00');
  insertSample.run('s-auto', 'auto-uid', 'oku', 'Auto', 'auto_user', 9, '2026-11-20 05:00:00');

  insertInvite.run('oku', 'shop_pool', 'manual-uid', 9, '["9"]', '2026-11-18 08:00:00', '2026-11-18 08:00:00');
  insertSample.run('s-manual', 'manual-uid', 'oku', 'Manual', 'manual_user', 9, '2026-11-18 12:00:00');

  insertSample.run('s-none', 'none-uid', 'oku', 'None', 'none_user', 9, '2026-11-20 05:00:00');
  insertSample.run('s-published', 'pub-uid', 'oku', 'Pub', 'pub_user', 9, '2026-11-20 05:00:00');
  db.prepare("UPDATE samples SET status = 'published' WHERE id = 's-published'").run();

  const result = ensureSampleReviewTasks(db, { scoreSample, nowText: () => '2026-11-20 06:00:00' });
  assert.equal(result.created, 3);
  const center = db.prepare("SELECT * FROM agent_workflows WHERE json_extract(config_json, '$.source') = ?").get(SAMPLE_CENTER_REVIEW_SOURCE);
  assert.ok(center);
  assert.equal(isSampleCenterReviewWorkflow(center), true);
  assert.equal(Number(center.active), 0);

  const tasks = db.prepare('SELECT * FROM agent_workflow_tasks WHERE task_type = ?').all('sample_audit');
  const bySample = Object.fromEntries(tasks.map((row) => [row.sample_id, row]));
  assert.equal(Number(bySample['s-auto'].workflow_id), 9);
  assert.equal(bySample['s-auto'].status, 'agent_review');
  assert.equal(Number(bySample['s-auto'].score), 80);
  assert.equal(Number(bySample['s-manual'].workflow_id), Number(center.id));
  assert.equal(Number(bySample['s-none'].workflow_id), Number(center.id));
  assert.ok(!bySample['s-published']);

  const attached = attachSampleReviewFields(db, db.prepare('SELECT * FROM samples').all());
  const rows = Object.fromEntries(attached.map((row) => [row.id, row]));
  assert.equal(rows['s-auto'].agent_review_task_id, bySample['s-auto'].id);
  assert.equal(rows['s-auto'].agent_recommendation, 'auto_pass');
  assert.equal(rows['s-manual'].agent_review_status, 'agent_review');
  assert.equal(rows['s-none'].agent_score, 80);
  assert.equal(rows['s-published'].agent_review_task_id, null);

  // A later ensure must not reset a confirmed review or create a second task.
  db.prepare("UPDATE agent_workflow_tasks SET status = 'application_confirmed' WHERE sample_id = 's-auto'").run();
  const again = ensureSampleReviewTasks(db, { scoreSample: () => ({ score: 10, recommendation: 'manual_review', reason: 'should not overwrite' }), nowText: () => '2026-11-20 07:00:00' });
  const autoTask = db.prepare("SELECT * FROM agent_workflow_tasks WHERE sample_id = 's-auto'").get();
  assert.equal(autoTask.status, 'application_confirmed');
  assert.equal(Number(autoTask.score), 80);
  assert.equal(again.created, 0);
  db.close();
});

test('sample-center review workflow stays off the regular task list', () => {
  const { listWorkflowTasks } = require('../workflowTaskList');
  const db = createDb();
  db.prepare(`INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, status, product_id, applied_at)
    VALUES ('s-none', 'none-uid', 'oku', 'None', 'none_user', 'pending', 9, '2026-11-20 05:00:00')`).run();
  ensureSampleReviewTasks(db, { scoreSample, nowText: () => '2026-11-20 06:00:00' });
  const listed = listWorkflowTasks(db);
  assert.ok(listed.every((row) => !String(row.name || '').includes('样品中心审核')));
  assert.ok(listed.every((row) => !isSampleCenterReviewWorkflow(row)));
  assert.equal(listed.some((row) => Number(row.id) === 9), true);
  db.close();
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`ok  ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok  ${item.name}`);
      console.error(error);
    }
  }
  if (failed) process.exit(1);
  console.log(`passed ${tests.length} tests`);
})();
