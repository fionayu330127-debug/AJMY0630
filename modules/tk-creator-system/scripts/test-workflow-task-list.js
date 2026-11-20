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
  listWorkflowCreatorSummary,
  attachSampleInviteSources,
  creatorProfileUrl,
  ensureWorkflowRunStateColumn,
  listRunningWorkflows,
  getRunningMarketplaceWorkflow,
  liveInviteTargetWorkflow,
  pauseWorkflowTask,
  resumeWorkflowTask,
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
      fans INTEGER,
      videos INTEGER,
      avg_view REAL
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
      score_details_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.prepare('INSERT INTO products (id, name) VALUES (?, ?)').run(1, 'UV Cream');

  // Active marketplace search-and-invite workflow with mixed invite/sample outcomes.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (1, '查找达人边搜边邀', 1, 'running', '{"source":"marketplace_search","shop":"oku"}', '2026-11-18 16:30:00', '2026-11-19 10:00:00')`).run();
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

  const u1Checks = [
    { name: '粉丝数', metric: 'fans', actual: 5000, score: 5, pass: true },
    { name: '30天成交件数', metric: 'orders', actual: 240, score: 30, pass: true },
    { name: '30天视频平均播放量', metric: 'views', actual: 8000, score: 30, pass: true },
    { name: '成交件数 ÷ 发布视频数', metric: 'conversion', actual: 2.4, score: 14.4, pass: true },
  ];
  db.prepare(`UPDATE agent_workflow_tasks
    SET score = ?, score_details_json = ?, payload_json = ?
    WHERE workflow_id = 1 AND uid = 'u1' AND task_type = 'sample_audit'`).run(
    79.4,
    JSON.stringify(u1Checks),
    JSON.stringify({
      report: {
        basic_data: { uid: 'u1', name: 'A', handle: '@a', fans: 5000, avg_view: 8000, monthly_videos: 100, orders_30d: 240 },
        checks: u1Checks,
        score: 79.4,
        decision: '建议通过，等待管理员确认',
      },
    }),
  );
  db.prepare(`UPDATE agent_workflow_tasks SET score = 80 WHERE workflow_id = 1 AND uid = 'u6' AND task_type = 'invite'`).run();

  // Older inactive workflow, still has historical sent invites and a later-stage confirmation.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (2, '历史定向邀约', 0, 'paused', '{"source":"library","shop":"mir"}', '2026-11-10 01:00:00', '2026-11-12 02:00:00')`).run();
  insertInvite.run('mir', 'workflow:2', 'u20', 'Old', '@old', 'collab', 1, '["1"]', 'sent', '2026-11-11 03:00:00', '2026-11-11 03:01:00');
  insertSample.run('s20', 'u20', 'mir', 'Old', '@old', 'shipped', 1, '2026-11-11 08:00:00');
  insertTask.run(2, 'sample_audit', 'executed', 'mir', 'u20', 'Old', '@old', 's20', 'auto_pass', '2026-11-12 01:00:00', '2026-11-12 02:00:00');

  // Active workflow with no activity, blank name — should still appear.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (3, '   ', 1, 'paused', '{"source":"marketplace_search"}', '2026-11-13 08:00:00', '2026-11-13 08:00:00')`).run();

  // Paused/active newer workflow used to verify sort: in-progress first, then by last activity.
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (4, '新店铺试跑', 1, 'paused', '{"source":"marketplace_search","shop":"mir"}', '2026-11-20 01:00:00', '2026-11-20 01:10:00')`).run();
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

test('workflowStatusLabel uses only the task\'s own active and run_state', () => {
  assert.equal(workflowStatusLabel({ workflowActive: true, runState: 'running' }), '进行中');
  assert.equal(workflowStatusLabel({ workflowActive: true, runState: 'paused' }), '已暂停');
  assert.equal(workflowStatusLabel({ workflowActive: true }), '已暂停');
  assert.equal(workflowStatusLabel({ workflowActive: false, runState: 'running' }), '已结束');
  assert.equal(workflowStatusLabel({ workflowActive: false, runState: 'paused' }), '已结束');
  // Global pause / auto_invite must not override the task's own label.
  assert.equal(workflowStatusLabel({ workflowActive: true, runState: 'running', agentPaused: true, autoInviteActive: false }), '进行中');
  assert.equal(workflowStatusLabel({ workflowActive: true, runState: 'paused', agentPaused: false, autoInviteActive: true }), '已暂停');
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
  assert.equal(byId[1].sample_applicant_count, 3); // u1,u2,u5 post-invite same product; u7 task-only, u8 unsent invite, u9 uninvited excluded
  assert.equal(byId[1].confirmed_review_count, 2); // u1 application_confirmed, u2 admin_approved — 管理员已确认
  assert.equal(byId[1].admin_confirmed_review_count, 2);
  assert.equal(byId[1].agent_review_count, 4); // u1,u2,u5,u7 Agent reviewed sample_audit; invite-scored u6 excluded
  assert.equal(byId[1].created_date_shanghai, '2026-11-19');
  assert.equal(byId[1].date_label, '创建日期（北京时间）');
  assert.match(byId[1].last_activity_shanghai, /^2026-11-19 /);

  assert.equal(byId[2].display_name, '历史定向邀约');
  assert.equal(byId[2].status, '已结束');
  assert.equal(byId[2].invited_count, 1);
  assert.equal(byId[2].sample_applicant_count, 1);
  assert.equal(byId[2].confirmed_review_count, 1);
  assert.equal(byId[2].agent_review_count, 1);

  assert.equal(byId[3].display_name, '未命名工作流 #3');
  assert.equal(byId[3].status, '已暂停');
  assert.equal(byId[3].can_resume, true);
  assert.equal(byId[3].can_pause, false);
  assert.equal(byId[3].invited_count, 0);
  assert.equal(byId[3].sample_applicant_count, 0);
  assert.equal(byId[3].confirmed_review_count, 0);
  assert.equal(byId[3].agent_review_count, 0);

  assert.equal(byId[4].status, '已暂停');
  assert.equal(byId[4].invited_count, 1);
  assert.equal(byId[1].can_pause, true);
  assert.equal(byId[1].can_resume, false);
  db.close();
});

test('global Agent pause does not relabel a running or paused task', () => {
  const db = createFixtureDb();
  const paused = listWorkflowTasks(db, { agentPaused: true, autoInviteActive: true });
  const byId = Object.fromEntries(paused.map((row) => [Number(row.id), row]));
  assert.equal(byId[1].status, '进行中');
  assert.equal(byId[4].status, '已暂停');
  assert.equal(byId[3].status, '已暂停');
  assert.equal(byId[2].status, '已结束');

  const inviteOff = listWorkflowTasks(db, { agentPaused: false, autoInviteActive: false });
  assert.equal(inviteOff.find((row) => Number(row.id) === 1).status, '进行中');
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
  // 1 is 进行中; 4 then 3 are 已暂停 (4 has later activity); 2 is 已结束.
  assert.deepEqual(live.map((row) => Number(row.id)), [1, 4, 3, 2]);
  db.close();
});

test('creator summary kinds return sent, applicant, and confirmed unique creators', () => {
  const db = createFixtureDb();
  const sent = db.prepare(workflowCreatorSummaryQuery('sent').sql).all(...workflowCreatorSummaryQuery('sent').params(1));
  const applicants = db.prepare(workflowCreatorSummaryQuery('applicants').sql).all(...workflowCreatorSummaryQuery('applicants').params(1));
  const confirmed = db.prepare(workflowCreatorSummaryQuery('confirmed').sql).all(...workflowCreatorSummaryQuery('confirmed').params(1));
  assert.equal(sent.length, 4);
  assert.equal(applicants.length, 3);
  assert.deepEqual(applicants.map((row) => row.uid).sort(), ['u1', 'u2', 'u5']);
  assert.equal(confirmed.length, 2);
  assert.ok(confirmed.every((row) => ['application_confirmed', 'admin_approved', 'executed'].includes(row.status)));
  db.close();
});

test('creatorProfileUrl uses handle only and never invents one from uid', () => {
  assert.equal(creatorProfileUrl({ creator_handle: '@sh.i.ro.06.09.08' }), 'https://www.tiktok.com/@sh.i.ro.06.09.08');
  assert.equal(creatorProfileUrl({ creator_handle: 'Sakura_beauty' }), 'https://www.tiktok.com/@Sakura_beauty');
  assert.equal(creatorProfileUrl({ creator_handle: 'https://www.tiktok.com/@ready' }), 'https://www.tiktok.com/@ready');
  assert.equal(creatorProfileUrl({ profile_url: 'https://www.tiktok.com/@from-field' }), 'https://www.tiktok.com/@from-field');
  assert.equal(creatorProfileUrl({ uid: 'u1', creator_name: 'A' }), '');
  assert.equal(creatorProfileUrl({ creator_handle: '', uid: '712345678' }), '');
});

test('Agent审核名单 includes reviewed sample_audit creators with metrics and profile links, not invite-only scores', () => {
  const db = createFixtureDb();
  const agent = listWorkflowCreatorSummary(db, 1, 'agent');
  const confirmed = listWorkflowCreatorSummary(db, 1, 'confirmed');
  assert.equal(agent.length, 4);
  assert.deepEqual(agent.map((row) => row.uid).sort(), ['u1', 'u2', 'u5', 'u7']);
  assert.ok(!agent.some((row) => row.uid === 'u6'));
  const first = agent.find((row) => row.uid === 'u1');
  assert.equal(first.display_name, 'A');
  assert.equal(first.profile_url, 'https://www.tiktok.com/@a');
  assert.equal(first.fans, 5000);
  assert.equal(first.orders_30d, 240);
  assert.equal(first.avg_view, 8000);
  assert.equal(first.monthly_videos, 100);
  assert.equal(first.conversion, 2.4);
  assert.equal(first.score, 79.4);
  assert.equal(first.recommendation, 'auto_pass');
  assert.equal(first.metrics.fans, 5000);
  assert.ok(first.checks.some((check) => check.metric === 'fans'));

  assert.equal(confirmed.length, 2);
  assert.deepEqual(confirmed.map((row) => row.uid).sort(), ['u1', 'u2']);
  assert.equal(confirmed.find((row) => row.uid === 'u1').profile_url, 'https://www.tiktok.com/@a');
  assert.equal(confirmed.find((row) => row.uid === 'u1').score, 79.4);
  db.close();
});


test('existing workflows without an explicit start default to 已暂停 and do not all start', () => {
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
      shop_id TEXT, source TEXT, uid TEXT, creator_name TEXT, creator_handle TEXT,
      template_type TEXT DEFAULT 'dm', product_id INTEGER, product_ids TEXT, status TEXT,
      created_at TEXT, sent_at TEXT
    );
    CREATE TABLE samples (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, shop_id TEXT, creator_name TEXT, creator_handle TEXT,
      status TEXT, product_id INTEGER, applied_at TEXT
    );
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE agent_workflow_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL, task_type TEXT, status TEXT,
      shop_id TEXT, uid TEXT, creator_name TEXT, creator_handle TEXT, sample_id TEXT,
      score INTEGER, recommendation TEXT, reason TEXT, payload_json TEXT, score_details_json TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (10, '旧任务A', 1, '{"source":"marketplace_search"}', '2026-11-01 00:00:00', '2026-11-01 00:00:00')`).run();
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (11, '旧任务B', 1, '{"source":"marketplace_search"}', '2026-11-02 00:00:00', '2026-11-02 00:00:00')`).run();
  db.prepare(`INSERT INTO agent_workflows (id, name, active, config_json, created_at, updated_at)
    VALUES (12, '已结束C', 0, '{"source":"library"}', '2026-10-01 00:00:00', '2026-10-02 00:00:00')`).run();

  ensureWorkflowRunStateColumn(db);
  const rows = listWorkflowTasks(db);
  const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));
  assert.equal(byId[10].status, '已暂停');
  assert.equal(byId[11].status, '已暂停');
  assert.equal(byId[12].status, '已结束');
  assert.equal(listRunningWorkflows(db).length, 0);
  assert.equal(getRunningMarketplaceWorkflow(db), null);
  db.close();
});

test('resuming one task does not resume other historical active workflows', () => {
  const db = createFixtureDb();
  // Fixture has 1 running and 3/4 paused. Pause 1 first so all actives are paused.
  pauseWorkflowTask(db, 1, { nowText: () => '2026-11-20 03:00:00' });
  assert.equal(listRunningWorkflows(db).length, 0);

  const result = resumeWorkflowTask(db, 4, { nowText: () => '2026-11-20 03:01:00', globalPaused: true });
  assert.equal(Number(result.workflow.id), 4);
  assert.equal(result.workflow.run_state, 'running');
  assert.equal(Number(result.workflow.active), 1);
  assert.equal(result.cleared_global_pause, true);
  assert.equal(result.started_only_this_task, true);
  assert.deepEqual(result.paused_workflow_ids, []);

  const rows = listWorkflowTasks(db);
  const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));
  assert.equal(byId[4].status, '进行中');
  assert.equal(byId[1].status, '已暂停');
  assert.equal(byId[3].status, '已暂停');
  assert.equal(byId[2].status, '已结束');
  const running = listRunningWorkflows(db);
  assert.equal(running.length, 1);
  assert.equal(Number(running[0].id), 4);
  assert.equal(Number(getRunningMarketplaceWorkflow(db).id), 4);
  db.close();
});

test('resuming a task pauses a different currently running search-invite task', () => {
  const db = createFixtureDb();
  const result = resumeWorkflowTask(db, 4, { nowText: () => '2026-11-20 04:00:00', globalPaused: false });
  assert.deepEqual(result.paused_workflow_ids, [1]);
  assert.equal(result.paused_workflows[0].name, '查找达人边搜边邀');
  const rows = listWorkflowTasks(db);
  const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));
  assert.equal(byId[4].status, '进行中');
  assert.equal(byId[1].status, '已暂停');
  assert.equal(byId[3].status, '已暂停');
  assert.equal(listRunningWorkflows(db).length, 1);
  db.close();
});

test('pause keeps the workflow active and does not end it; resume reactivates an ended task', () => {
  const db = createFixtureDb();
  const paused = pauseWorkflowTask(db, 1, { nowText: () => '2026-11-20 05:00:00' });
  assert.equal(paused.changed, true);
  assert.equal(paused.paused_pending_kept, true);
  assert.equal(Number(paused.workflow.active), 1);
  assert.equal(paused.workflow.run_state, 'paused');
  assert.equal(listWorkflowTasks(db).find((row) => Number(row.id) === 1).status, '已暂停');

  const again = pauseWorkflowTask(db, 1, { nowText: () => '2026-11-20 05:01:00' });
  assert.equal(again.changed, false);

  const endedPause = pauseWorkflowTask(db, 2, { nowText: () => '2026-11-20 05:02:00' });
  assert.equal(endedPause.changed, false);
  assert.equal(Number(endedPause.workflow.active), 0);

  const restarted = resumeWorkflowTask(db, 2, { nowText: () => '2026-11-20 05:03:00' });
  assert.equal(Number(restarted.workflow.active), 1);
  assert.equal(restarted.workflow.run_state, 'running');
  const rows = listWorkflowTasks(db);
  const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));
  assert.equal(byId[2].status, '进行中');
  // Starting #2 also pauses the previously running #1.
  assert.equal(byId[1].status, '已暂停');
  db.close();
});

test('live invite progress attaches to the running marketplace task', () => {
  const db = createFixtureDb();
  const rows = listWorkflowTasks(db);
  const target = liveInviteTargetWorkflow(rows);
  assert.equal(Number(target.id), 1);
  pauseWorkflowTask(db, 1, { nowText: () => '2026-11-20 06:00:00' });
  const after = listWorkflowTasks(db);
  // No running marketplace task: fall back to the first sorted marketplace row (still the list, not a second definition).
  const fallback = liveInviteTargetWorkflow(after);
  assert.ok(fallback);
  assert.equal(fallback.status, '已暂停');
  db.close();
});


test('sample applicant count requires a sent workflow invite, same product, and applied_at at or after the invite', () => {
  const db = createFixtureDb();
  db.prepare('INSERT INTO products (id, name) VALUES (?, ?), (?, ?)').run(9, 'Lumbar Belt', 36, 'Pull-up Bar');
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (9, '自动化工作流 2026/11/16 下午2:21:46', 1, 'paused', '{"source":"marketplace_search","shop":"oku","product_ids":[9]}', '2026-11-16 06:22:21', '2026-11-19 12:24:07')`).run();
  const insertInvite = db.prepare(`INSERT INTO invitation_records
    (shop_id, source, uid, creator_name, creator_handle, template_type, product_id, product_ids, status, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSample = db.prepare(`INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, status, product_id, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  // anko: invited for product 9, later applied for product 9 and 36 at the same time.
  insertInvite.run('oku', 'workflow:9', 'anko', 'あんこ', 'anko_1974', 'collab', 9, '[9]', 'sent', '2026-11-19 13:43:50', '2026-11-19 13:43:50');
  insertSample.run('s-anko-36', 'anko', 'oku', 'あんこ', 'anko_1974', 'pending', 36, '2026-11-20 05:43:52');
  insertSample.run('s-anko-9', 'anko', 'oku', 'あんこ', 'anko_1974', 'pending', 9, '2026-11-20 05:43:52');
  // gesshi: invited for product 9 after an older different-product application.
  insertInvite.run('oku', 'workflow:9', 'gesshi', 'げっしるい', 'gesshi_rui', 'collab', 9, '[9]', 'sent', '2026-11-19 13:51:45', '2026-11-19 13:51:45');
  insertSample.run('s-gesshi', 'gesshi', 'oku', 'げっしるい', 'gesshi_rui', 'published', 57, '2026-07-29 02:51:03');
  // buixuan: invited for product 9 after older applications for other products.
  insertInvite.run('oku', 'workflow:9', 'buixuan', 'Bùi Xuân Kiên', 'buixuankien', 'collab', 9, '[9]', 'sent', '2026-11-19 13:53:25', '2026-11-19 13:53:25');
  insertSample.run('s-kien-50', 'buixuan', 'oku', 'Bùi Xuân Kiên', 'buixuankien', 'published', 50, '2026-07-18 10:02:31');
  insertSample.run('s-kien-57', 'buixuan', 'oku', 'Bùi Xuân Kiên', 'buixuankien', 'cancelled', 57, '2026-07-20 10:02:24');
  // Same product but applied before this workflow's invite.
  insertInvite.run('oku', 'workflow:9', 'early', 'Early', 'early_user', 'collab', 9, '["9"]', 'sent', '2026-11-19 13:54:00', '2026-11-19 13:54:00');
  insertSample.run('s-early', 'early', 'oku', 'Early', 'early_user', 'pending', 9, '2026-11-18 10:00:00');
  // Same product, applied exactly at sent time, should count.
  insertInvite.run('oku', 'workflow:9', 'same-time', 'Same', 'same_time', 'collab', 9, '[9]', 'sent', '2026-11-19 14:00:00', '2026-11-19 14:00:00');
  insertSample.run('s-same-time', 'same-time', 'oku', 'Same', 'same_time', 'pending', 9, '2026-11-19 14:00:00');

  const rows = listWorkflowTasks(db);
  const workflow9 = rows.find((row) => Number(row.id) === 9);
  assert.equal(workflow9.sample_applicant_count, 2); // anko + same-time; gesshi/buixuan/early excluded

  const applicants = listWorkflowCreatorSummary(db, 9, 'applicants');
  assert.deepEqual(applicants.map((row) => row.creator_handle).sort(), ['anko_1974', 'same_time']);
  const anko = applicants.find((row) => row.creator_handle === 'anko_1974');
  assert.equal(anko.product_name, 'Lumbar Belt');
  assert.equal(anko.applied_at, '2026-11-20 05:43:52');
  db.close();
});

