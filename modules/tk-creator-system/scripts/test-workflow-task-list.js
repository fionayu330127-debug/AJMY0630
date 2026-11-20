#!/usr/bin/env node
// Offline unit tests for the unified workflow task list.
// Uses an in-memory SQLite fixture. Does not call the real TikTok API.

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  workflowDisplayName,
  workflowStatusLabel,
  formatShanghaiDate,
  formatShanghaiDateTime,
  sortWorkflowTasks,
  listWorkflowTasks,
  workflowCreatorSummaryQuery,
} = require('../workflowTaskList');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function createFixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
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
      applied_at TEXT
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT
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
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.prepare('INSERT INTO products (id, name) VALUES (?, ?)').run(1, 'UV Cream');

  // Active marketplace search-and-invite workflow with mixed invite/sample outcomes.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (1, '查找达人边搜边邀', 1, '{"source":"marketplace_search","shop":"oku"}', '2026-11-18 16:30:00', '2026-11-19 10:00:00')`).run();
  const insertInvite = db.prepare(`INSERT INTO invitation_records
    (shop_id, source, uid, creator_name, creator_handle, template_type, product_id, product_ids, status, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertInvite.run('oku', 'workflow:1', 'u1', 'A', '@a', 'collab', 1, '["1"]', 'sent', '2026-11-19 02:00:00', '2026-11-19 02:01:00');
  insertInvite.run('oku', 'workflow:1', 'u1', 'A', '@a', 'collab', 1, '["1"]', 'sent', '2026-11-19 03:00:00', '2026-11-19 03:01:00'); // duplicate uid
  insertInvite.run('oku', 'workflow:1', 'u2', 'B', '@b', 'collab', 1, '["1"]', 'sent', '2026-11-19 04:00:00', '2026-11-19 04:01:00');
  insertInvite.run('oku', 'workflow:1', 'u3', 'C', '@c', 'collab', 1, '["1"]', 'queued', '2026-11-19 04:10:00', null);
  insertInvite.run('oku', 'workflow:1', 'u4', 'D', '@d', 'collab', 1, '["1"]', 'cancelled', '2026-11-19 04:20:00', null);
  insertInvite.run('oku', 'workflow:1', 'u5', 'E', '@e', 'dm', 1, '["1"]', 'sent', '2026-11-19 05:00:00', '2026-11-19 05:01:00');
  insertInvite.run('oku', 'workflow_sample:1', 'u1', 'A', '@a', 'confirmation', 1, '["1"]', 'sent', '2026-11-19 06:00:00', '2026-11-19 06:01:00');
  insertInvite.run('oku', 'workflow:1', 'u6', 'F', '@f', 'collab', 1, '["1"]', 'sent', '2026-11-19 07:00:00', '2026-11-19 07:01:00');

  const insertSample = db.prepare(`INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, status, product_id, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insertSample.run('s1', 'u1', 'oku', 'A', '@a', 'pending', 1, '2026-11-19 08:00:00');
  insertSample.run('s2', 'u2', 'oku', 'B', '@b', 'approved', 1, '2026-11-19 08:10:00');
  insertSample.run('s5', 'u5', 'oku', 'E', '@e', 'pending', 1, '2026-11-19 08:20:00'); // invited with template_type dm
  insertSample.run('s9', 'u9', 'oku', 'Z', '@z', 'pending', 1, '2026-11-19 08:30:00'); // not invited by this workflow
  insertSample.run('s7', 'u7', 'oku', 'G', '@g', 'pending', 1, '2026-11-19 08:40:00'); // task only, no invitation_record
  insertInvite.run('oku', 'workflow:1', 'u8', 'H', '@h', 'collab', 1, '["1"]', 'pending', '2026-11-19 08:50:00', null);
  insertSample.run('s8', 'u8', 'oku', 'H', '@h', 'pending', 1, '2026-11-19 08:51:00'); // pending invite still attributes applicant

  const insertTask = db.prepare(`INSERT INTO agent_workflow_tasks
    (workflow_id, task_type, status, shop_id, uid, creator_name, creator_handle, sample_id, recommendation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertTask.run(1, 'sample_audit', 'application_confirmed', 'oku', 'u1', 'A', '@a', 's1', 'auto_pass', '2026-11-19 09:00:00', '2026-11-19 09:05:00');
  insertTask.run(1, 'sample_audit', 'admin_approved', 'oku', 'u2', 'B', '@b', 's2', 'auto_pass', '2026-11-19 09:10:00', '2026-11-19 09:15:00');
  insertTask.run(1, 'sample_audit', 'agent_review', 'oku', 'u5', 'E', '@e', 's5', 'auto_pass', '2026-11-19 09:20:00', '2026-11-19 09:25:00');
  insertTask.run(1, 'invite', 'executed', 'oku', 'u6', 'F', '@f', null, 'auto_pass', '2026-11-19 07:02:00', '2026-11-19 07:02:00');
  insertTask.run(1, 'sample_audit', 'agent_review', 'oku', 'u7', 'G', '@g', 's7', 'manual_review', '2026-11-19 09:30:00', '2026-11-19 09:35:00');

  // Older inactive workflow, still has historical sent invites and a later-stage confirmation.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (2, '历史定向邀约', 0, '{"source":"library","shop":"mir"}', '2026-11-10 01:00:00', '2026-11-12 02:00:00')`).run();
  insertInvite.run('mir', 'workflow:2', 'u20', 'Old', '@old', 'collab', 1, '["1"]', 'sent', '2026-11-11 03:00:00', '2026-11-11 03:01:00');
  insertSample.run('s20', 'u20', 'mir', 'Old', '@old', 'shipped', 1, '2026-11-11 08:00:00');
  insertTask.run(2, 'sample_audit', 'executed', 'mir', 'u20', 'Old', '@old', 's20', 'auto_pass', '2026-11-12 01:00:00', '2026-11-12 02:00:00');

  // Active workflow with no activity, blank name — should still appear.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (3, '   ', 1, '{"source":"marketplace_search"}', '2026-11-13 08:00:00', '2026-11-13 08:00:00')`).run();

  // Paused/active newer workflow used to verify sort: in-progress first, then by last activity.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (4, '新店铺试跑', 1, '{"source":"marketplace_search","shop":"mir"}', '2026-11-20 01:00:00', '2026-11-20 01:10:00')`).run();
  insertInvite.run('mir', 'workflow:4', 'u40', 'New', '@new', 'collab', 1, '["1"]', 'sent', '2026-11-20 02:00:00', '2026-11-20 02:30:00');

  return db;
}

