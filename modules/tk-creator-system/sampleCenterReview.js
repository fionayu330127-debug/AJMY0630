'use strict';

const { pickLatestMatchingInvite } = require('./workflowTaskList');

const SAMPLE_CENTER_REVIEW_SOURCE = 'sample_center';
const SAMPLE_CENTER_REVIEW_NAME = '样品中心审核';
const PRESERVE_REVIEW_STATUSES = new Set([
  'application_confirmed',
  'admin_approved',
  'admin_rejected',
  'executed',
  'awaiting_reply',
]);

function isSampleCenterReviewWorkflow(row = {}) {
  const raw = row.config_json || (row.config ? JSON.stringify(row.config) : '');
  try {
    const config = row.config || (raw ? JSON.parse(raw) : {});
    if (String(config.source || '') === SAMPLE_CENTER_REVIEW_SOURCE) return true;
  } catch (_) {}
  return String(row.name || '') === SAMPLE_CENTER_REVIEW_NAME;
}

function ensureSampleCenterReviewWorkflow(db, nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ')) {
  const existing = db.prepare(`
    SELECT * FROM agent_workflows
    WHERE IFNULL(json_extract(config_json, '$.source'), '') = ?
       OR name = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(SAMPLE_CENTER_REVIEW_SOURCE, SAMPLE_CENTER_REVIEW_NAME);
  if (existing) return existing;
  const now = nowText();
  const result = db.prepare(`
    INSERT INTO agent_workflows (name, active, run_state, config_json, created_at, updated_at)
    VALUES (?, 0, 'paused', ?, ?, ?)
  `).run(
    SAMPLE_CENTER_REVIEW_NAME,
    JSON.stringify({
      source: SAMPLE_CENTER_REVIEW_SOURCE,
      send_mode: 'manual',
      sample_approval_mode: 'manual',
    }),
    now,
    now,
  );
  return db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(Number(result.lastInsertRowid));
}

function isReviewableSample(sample = {}) {
  if (!sample || sample.applied_at == null || String(sample.applied_at).trim() === '') return false;
  const status = String(sample.status || '');
  if (!['pending', 'approved'].includes(status)) return false;
  if (sample.library_added_at) return false;
  if (status === 'approved' && sample.bd_id) return false;
  return true;
}

function pickReviewWorkflowId(sample, invite, centerWorkflow) {
  const source = String(invite?.source || '');
  const match = source.match(/^workflow:(\d+)$/);
  if (match) return Number(match[1]);
  return Number(centerWorkflow?.id || 0);
}

function loadSampleAuditTasks(db) {
  const rows = db.prepare(`
    SELECT id, workflow_id, task_type, status, shop_id, uid, sample_id, score, recommendation, reason,
      payload_json, score_details_json, review_standard_version, updated_at, created_at
    FROM agent_workflow_tasks
    WHERE task_type = 'sample_audit'
    ORDER BY id DESC
  `).all();
  const bySample = new Map();
  for (const row of rows) {
    const key = String(row.sample_id || '');
    if (!key || bySample.has(key)) continue;
    bySample.set(key, row);
  }
  return bySample;
}

function insertSampleAuditTask(db, { workflowId, sample, audit, nowText }) {
  const now = nowText();
  const payload = {
    phase: 'sample_application_review',
    sample,
    condition_audit: audit,
    report: {
      basic_data: {
        uid: sample.uid,
        name: sample.creator_name,
        handle: sample.creator_handle,
        fans: sample.fans,
        category: sample.category,
        avg_view: sample.avg_view,
        monthly_videos: sample.monthly_videos ?? sample.videos,
        orders_30d: sample.total_orders ?? sample.sales_count,
      },
      decision: audit.recommendation === 'auto_pass' ? '建议通过，等待管理员确认' : '建议人工复核',
      reason: audit.reason,
      checks: audit.checks || audit.score_details || [],
      score: audit.score,
      rule_source: audit.rule_source || 'review_standard',
    },
  };
  db.prepare(`
    INSERT INTO agent_workflow_tasks (
      workflow_id, task_type, status, shop_id, uid, creator_name, creator_handle,
      sample_id, score, recommendation, reason, payload_json, review_standard_version,
      score_details_json, created_at, updated_at
    )
    VALUES (?, 'sample_audit', 'agent_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id, task_type, uid, sample_id) DO UPDATE SET
      status = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.status
        ELSE excluded.status
      END,
      shop_id = excluded.shop_id,
      creator_name = excluded.creator_name,
      creator_handle = excluded.creator_handle,
      score = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.score
        ELSE excluded.score
      END,
      recommendation = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.recommendation
        ELSE excluded.recommendation
      END,
      reason = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.reason
        ELSE excluded.reason
      END,
      payload_json = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.payload_json
        ELSE excluded.payload_json
      END,
      review_standard_version = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.review_standard_version
        ELSE excluded.review_standard_version
      END,
      score_details_json = CASE
        WHEN agent_workflow_tasks.status IN ('application_confirmed','admin_approved','admin_rejected','executed','awaiting_reply') THEN agent_workflow_tasks.score_details_json
        ELSE excluded.score_details_json
      END,
      updated_at = excluded.updated_at
  `).run(
    workflowId,
    sample.shop_id || '',
    sample.uid || '',
    sample.creator_name || '',
    sample.creator_handle || '',
    sample.id,
    audit.score,
    audit.recommendation,
    audit.reason,
    JSON.stringify(payload),
    audit.review_standard_version || null,
    JSON.stringify(audit.score_details || audit.checks || []),
    now,
    now,
  );
}

function ensureSampleReviewTasks(db, options = {}) {
  const scoreSample = options.scoreSample;
  if (typeof scoreSample !== 'function') throw new Error('scoreSample is required');
  const nowText = options.nowText || (() => new Date().toISOString().slice(0, 19).replace('T', ' '));
  const pickInvite = options.pickInvite;
  const samples = options.samples || db.prepare(`
    SELECT * FROM samples
    WHERE applied_at IS NOT NULL
      AND IFNULL(library_added_at, '') = ''
      AND status IN ('pending', 'approved')
      AND (bd_id IS NULL OR status = 'pending')
  `).all();
  const centerWorkflow = ensureSampleCenterReviewWorkflow(db, nowText);
  const existingBySample = loadSampleAuditTasks(db);
  const invitesByUid = new Map();
  if (typeof pickInvite !== 'function') {
    const uids = [...new Set(samples.map((row) => row.uid).filter(Boolean))];
    const chunkSize = 200;
    for (let offset = 0; offset < uids.length; offset += chunkSize) {
      const chunk = uids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const invites = db.prepare(`
        SELECT id, source, uid, product_id, product_ids, status, template_type, sent_at, created_at
        FROM invitation_records
        WHERE uid IN (${placeholders})
          AND status = 'sent'
          AND COALESCE(template_type, '') NOT IN ('confirmation')
      `).all(...chunk);
      for (const invite of invites) {
        const key = String(invite.uid);
        if (!invitesByUid.has(key)) invitesByUid.set(key, []);
        invitesByUid.get(key).push(invite);
      }
    }
  }
  let created = 0;
  let updated = 0;
  for (const sample of samples) {
    if (!isReviewableSample(sample)) continue;
    const current = existingBySample.get(String(sample.id));
    if (current && PRESERVE_REVIEW_STATUSES.has(String(current.status || ''))) continue;
    const invite = typeof pickInvite === 'function'
      ? pickInvite(sample)
      : pickLatestMatchingInvite(invitesByUid.get(String(sample.uid || '')) || [], sample);
    const workflowId = current ? Number(current.workflow_id) : pickReviewWorkflowId(sample, invite, centerWorkflow);
    if (!workflowId) continue;
    insertSampleAuditTask(db, {
      workflowId,
      sample,
      audit: scoreSample(sample),
      nowText,
    });
    if (current) updated += 1;
    else created += 1;
  }
  return { created, updated, workflow_id: centerWorkflow.id };
}

function attachSampleReviewFields(db, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const bySample = loadSampleAuditTasks(db);
  return list.map((sample) => {
    const task = bySample.get(String(sample.id));
    if (!task) {
      return {
        ...sample,
        agent_score: null,
        agent_recommendation: null,
        agent_reason: null,
        agent_review_status: null,
        agent_review_task_id: null,
        agent_review_workflow_id: null,
      };
    }
    return {
      ...sample,
      agent_score: task.score == null ? null : Number(task.score),
      agent_recommendation: task.recommendation || null,
      agent_reason: task.reason || null,
      agent_review_status: task.status || null,
      agent_review_task_id: task.id || null,
      agent_review_workflow_id: task.workflow_id || null,
    };
  });
}

module.exports = {
  SAMPLE_CENTER_REVIEW_SOURCE,
  SAMPLE_CENTER_REVIEW_NAME,
  isSampleCenterReviewWorkflow,
  ensureSampleCenterReviewWorkflow,
  isReviewableSample,
  pickReviewWorkflowId,
  ensureSampleReviewTasks,
  attachSampleReviewFields,
};