test('sample center tags only ERP workflow and invitation-center sources', () => {
  const db = createFixtureDb();
  db.prepare('INSERT INTO products (id, name) VALUES (?, ?)').run(9, 'Lumbar Belt');
  db.prepare(`INSERT INTO agent_workflows (id, name, active, run_state, config_json, created_at, updated_at)
    VALUES (9, '自动化工作流 2026/11/16 下午2:21:46', 1, 'paused', '{"source":"marketplace_search"}', '2026-11-16 06:22:21', '2026-11-19 12:24:07')`).run();
  const insertInvite = db.prepare(`INSERT INTO invitation_records
    (shop_id, source, uid, creator_name, creator_handle, template_type, product_id, product_ids, status, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSample = db.prepare(`INSERT INTO samples (id, uid, shop_id, creator_name, creator_handle, status, product_id, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  insertInvite.run('oku', 'workflow:9', 'auto-uid', 'Auto', 'auto_user', 'collab', 9, '[9]', 'sent', '2026-11-19 13:00:00', '2026-11-19 13:00:00');
  insertSample.run('s-auto', 'auto-uid', 'oku', 'Auto', 'auto_user', 'pending', 9, '2026-11-20 05:00:00');
  insertSample.run('s-auto-other', 'auto-uid', 'oku', 'Auto', 'auto_user', 'pending', 36, '2026-11-20 05:00:00');

  insertInvite.run('oku', 'shop_pool', 'manual-uid', 'Manual', 'manual_user', 'collab', 9, '["9"]', 'sent', '2026-11-18 08:00:00', '2026-11-18 08:00:00');
  insertSample.run('s-manual', 'manual-uid', 'oku', 'Manual', 'manual_user', 'pending', 9, '2026-11-18 12:00:00');

  insertInvite.run('oku', 'library', 'lib-uid', 'Lib', 'lib_user', 'collab', 9, '[9]', 'sent', '2026-11-17 08:00:00', '2026-11-17 08:00:00');
  insertSample.run('s-lib', 'lib-uid', 'oku', 'Lib', 'lib_user', 'pending', 9, '2026-11-17 09:00:00');

  insertSample.run('s-none', 'none-uid', 'oku', 'None', 'none_user', 'pending', 9, '2026-11-20 05:00:00');

  // Both a manual invite and a later workflow invite; application after both -> latest (workflow) wins.
  insertInvite.run('oku', 'shop_pool', 'both-uid', 'Both', 'both_user', 'collab', 9, '[9]', 'sent', '2026-11-18 08:00:00', '2026-11-18 08:00:00');
  insertInvite.run('oku', 'workflow:9', 'both-uid', 'Both', 'both_user', 'collab', 9, '[9]', 'sent', '2026-11-19 13:00:00', '2026-11-19 13:00:00');
  insertSample.run('s-both', 'both-uid', 'oku', 'Both', 'both_user', 'pending', 9, '2026-11-20 05:00:00');

  const tagged = attachSampleInviteSources(db, db.prepare('SELECT * FROM samples WHERE id LIKE ?').all('s-%'));
  const byId = Object.fromEntries(tagged.map((row) => [row.id, row]));

  assert.equal(byId['s-auto'].invite_source_kind, 'workflow');
  assert.equal(byId['s-auto'].invite_source_label, '自动化任务：自动化工作流 2026/11/16 下午2:21:46');
  assert.equal(byId['s-auto'].invite_workflow_id, 9);
  assert.equal(byId['s-auto-other'].invite_source_kind, null);
  assert.equal(byId['s-auto-other'].invite_source_label, '');
  assert.equal(byId['s-manual'].invite_source_kind, 'manual');
  assert.equal(byId['s-manual'].invite_source_label, '人工邀约（邀约中心 · 达人池）');
  assert.equal(byId['s-lib'].invite_source_kind, 'manual');
  assert.equal(byId['s-lib'].invite_source_label, '人工邀约（邀约中心 · 合作达人库）');
  assert.equal(byId['s-none'].invite_source_kind, null);
  assert.equal(byId['s-none'].invite_source_label, '');
  assert.equal(byId['s-both'].invite_source_kind, 'workflow');
  assert.equal(byId['s-both'].invite_source_label, '自动化任务：自动化工作流 2026/11/16 下午2:21:46');
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
