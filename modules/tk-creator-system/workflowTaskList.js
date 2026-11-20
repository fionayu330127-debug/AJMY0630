// workflowTaskList.js — unified automation-workflow task list helpers.
// Extracted so offline tests can cover count aggregation and status labels
// without starting the HTTP server or calling TikTok APIs.

const CONFIRMED_SAMPLE_AUDIT_STATUSES = ['application_confirmed', 'admin_approved', 'executed'];

function isUsableWorkflowName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  // Some historical rows were saved with only question marks after an encoding loss.
  if (/^\?+$/.test(trimmed)) return false;
  return true;
}

function workflowDisplayName(workflow) {
  const name = String(workflow?.name || '').trim();
  const id = workflow?.id;
  if (isUsableWorkflowName(name)) return name;
  return id != null && id !== '' ? `未命名工作流 #${id}` : '未命名工作流';
}

function workflowStatusLabel({ workflowActive = true, agentPaused = false, autoInviteActive = true } = {}) {
  if (!workflowActive) return '已结束';
  // A globally paused Agent, or a turned-off auto_invite flow, must not look like it is still sending.
  if (agentPaused || !autoInviteActive) return '已暂停';
  return '进行中';
}

function workflowStatusRank(status) {
  if (status === '进行中') return 0;
  if (status === '已暂停') return 1;
  return 2;
}

