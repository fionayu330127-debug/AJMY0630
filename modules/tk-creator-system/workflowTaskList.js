// workflowTaskList.js — unified automation-workflow task list helpers.
// Extracted so offline tests can cover count aggregation, status labels,
// and per-task pause/resume without starting the HTTP server or calling TikTok APIs.

const CONFIRMED_SAMPLE_AUDIT_STATUSES = ['application_confirmed', 'admin_approved', 'executed'];
const WORKFLOW_RUN_RUNNING = 'running';
const WORKFLOW_RUN_PAUSED = 'paused';

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

function ensureWorkflowRunStateColumn(db) {
  if (!db) return false;
  try {
    db.exec(`ALTER TABLE agent_workflows ADD COLUMN run_state TEXT NOT NULL DEFAULT '${WORKFLOW_RUN_PAUSED}'`);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeWorkflowRunState(value) {
  return String(value || '').trim().toLowerCase() === WORKFLOW_RUN_RUNNING
    ? WORKFLOW_RUN_RUNNING
    : WORKFLOW_RUN_PAUSED;
}

function parseWorkflowConfig(row) {
  if (row?.config && typeof row.config === 'object' && !Array.isArray(row.config)) return row.config;
  const raw = row?.config_json;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function usesMarketplaceInviteSource(source) {
  const value = String(source || 'marketplace_search');
  return value === 'marketplace_search' || value === 'shop_pool' || value === '';
}

function workflowIsMarketplaceInvite(row) {
  return usesMarketplaceInviteSource(parseWorkflowConfig(row).source);
}

function defaultNowText() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Status is the task's own state. A global Agent pause must not relabel every
// historical active=1 workflow as 已暂停, and a running Agent must not make
// every active=1 workflow look 进行中.
function workflowStatusLabel({ workflowActive = true, runState = WORKFLOW_RUN_PAUSED } = {}) {
  if (!workflowActive) return '已结束';
  return normalizeWorkflowRunState(runState) === WORKFLOW_RUN_RUNNING ? '进行中' : '已暂停';
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


function sqlNormalizedInviteProductIds(inviteAlias) {
  return `',' || REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${inviteAlias}.product_ids, ''), ' ', ''), '"', ''), '[', ''), ']', '') || ','`;
}

function sqlInviteProductMatchesSample(inviteAlias, sampleAlias) {
  return `(
    ${sampleAlias}.product_id IS NOT NULL
    AND (
      CAST(${inviteAlias}.product_id AS TEXT) = CAST(${sampleAlias}.product_id AS TEXT)
      OR instr(${sqlNormalizedInviteProductIds(inviteAlias)}, ',' || CAST(${sampleAlias}.product_id AS TEXT) || ',') > 0
    )
  )`;
}

// A sample counts for a workflow only when this workflow successfully invited
// the same creator for the same product, and applied_at is at or after that
// invite's sent time (sent_at, else created_at). Confirmation messages and
// unsent invites do not count. The old sample_audit/sample_message fallback is
// intentionally omitted so older or wrong-product applications are not attributed.
function sqlSampleIsWorkflowApplicant(sampleAlias, sourceSql) {
  const inviteAlias = `${sampleAlias}_wf_invite`;
  return `EXISTS (
    SELECT 1 FROM invitation_records ${inviteAlias}
    WHERE ${inviteAlias}.source = ${sourceSql}
      AND ${inviteAlias}.uid = ${sampleAlias}.uid
      AND ${inviteAlias}.status = 'sent'
      AND COALESCE(${inviteAlias}.template_type, '') NOT IN ('confirmation')
      AND ${sqlInviteProductMatchesSample(inviteAlias, sampleAlias)}
      AND datetime(${sampleAlias}.applied_at) >= datetime(COALESCE(${inviteAlias}.sent_at, ${inviteAlias}.created_at))
  )`;
}

function inviteEventAt(row = {}) {
  return row.sent_at || row.created_at || '';
}

function productIdsContain(raw, productId) {
  if (productId == null || productId === '') return false;
  const normalized = `,${String(raw || '').replace(/[ \]"\[]/g, '')},`;
  return normalized.includes(`,${String(productId)},`);
}

function invitationMatchesSampleProduct(invite, sample) {
  if (sample == null || sample.product_id == null || sample.product_id === '') return false;
  const productId = String(sample.product_id);
  if (invite.product_id != null && invite.product_id !== '' && String(invite.product_id) === productId) return true;
  return productIdsContain(invite.product_ids, productId);
}

function invitationAppliesToSample(invite, sample) {
  if (!invite || !sample) return false;
  if (String(invite.uid || '') !== String(sample.uid || '')) return false;
  if (String(invite.status || '') !== 'sent') return false;
  if (String(invite.template_type || '') === 'confirmation') return false;
  if (!invitationMatchesSampleProduct(invite, sample)) return false;
  const appliedAt = String(sample.applied_at || '');
  const invitedAt = String(inviteEventAt(invite));
  if (!appliedAt || !invitedAt) return false;
  return appliedAt >= invitedAt;
}

function workflowIdFromInviteSource(source) {
  const match = String(source || '').match(/^workflow:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function classifyInviteSource(source) {
  const value = String(source || '');
  if (!value) return 'unmatched';
  if (value.startsWith('workflow_sample:')) return 'unmatched';
  if (/^workflow:\d+$/.test(value)) return 'workflow';
  return 'manual';
}

function manualInviteSourceLabel(source) {
  const value = String(source || '');
  if (value === 'shop_pool') return '人工邀约（邀约中心 · 达人池）';
  if (value === 'library') return '人工邀约（邀约中心 · 合作达人库）';
  if (value === 'import') return '人工邀约（邀约中心 · 导入）';
  return '人工邀约（邀约中心）';
}

function pickLatestMatchingInvite(invites, sample) {
  const matches = (invites || []).filter((invite) => invitationAppliesToSample(invite, sample));
  matches.sort((left, right) => {
    const leftAt = inviteEventAt(left);
    const rightAt = inviteEventAt(right);
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return Number(right.id || 0) - Number(left.id || 0);
  });
  return matches[0] || null;
}

function attachSampleInviteSources(db, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const uids = [...new Set(list.map((row) => row.uid).filter((uid) => uid != null && String(uid) !== ''))];
  const invitesByUid = new Map();
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

  const workflowIds = new Set();
  const chosen = list.map((sample) => pickLatestMatchingInvite(invitesByUid.get(String(sample.uid || '')) || [], sample));
  chosen.forEach((invite) => {
    const workflowId = workflowIdFromInviteSource(invite?.source);
    if (workflowId) workflowIds.add(workflowId);
  });
  const workflowNames = new Map();
  if (workflowIds.size) {
    const ids = [...workflowIds];
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`SELECT id, name, active FROM agent_workflows WHERE id IN (${placeholders})`).all(...ids).forEach((row) => {
      workflowNames.set(Number(row.id), workflowDisplayName(row));
    });
  }

  return list.map((sample, index) => {
    const invite = chosen[index];
    if (!invite) {
      return {
        ...sample,
        invite_source_kind: null,
        invite_source_label: '',
        invite_source_detail: '',
        invite_source: null,
        invite_workflow_id: null,
        invite_workflow_name: null,
        matched_invitation_record_id: null,
      };
    }
    const kind = classifyInviteSource(invite.source);
    if (kind !== 'workflow' && kind !== 'manual') {
      return {
        ...sample,
        invite_source_kind: null,
        invite_source_label: '',
        invite_source_detail: '',
        invite_source: null,
        invite_workflow_id: null,
        invite_workflow_name: null,
        matched_invitation_record_id: null,
      };
    }
    if (kind === 'workflow') {
      const workflowId = workflowIdFromInviteSource(invite.source);
      const workflowName = workflowNames.get(workflowId) || (workflowId ? `工作流 #${workflowId}` : '');
      return {
        ...sample,
        invite_source_kind: 'workflow',
        invite_source_label: workflowName ? `自动化任务：${workflowName}` : '自动化任务',
        invite_source_detail: workflowName ? `由自动化工作流「${workflowName}」发送的邀约` : '由自动化工作流发送的邀约',
        invite_source: invite.source,
        invite_workflow_id: workflowId,
        invite_workflow_name: workflowName || null,
        matched_invitation_record_id: invite.id,
      };
    }
    return {
      ...sample,
      invite_source_kind: 'manual',
      invite_source_label: manualInviteSourceLabel(invite.source),
      invite_source_detail: `ERP 邀约中心发出，来源标记为 ${invite.source || 'unknown'}`,
      invite_source: invite.source,
      invite_workflow_id: null,
      invite_workflow_name: null,
      matched_invitation_record_id: invite.id,
    };
  });
}

function mapWorkflowTaskRow(row, context = {}) {
  const active = Number(row.active) === 1;
  const runState = normalizeWorkflowRunState(row.run_state);
  const status = workflowStatusLabel({
    workflowActive: active,
    runState,
  });
  const createdAt = row.created_at || '';
  const lastActivityAt = row.last_activity_at || row.updated_at || createdAt;
  const isMarketplace = workflowIsMarketplaceInvite(row);
  return {
    ...row,
    display_name: workflowDisplayName(row),
    run_state: active ? runState : WORKFLOW_RUN_PAUSED,
    status,
    status_label: status,
    invited_count: Number(row.invited_count || 0),
    sent_invite_count: Number(row.sent_invite_count ?? row.invited_count ?? 0),
    sample_applicant_count: Number(row.sample_applicant_count || 0),
    confirmed_review_count: Number(row.confirmed_review_count || 0),
    admin_confirmed_review_count: Number(row.admin_confirmed_review_count ?? row.confirmed_review_count ?? 0),
    agent_review_count: Number(row.agent_review_count || 0),
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
    is_marketplace_invite: isMarketplace,
    can_pause: active && runState === WORKFLOW_RUN_RUNNING,
    can_resume: !active || runState !== WORKFLOW_RUN_RUNNING,
    agent_paused: Boolean(context.agentPaused),
    auto_invite_active: context.autoInviteActive !== false,
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
  ensureWorkflowRunStateColumn(db);
  const rows = db.prepare(`
    SELECT
      w.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      (SELECT COUNT(DISTINCT r.uid) FROM invitation_records r
        WHERE r.source = 'workflow:' || w.id AND r.status = 'sent') AS invited_count,
      (SELECT COUNT(DISTINCT r.uid) FROM invitation_records r
        WHERE r.source = 'workflow:' || w.id AND r.status = 'sent') AS sent_invite_count,
      (SELECT COUNT(DISTINCT s.uid) FROM samples s
        WHERE s.applied_at IS NOT NULL
          AND ${sqlSampleIsWorkflowApplicant('s', "'workflow:' || w.id")}) AS sample_applicant_count,
      (SELECT COUNT(DISTINCT t4.uid) FROM agent_workflow_tasks t4
        WHERE t4.workflow_id = w.id
          AND t4.task_type = 'sample_audit'
          AND t4.status IN ('application_confirmed', 'admin_approved', 'executed')) AS confirmed_review_count,
      (SELECT COUNT(DISTINCT t4.uid) FROM agent_workflow_tasks t4
        WHERE t4.workflow_id = w.id
          AND t4.task_type = 'sample_audit'
          AND t4.status IN ('application_confirmed', 'admin_approved', 'executed')) AS admin_confirmed_review_count,
      (SELECT COUNT(DISTINCT t5.uid) FROM agent_workflow_tasks t5
        WHERE t5.workflow_id = w.id
          AND t5.task_type = 'sample_audit'
          AND IFNULL(t5.uid, '') <> ''
          AND (
            IFNULL(t5.recommendation, '') <> ''
            OR t5.score IS NOT NULL
            OR (
              IFNULL(t5.score_details_json, '') <> ''
              AND lower(trim(t5.score_details_json)) NOT IN ('[]', 'null')
            )
          )) AS agent_review_count,
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
    WHERE IFNULL(json_extract(w.config_json, '$.source'), '') <> 'sample_center'
    GROUP BY w.id
  `).all();

  const mapped = rows.map((row) => mapWorkflowTaskRow(row, options));
  return sortWorkflowTasks(mapped);
}

function listRunningWorkflows(db) {
  ensureWorkflowRunStateColumn(db);
  return db.prepare(`
    SELECT * FROM agent_workflows
    WHERE active = 1 AND run_state = ?
    ORDER BY updated_at DESC, id DESC
  `).all(WORKFLOW_RUN_RUNNING);
}

function getRunningMarketplaceWorkflow(db) {
  return listRunningWorkflows(db).find((row) => workflowIsMarketplaceInvite(row)) || null;
}

function liveInviteTargetWorkflow(rows = []) {
  const marketplace = (rows || []).filter((row) => row.is_marketplace_invite || workflowIsMarketplaceInvite(row));
  if (!marketplace.length) return null;
  return marketplace.find((row) => row.status === '进行中' || normalizeWorkflowRunState(row.run_state) === WORKFLOW_RUN_RUNNING)
    || marketplace[0]
    || null;
}

function invitePacerSummary(status = {}, extras = {}) {
  const shops = Array.isArray(status.shops) ? status.shops : [];
  const sentToday = extras.sent_today != null
    ? Number(extras.sent_today || 0)
    : shops.reduce((sum, shop) => sum + Number(shop.sent_today || 0), 0);
  return {
    send_interval_ms: Number(status.send_interval_ms || 20000),
    search_interval_ms: Number(status.search_interval_ms || 90000),
    day: status.day || '',
    timezone: status.timezone || 'Asia/Shanghai',
    pacer_running: Boolean(status.pacer_running),
    enabled: Boolean(status.enabled),
    sent_today: sentToday,
    daily_limit: Number(extras.daily_limit ?? status.default_daily_limit ?? 1000),
    agent_paused: Boolean(extras.agentPaused ?? extras.agent_paused),
  };
}

function pauseWorkflowTask(db, workflowId, options = {}) {
  ensureWorkflowRunStateColumn(db);
  const id = Number(workflowId || 0);
  const row = db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(id);
  if (!row) throw new Error('工作流不存在');
  const now = (options.nowText || defaultNowText)();
  if (Number(row.active) !== 1) {
    return { workflow: row, changed: false, paused_pending_kept: true };
  }
  if (normalizeWorkflowRunState(row.run_state) === WORKFLOW_RUN_PAUSED) {
    return { workflow: row, changed: false, paused_pending_kept: true };
  }
  db.prepare('UPDATE agent_workflows SET run_state = ?, updated_at = ? WHERE id = ?')
    .run(WORKFLOW_RUN_PAUSED, now, id);
  return {
    workflow: db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(id),
    changed: true,
    paused_pending_kept: true,
  };
}

function resumeWorkflowTask(db, workflowId, options = {}) {
  ensureWorkflowRunStateColumn(db);
  const id = Number(workflowId || 0);
  const row = db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(id);
  if (!row) throw new Error('工作流不存在');
  const now = (options.nowText || defaultNowText)();
  const globalPaused = Boolean(options.globalPaused);
  const pausedOthers = [];

  // Never start every historical active=1 workflow. Only this task becomes running.
  // If the global Agent was paused, first mark every other active workflow as
  // individually paused so clearing the master switch cannot resume them.
  const others = globalPaused
    ? db.prepare('SELECT * FROM agent_workflows WHERE id != ? AND active = 1').all(id)
    : db.prepare('SELECT * FROM agent_workflows WHERE id != ? AND active = 1 AND run_state = ?').all(id, WORKFLOW_RUN_RUNNING);

  // Starting a marketplace search-invite task also pauses any other running
  // search-invite task (shared official rate limits and the 1000/day cap).
  const startingMarketplace = workflowIsMarketplaceInvite(row) || Number(row.active) === 0 && usesMarketplaceInviteSource(parseWorkflowConfig(row).source);
  const exclusiveOthers = startingMarketplace
    ? db.prepare('SELECT * FROM agent_workflows WHERE id != ? AND active = 1 AND run_state = ?').all(id, WORKFLOW_RUN_RUNNING)
      .filter((item) => workflowIsMarketplaceInvite(item))
    : [];

  const byId = new Map();
  for (const item of [...others, ...exclusiveOthers]) byId.set(Number(item.id), item);
  for (const item of byId.values()) {
    const wasRunning = normalizeWorkflowRunState(item.run_state) === WORKFLOW_RUN_RUNNING;
    if (wasRunning || globalPaused) {
      db.prepare('UPDATE agent_workflows SET run_state = ?, updated_at = ? WHERE id = ? AND active = 1')
        .run(WORKFLOW_RUN_PAUSED, now, item.id);
    }
    if (wasRunning) {
      pausedOthers.push({
        id: Number(item.id),
        name: workflowDisplayName(item),
        was_running: true,
      });
    }
  }

  db.prepare('UPDATE agent_workflows SET active = 1, run_state = ?, updated_at = ? WHERE id = ?')
    .run(WORKFLOW_RUN_RUNNING, now, id);

  return {
    workflow: db.prepare('SELECT * FROM agent_workflows WHERE id = ?').get(id),
    paused_workflows: pausedOthers,
    paused_workflow_ids: pausedOthers.map((item) => item.id),
    cleared_global_pause: globalPaused,
    started_only_this_task: true,
  };
}


function parseJsonValue(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(String(value).replace(/,/g, ''));
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function checkByMetric(checks, metric) {
  return (Array.isArray(checks) ? checks : []).find((item) => String(item?.metric || '').toLowerCase() === metric) || null;
}

function creatorProfileUrl(row = {}) {
  const explicit = String(row.profile_url || row.tiktok_url || row.creator_url || '').trim();
  if (/^https?:\/\/(?:www\.)?tiktok\.com\//i.test(explicit)) return explicit;
  const rawHandle = String(row.creator_handle || row.handle || '').trim();
  if (/^https?:\/\/(?:www\.)?tiktok\.com\//i.test(rawHandle)) return rawHandle;
  const handle = rawHandle.replace(/^@+/, '');
  // Do not invent a handle from uid/open_id; only use a real username.
  if (!handle || !/^[A-Za-z0-9._]+$/.test(handle)) return '';
  return `https://www.tiktok.com/@${handle}`;
}

function creatorReviewChecks(row = {}) {
  const fromColumn = parseJsonValue(row.score_details_json, null);
  if (Array.isArray(fromColumn) && fromColumn.length) return fromColumn;
  const payload = parseJsonValue(row.payload_json, {});
  const nested = payload?.report?.checks || payload?.condition_audit?.checks || payload?.audit?.checks || payload?.score_details;
  return Array.isArray(nested) ? nested : [];
}

function mapCreatorReviewRow(row = {}) {
  const payload = parseJsonValue(row.payload_json, {});
  const basic = payload?.report?.basic_data || payload?.sample || {};
  const checks = creatorReviewChecks(row);
  const fans = firstFiniteNumber(row.fans, basic.fans, checkByMetric(checks, 'fans')?.actual);
  const orders30d = firstFiniteNumber(
    row.orders_30d,
    row.sales_count,
    row.sales_count_30d,
    basic.orders_30d,
    basic.monthly_orders,
    basic.total_orders,
    checkByMetric(checks, 'orders')?.actual,
  );
  const avgView = firstFiniteNumber(row.avg_view, basic.avg_view, basic.monthly_avg_view, checkByMetric(checks, 'views')?.actual);
  const monthlyVideos = firstFiniteNumber(
    row.monthly_videos,
    row.videos,
    row.videos_30d,
    basic.monthly_videos,
    basic.videos_30d,
    checkByMetric(checks, 'videos')?.actual,
  );
  const conversionCheck = checkByMetric(checks, 'conversion');
  const conversion = firstFiniteNumber(row.conversion, conversionCheck?.actual, monthlyVideos > 0 ? orders30d / monthlyVideos : null);
  const profileUrl = creatorProfileUrl(row);
  return {
    ...row,
    display_name: String(row.creator_name || row.creator_handle || row.uid || '').trim() || '未命名达人',
    profile_url: profileUrl,
    fans,
    orders_30d: orders30d,
    avg_view: avgView,
    monthly_videos: monthlyVideos,
    conversion,
    score: firstFiniteNumber(row.score),
    recommendation: row.recommendation || '',
    agent_result: row.recommendation || '',
    checks,
    metrics: {
      fans,
      orders_30d: orders30d,
      avg_view: avgView,
      monthly_videos: monthlyVideos,
      conversion,
      score: firstFiniteNumber(row.score),
    },
  };
}

function agentReviewTaskFilter(alias = 't') {
  return `
    IFNULL(${alias}.uid, '') <> ''
    AND (
      IFNULL(${alias}.recommendation, '') <> ''
      OR ${alias}.score IS NOT NULL
      OR (
        IFNULL(${alias}.score_details_json, '') <> ''
        AND lower(trim(${alias}.score_details_json)) NOT IN ('[]', 'null')
      )
    )
  `;
}

function creatorReviewSelectSql(whereClause) {
  return `
    SELECT t.id AS task_id, t.uid, t.creator_name, t.creator_handle, t.shop_id,
      t.sample_id, t.score, t.recommendation, t.reason, t.status, t.updated_at,
      t.payload_json, t.score_details_json,
      s.status AS sample_status, s.applied_at, s.fans, s.videos, s.avg_view,
      p.name AS product_name
    FROM agent_workflow_tasks t
    LEFT JOIN samples s ON CAST(s.id AS TEXT) = CAST(t.sample_id AS TEXT)
    LEFT JOIN products p ON p.id = s.product_id
    WHERE ${whereClause}
      AND t.id = (
        SELECT t1.id FROM agent_workflow_tasks t1
        WHERE t1.workflow_id = t.workflow_id
          AND t1.task_type = t.task_type
          AND t1.uid = t.uid
          AND (${whereClause.replaceAll('t.', 't1.')})
        ORDER BY datetime(COALESCE(t1.updated_at, t1.created_at)) DESC, t1.id DESC
        LIMIT 1
      )
    ORDER BY datetime(COALESCE(t.updated_at, t.created_at)) DESC, t.id DESC
  `;
}

function listWorkflowCreatorSummary(db, workflowId, kind) {
  const query = workflowCreatorSummaryQuery(kind);
  if (!query) return [];
  const rows = db.prepare(query.sql).all(...query.params(Number(workflowId || 0)));
  if (['agent', 'confirmed', 'pending', 'recommended'].includes(kind)) {
    return rows.map(mapCreatorReviewRow);
  }
  return rows.map((row) => ({
    ...row,
    display_name: String(row.creator_name || row.creator_handle || row.uid || '').trim() || '未命名达人',
    profile_url: creatorProfileUrl(row),
  }));
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
    const applicantMatch = sqlSampleIsWorkflowApplicant('s', '?');
    const latestMatch = sqlSampleIsWorkflowApplicant('s2', '?');
    return {
      sql: `
        SELECT s.uid, s.creator_name, s.creator_handle, s.shop_id, s.status AS sample_status,
          s.applied_at, p.name AS product_name
        FROM samples s
        LEFT JOIN products p ON p.id = s.product_id
        WHERE s.applied_at IS NOT NULL
          AND ${applicantMatch}
          AND s.id = (
            SELECT s2.id FROM samples s2
            WHERE s2.uid = s.uid
              AND s2.applied_at IS NOT NULL
              AND ${latestMatch}
            ORDER BY datetime(s2.applied_at) DESC, s2.id DESC
            LIMIT 1
          )
        ORDER BY datetime(s.applied_at) DESC, s.id DESC
      `,
      params: (workflowId) => {
        const source = `workflow:${Number(workflowId || 0)}`;
        return [source, source];
      },
    };
  }
  if (kind === 'agent') {
    return {
      sql: creatorReviewSelectSql(`
        t.workflow_id = ?
        AND t.task_type = 'sample_audit'
        AND ${agentReviewTaskFilter('t')}
      `),
      params: (workflowId) => [workflowId, workflowId],
    };
  }
  if (kind === 'confirmed') {
    return {
      sql: creatorReviewSelectSql(`
        t.workflow_id = ?
        AND t.task_type = 'sample_audit'
        AND t.status IN ('application_confirmed', 'admin_approved', 'executed')
      `),
      params: (workflowId) => [workflowId, workflowId],
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
  WORKFLOW_RUN_RUNNING,
  WORKFLOW_RUN_PAUSED,
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
  listWorkflowCreatorSummary,
  sqlInviteProductMatchesSample,
  sqlSampleIsWorkflowApplicant,
  invitationMatchesSampleProduct,
  invitationAppliesToSample,
  classifyInviteSource,
  attachSampleInviteSources,
  pickLatestMatchingInvite,
  creatorProfileUrl,
  mapCreatorReviewRow,
  ensureWorkflowRunStateColumn,
  normalizeWorkflowRunState,
  parseWorkflowConfig,
  usesMarketplaceInviteSource,
  workflowIsMarketplaceInvite,
  listRunningWorkflows,
  getRunningMarketplaceWorkflow,
  liveInviteTargetWorkflow,
  invitePacerSummary,
  pauseWorkflowTask,
  resumeWorkflowTask,
};