test('workflowDisplayName falls back to name plus id when blank', () => {
  assert.equal(workflowDisplayName({ id: 3, name: '查找达人边搜边邀' }), '查找达人边搜边邀');
  assert.equal(workflowDisplayName({ id: 3, name: '   ' }), '未命名工作流 #3');
  assert.equal(workflowDisplayName({ id: 8, name: '' }), '未命名工作流 #8');
  assert.equal(workflowDisplayName({ id: 2, name: '???????' }), '未命名工作流 #2');
  assert.equal(workflowDisplayName({ name: '' }), '未命名工作流');
});

test('workflowStatusLabel uses workflow, global pause, and auto_invite', () => {
  assert.equal(workflowStatusLabel({ workflowActive: true, agentPaused: false, autoInviteActive: true }), '进行中');
  assert.equal(workflowStatusLabel({ workflowActive: true, agentPaused: true, autoInviteActive: true }), '已暂停');
  assert.equal(workflowStatusLabel({ workflowActive: true, agentPaused: false, autoInviteActive: false }), '已暂停');
  assert.equal(workflowStatusLabel({ workflowActive: false, agentPaused: false, autoInviteActive: true }), '已结束');
  assert.equal(workflowStatusLabel({ workflowActive: false, agentPaused: true, autoInviteActive: false }), '已结束');
});

test('formatShanghaiDateTime converts stored UTC timestamps', () => {
  assert.equal(formatShanghaiDateTime('2026-11-18 16:30:00'), '2026-11-19 00:30:00');
  assert.equal(formatShanghaiDate('2026-11-18 16:30:00'), '2026-11-19');
  assert.equal(formatShanghaiDateTime('2026-11-19T02:01:00Z'), '2026-11-19 10:01:00');
});