function parseUtcDate(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(hasZone ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatShanghaiDateTime(text) {
  const date = parseUtcDate(text);
  if (!date) return text ? String(text) : '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function formatShanghaiDate(text) {
  return String(formatShanghaiDateTime(text) || '').slice(0, 10);
}

function laterText(left, right) {
  const leftDate = parseUtcDate(left);
  const rightDate = parseUtcDate(right);
  if (!leftDate) return right || left || '';
  if (!rightDate) return left || right || '';
  return rightDate.getTime() >= leftDate.getTime() ? right : left;
}

function mapWorkflowTaskRow(row, context = {}) {
  const status = workflowStatusLabel({
    workflowActive: Number(row.active) === 1,
    agentPaused: Boolean(context.agentPaused),
    autoInviteActive: context.autoInviteActive !== false,
  });
  const createdAt = row.created_at || '';
  const lastActivityAt = row.last_activity_at || row.updated_at || createdAt;
  return {
    ...row,
    display_name: workflowDisplayName(row),
    status,
    status_label: status,
    invited_count: Number(row.invited_count || 0),
    sent_invite_count: Number(row.sent_invite_count ?? row.invited_count ?? 0),
    sample_applicant_count: Number(row.sample_applicant_count || 0),
    confirmed_review_count: Number(row.confirmed_review_count || 0),
    sample_pending_count: Number(row.sample_pending_count || 0),
    sample_recommended_count: Number(row.sample_recommended_count || 0),
    task_count: Number(row.task_count || 0),
    failed_count: Number(row.failed_count || 0),
    created_at: createdAt,
    last_activity_at: lastActivityAt,
    created_date_shanghai: formatShanghaiDate(createdAt),
    created_at_shanghai: formatShanghaiDateTime(createdAt),
    last_activity_shanghai: formatShanghaiDateTime(lastActivityAt),
    date_label: '创建日期（北京时间）',
  };
}

function sortWorkflowTasks(rows) {
  return [...rows].sort((a, b) => {
    const rank = workflowStatusRank(a.status) - workflowStatusRank(b.status);
    if (rank) return rank;
    const activity = (parseUtcDate(b.last_activity_at)?.getTime() || 0) - (parseUtcDate(a.last_activity_at)?.getTime() || 0);
    if (activity) return activity;
    const created = (parseUtcDate(b.created_at)?.getTime() || 0) - (parseUtcDate(a.created_at)?.getTime() || 0);
    if (created) return created;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

function listWorkflowTasks(db, options = {}) {
  const rows = db.prepare(`
    SELECT
      w.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      (SELECT COUNT(DISTINCT r.uid) FROM invitation_records r
        WHERE r.source = 'workflow:' || w.id AND r.status = 'sent') AS invited_count,
      (SELECT COUNT(DISTINCT r.uid) FROM invitation_records r
        WHERE r.source = 'workflow:' || w.id AND r.status = 'sent') AS sent_invite_count,
      (SELECT COUNT(DISTINCT uid) FROM (
        SELECT s.uid AS uid
        FROM samples s
        JOIN invitation_records r
          ON r.source = 'workflow:' || w.id
         AND r.uid = s.uid
         AND COALESCE(r.template_type, '') NOT IN ('confirmation')
        WHERE s.applied_at IS NOT NULL
        UNION
        SELECT t.uid
        FROM agent_workflow_tasks t
        JOIN samples s2 ON CAST(s2.id AS TEXT) = CAST(t.sample_id AS TEXT)
        WHERE t.workflow_id = w.id
          AND t.task_type IN ('sample_audit', 'sample_message')
          AND IFNULL(t.uid, '') <> ''
          AND s2.applied_at IS NOT NULL
      )) AS sample_applicant_count,
      (SELECT COUNT(DISTINCT t4.uid) FROM agent_workflow_tasks t4
        WHERE t4.workflow_id = w.id
          AND t4.task_type = 'sample_audit'
          AND t4.status IN ('application_confirmed', 'admin_approved', 'executed')) AS confirmed_review_count,
      (SELECT COUNT(DISTINCT t2.uid) FROM agent_workflow_tasks t2
        JOIN samples s2 ON CAST(s2.id AS TEXT) = CAST(t2.sample_id AS TEXT)
        WHERE t2.workflow_id = w.id AND t2.task_type = 'sample_audit' AND t2.status = 'agent_review'
          AND EXISTS (
            SELECT 1 FROM invitation_records wr2
            WHERE wr2.source = 'workflow:' || w.id AND wr2.template_type = 'collab'
              AND wr2.uid = s2.uid
              AND (wr2.product_id = s2.product_id OR instr(COALESCE(wr2.product_ids, ''), '"' || s2.product_id || '"') > 0)
          )) AS sample_pending_count,
      (SELECT COUNT(DISTINCT t3.uid) FROM agent_workflow_tasks t3
        JOIN samples s3 ON CAST(s3.id AS TEXT) = CAST(t3.sample_id AS TEXT)
        WHERE t3.workflow_id = w.id AND t3.task_type = 'sample_audit' AND t3.status = 'agent_review'
          AND t3.recommendation IN ('auto_pass', 'review_pass')
          AND EXISTS (
            SELECT 1 FROM invitation_records wr3
            WHERE wr3.source = 'workflow:' || w.id AND wr3.template_type = 'collab'
              AND wr3.uid = s3.uid
              AND (wr3.product_id = s3.product_id OR instr(COALESCE(wr3.product_ids, ''), '"' || s3.product_id || '"') > 0)
          )) AS sample_recommended_count,
      COALESCE(
        (
          SELECT MAX(ts)
          FROM (
            SELECT MAX(COALESCE(r.sent_at, r.created_at)) AS ts
            FROM invitation_records r
            WHERE r.source = 'workflow:' || w.id
            UNION ALL
            SELECT MAX(COALESCE(tk.updated_at, tk.created_at))
            FROM agent_workflow_tasks tk
            WHERE tk.workflow_id = w.id
          )
        ),
        w.updated_at,
        w.created_at
      ) AS last_activity_at
    FROM agent_workflows w
    LEFT JOIN agent_workflow_tasks t ON t.workflow_id = w.id
    GROUP BY w.id
  `).all();

  const mapped = rows.map((row) => mapWorkflowTaskRow(row, options));
  return sortWorkflowTasks(mapped);
}

function workflowCreatorSummaryQuery(kind) {
  if (kind === 'sent') {
    return {
      sql: `
        SELECT r.uid, r.creator_name, r.creator_handle, r.shop_id, r.status, r.sent_at, r.created_at
        FROM invitation_records r
        WHERE r.source = ? AND r.status = 'sent'
        GROUP BY r.uid
        ORDER BY datetime(COALESCE(r.sent_at, r.created_at)) DESC, r.id DESC
      `,
      params: (workflowId) => [`workflow:${workflowId}`],
    };
  }
  if (kind === 'applicants') {
    return {
      sql: `
        SELECT s.uid, s.creator_name, s.creator_handle, s.shop_id, s.status AS sample_status,
          s.applied_at, p.name AS product_name
        FROM samples s
        LEFT JOIN products p ON p.id = s.product_id
        WHERE s.applied_at IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM invitation_records r
              WHERE r.source = ?
                AND r.uid = s.uid
                AND COALESCE(r.template_type, '') NOT IN ('confirmation')
            )
            OR EXISTS (
              SELECT 1 FROM agent_workflow_tasks t
              WHERE t.workflow_id = ?
                AND t.task_type IN ('sample_audit', 'sample_message')
                AND (t.uid = s.uid OR CAST(t.sample_id AS TEXT) = CAST(s.id AS TEXT))
            )
          )
        GROUP BY s.uid
        ORDER BY datetime(s.applied_at) DESC, s.id DESC
      `,
      params: (workflowId) => [`workflow:${workflowId}`, workflowId],
    };
  }
  if (kind === 'confirmed') {
    return {
      sql: `
        SELECT t.uid, t.creator_name, t.creator_handle, t.shop_id,
          t.sample_id, t.score, t.recommendation, t.reason, t.status, t.updated_at,
          s.status AS sample_status, s.applied_at, p.name AS product_name
        FROM agent_workflow_tasks t
        LEFT JOIN samples s ON CAST(s.id AS TEXT) = CAST(t.sample_id AS TEXT)
        LEFT JOIN products p ON p.id = s.product_id
        WHERE t.workflow_id = ? AND t.task_type = 'sample_audit'
          AND t.status IN ('application_confirmed', 'admin_approved', 'executed')
        GROUP BY t.uid
        ORDER BY datetime(t.updated_at) DESC, t.id DESC
      `,
      params: (workflowId) => [workflowId],
    };
  }
  const recommendationFilter = kind === 'recommended' ? "AND t.recommendation IN ('auto_pass', 'review_pass')" : '';
  return {
    sql: `
      SELECT t.id AS task_id, t.uid, t.creator_name, t.creator_handle, t.shop_id,
        t.sample_id, t.score, t.recommendation, t.reason, t.status, t.updated_at,
        s.status AS sample_status, s.applied_at, p.name AS product_name
      FROM agent_workflow_tasks t
      LEFT JOIN samples s ON CAST(s.id AS TEXT) = CAST(t.sample_id AS TEXT)
      LEFT JOIN products p ON p.id = s.product_id
      WHERE t.workflow_id = ? AND t.task_type = 'sample_audit'
        AND t.status = 'agent_review' ${recommendationFilter}
        AND EXISTS (
          SELECT 1 FROM invitation_records wr
          WHERE wr.source = 'workflow:' || t.workflow_id AND wr.template_type = 'collab'
            AND wr.uid = t.uid
            AND (wr.product_id = s.product_id OR instr(COALESCE(wr.product_ids, ''), '"' || s.product_id || '"') > 0)
        )
      ORDER BY datetime(t.updated_at) DESC, t.id DESC
    `,
    params: (workflowId) => [workflowId],
  };
}

module.exports = {
  CONFIRMED_SAMPLE_AUDIT_STATUSES,
  workflowDisplayName,
  workflowStatusLabel,
  workflowStatusRank,
  formatShanghaiDateTime,
  formatShanghaiDate,
  laterText,
  mapWorkflowTaskRow,
  sortWorkflowTasks,
  listWorkflowTasks,
  workflowCreatorSummaryQuery,
};