test('listWorkflowTasks aggregates unique sent, applicants, and confirmed review counts', () => {
  const db = createFixtureDb();
  const rows = listWorkflowTasks(db, { agentPaused: false, autoInviteActive: true });
  const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));

  assert.equal(byId[1].display_name, '查找达人边搜边邀');
  assert.equal(byId[1].status, '进行中');
  assert.equal(byId[1].invited_count, 4); // u1,u2,u5,u6 — queued/cancelled/pending and confirmation excluded
  assert.equal(byId[1].sample_applicant_count, 5); // u1,u2,u5 plus task-only u7 and pending-invite u8; u9 stays out
  assert.equal(byId[1].confirmed_review_count, 2); // u1 application_confirmed, u2 admin_approved
  assert.equal(byId[1].created_date_shanghai, '2026-11-19');
  assert.equal(byId[1].date_label, '创建日期（北京时间）');
  assert.match(byId[1].last_activity_shanghai, /^2026-11-19 /);

  assert.equal(byId[2].display_name, '历史定向邀约');
  assert.equal(byId[2].status, '已结束');
  assert.equal(byId[2].invited_count, 1);
  assert.equal(byId[2].sample_applicant_count, 1);
  assert.equal(byId[2].confirmed_review_count, 1);

  assert.equal(byId[3].display_name, '未命名工作流 #3');
  assert.equal(byId[3].status, '进行中');
  assert.equal(byId[3].invited_count, 0);
  assert.equal(byId[3].sample_applicant_count, 0);
  assert.equal(byId[3].confirmed_review_count, 0);

  assert.equal(byId[4].status, '进行中');
  assert.equal(byId[4].invited_count, 1);
  db.close();
});

test('paused Agent or disabled auto_invite labels active workflows as 已暂停', () => {
  const db = createFixtureDb();
  const paused = listWorkflowTasks(db, { agentPaused: true, autoInviteActive: true });
  const byId = Object.fromEntries(paused.map((row) => [Number(row.id), row]));
  assert.equal(byId[1].status, '已暂停');
  assert.equal(byId[4].status, '已暂停');
  assert.equal(byId[2].status, '已结束');

  const inviteOff = listWorkflowTasks(db, { agentPaused: false, autoInviteActive: false });
  assert.equal(inviteOff.find((row) => Number(row.id) === 1).status, '已暂停');
  db.close();
});

test('sorts in-progress first, then paused, then ended, then by last activity', () => {
  const rows = sortWorkflowTasks([
    { id: 2, status: '已结束', last_activity_at: '2026-11-20 10:00:00', created_at: '2026-11-01 00:00:00' },
    { id: 3, status: '已暂停', last_activity_at: '2026-11-19 10:00:00', created_at: '2026-11-02 00:00:00' },
    { id: 1, status: '进行中', last_activity_at: '2026-11-18 10:00:00', created_at: '2026-11-03 00:00:00' },
    { id: 4, status: '进行中', last_activity_at: '2026-11-19 12:00:00', created_at: '2026-11-04 00:00:00' },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [4, 1, 3, 2]);

  const db = createFixtureDb();
  const live = listWorkflowTasks(db, { agentPaused: false, autoInviteActive: true });
  // 4 and 1 are 进行中; 4 has later activity. 3 is also 进行中 but older. 2 is 已结束.
  assert.deepEqual(live.map((row) => Number(row.id)), [4, 1, 3, 2]);
  db.close();
});

test('creator summary kinds return sent, applicant, and confirmed unique creators', () => {
  const db = createFixtureDb();
  const sent = db.prepare(workflowCreatorSummaryQuery('sent').sql).all(...workflowCreatorSummaryQuery('sent').params(1));
  const applicants = db.prepare(workflowCreatorSummaryQuery('applicants').sql).all(...workflowCreatorSummaryQuery('applicants').params(1));
  const confirmed = db.prepare(workflowCreatorSummaryQuery('confirmed').sql).all(...workflowCreatorSummaryQuery('confirmed').params(1));
  assert.equal(sent.length, 4);
  assert.equal(applicants.length, 5);
  assert.equal(confirmed.length, 2);
  assert.ok(confirmed.every((row) => ['application_confirmed', 'admin_approved', 'executed'].includes(row.status)));
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
