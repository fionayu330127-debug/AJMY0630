// marketplaceSearchInvite.js — 查找达人：边搜边邀、全天匀速补货
// 只请求官方 marketplace_creators/search 的 1 页，不把全量联盟池同步当作邀约前置步骤。

const DEFAULT_SEARCH_PATH = '/affiliate_seller/202508/marketplace_creators/search';
const DEFAULT_QUOTA_PATH = '/affiliate_seller/202607/creator_outreach/quota';
const DEFAULT_SEND_INTERVAL_MS = 20000;
const DEFAULT_SEARCH_INTERVAL_MS = 90000;
const DEFAULT_DAILY_LIMIT = 1000;
const DEFAULT_QUOTA_CACHE_MS = 10 * 60 * 1000;
const MIN_QUOTA_CACHE_MS = 5 * 60 * 1000;
const MAX_QUOTA_CACHE_MS = 15 * 60 * 1000;
const QUEUE_BUFFER = 20;
const TICK_MS = 5000;
const CREATOR_QUOTA_CODES = new Set([16030100, 16024049]);
const QUERY_QUOTA_CODES = new Set([45101004]);

const DEFAULT_BASE_BODY = {
  affiliate_data: { not_invited_l90_days: true },
  data_groups: [
    'BASIC_CREATOR_INFORMATION',
    'CONTENT_PERFORMANCE',
    'FOLLOWER_INFORMATION',
    'COLLABORATION',
    'SALES_AND_GMV',
  ],
};

const DEFAULT_FILTER_ROTATION = [
  { gmv_ranges: ['GMV_RANGE_100_1000'] },
  { gmv_ranges: ['GMV_RANGE_1000_10000'] },
  { gmv_ranges: ['GMV_RANGE_10000_AND_ABOVE'] },
  { units_sold_ranges: ['UNITS_SOLD_RANGE_10_100'] },
  { units_sold_ranges: ['UNITS_SOLD_RANGE_100_1000'] },
  { units_sold_ranges: ['UNITS_SOLD_RANGE_1000_AND_ABOVE'] },
  { follower_demographics: { count_range: { count_ge: 1000, count_le: 10000 } } },
  { follower_demographics: { count_range: { count_ge: 10000, count_le: 50000 } } },
  { follower_demographics: { count_range: { count_ge: 50000, count_le: 200000 } } },
  { follower_demographics: { count_range: { count_ge: 200000, count_le: -1 } } },
];

function usesMarketplaceInviteSource(source) {
  const value = String(source || 'marketplace_search');
  return value === 'marketplace_search' || value === 'shop_pool' || value === '';
}

function shanghaiDayRange(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const asUtcText = (value) => value.toISOString().slice(0, 19).replace('T', ' ');
  return { day, startText: asUtcText(start), endText: asUtcText(end) };
}

function parseJsonValue(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function errorCode(error) {
  const payload = error?.payload || {};
  const candidates = [payload.code, payload.error?.code, error?.code];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  const text = String(error?.message || payload.message || '');
  const matched = text.match(/\b(16030100|16024049|45101004)\b/);
  return matched ? Number(matched[1]) : 0;
}

function isRateLimitError(error) {
  const status = Number(error?.status || 0);
  const text = String(error?.message || error?.payload?.message || error?.responseText || '');
  return status === 429 || /too many requests|rate limit|throttl|app-group rate limit|shared app-group/i.test(text);
}

function nextBackoffMs(previousMs = 0) {
  const steps = [2, 5, 15, 30, 60].map((minutes) => minutes * 60 * 1000);
  const current = Number(previousMs || 0);
  return steps.find((step) => step > current) || steps[steps.length - 1];
}

function parseQuotaPayload(data = {}) {
  const payload = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const unlimited = payload.unlimited === true || String(payload.quota_type || '').toLowerCase() === 'unlimited';
  const sum = numberOr(payload.quota_sum, 0);
  const used = numberOr(payload.quota_use, 0);
  let remain = unlimited ? Infinity : Math.max(0, sum - used);
  const details = Array.isArray(payload.quota_detail) ? payload.quota_detail : (Array.isArray(payload.quota_details) ? payload.quota_details : []);
  if (!unlimited && details.length) {
    remain = details.reduce((total, row) => {
      const periodRemain = Math.max(0, numberOr(row.quota_period_sum, 0) - numberOr(row.quota_period_use, 0));
      const bonusRemain = Math.max(0, numberOr(row.quota_bonus_sum, 0) - numberOr(row.quota_bonus_use, 0));
      return total + periodRemain + bonusRemain;
    }, 0);
  }
  return {
    unlimited,
    quota_sum: unlimited ? null : sum,
    quota_use: used,
    remain: unlimited ? Infinity : remain,
    gmv_tier: payload.gmv_tier || '',
    start_time: payload.start_time || '',
    end_time: payload.end_time || '',
    raw: {
      unlimited,
      quota_sum: payload.quota_sum,
      quota_use: payload.quota_use,
      gmv_tier: payload.gmv_tier,
      start_time: payload.start_time,
      end_time: payload.end_time,
    },
  };
}

function publicQuota(quota) {
  if (!quota) return null;
  return {
    unlimited: Boolean(quota.unlimited),
    quota_sum: quota.unlimited ? null : quota.quota_sum,
    quota_use: quota.quota_use,
    remain: quota.unlimited ? 'unlimited' : quota.remain,
    gmv_tier: quota.gmv_tier || '',
    start_time: quota.start_time || '',
    end_time: quota.end_time || '',
  };
}

function filterKey(filter) {
  return JSON.stringify(filter || {});
}

function mergeSearchBody(base, filter) {
  const next = { ...(base || {}), ...(filter || {}) };
  if (base?.follower_demographics || filter?.follower_demographics) {
    next.follower_demographics = {
      ...(base?.follower_demographics || {}),
      ...(filter?.follower_demographics || {}),
    };
    if (base?.follower_demographics?.count_range || filter?.follower_demographics?.count_range) {
      next.follower_demographics.count_range = {
        ...(base?.follower_demographics?.count_range || {}),
        ...(filter?.follower_demographics?.count_range || {}),
      };
    }
  }
  if (base?.affiliate_data || filter?.affiliate_data) {
    next.affiliate_data = { ...(base?.affiliate_data || {}), ...(filter?.affiliate_data || {}) };
  }
  if (base?.content_performance || filter?.content_performance) {
    next.content_performance = { ...(base?.content_performance || {}), ...(filter?.content_performance || {}) };
  }
  return next;
}

function listFromSearchData(data, listKeys) {
  for (const key of listKeys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractOpenId(creator) {
  return String(
    creator?.creator_open_id ||
    creator?.creatorOpenId ||
    creator?.open_id ||
    creator?.uid ||
    ''
  ).trim();
}

function shouldRotateFilters({ resultCount, newCount, nextPageToken, emptyPagesInFilter }) {
  if (!nextPageToken) return true;
  if (resultCount === 0) return true;
  if (newCount === 0 && emptyPagesInFilter >= 1) return true;
  return false;
}

function createMarketplaceSearchInvite(deps = {}) {
  const {
    db,
    tiktokRequest,
    nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' '),
    normalizeAffiliateCreator,
    insertWorkflowTask,
    sendWorkflowInvitations,
    getWorkflow,
    getAgentSettings,
    getAgentRuntime,
    getAgentFlowStates,
    getReviewStandard,
    writeSyncLog,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  const quotaCache = new Map();
  const runtime = {
    timer: null,
    ticking: false,
    lastSearchAt: new Map(),
    backoffUntil: new Map(),
    backoffMs: new Map(),
    cycleEmpty: new Map(),
    started: false,
  };

  function ensureSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS marketplace_search_cursors (
        shop_id TEXT PRIMARY KEY,
        filter_index INTEGER NOT NULL DEFAULT 0,
        filter_json TEXT NOT NULL DEFAULT '{}',
        page_token TEXT,
        search_key TEXT,
        page_count INTEGER NOT NULL DEFAULT 0,
        empty_pages INTEGER NOT NULL DEFAULT 0,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS marketplace_invite_daily_stats (
        shop_id TEXT NOT NULL,
        day TEXT NOT NULL,
        search_pages INTEGER NOT NULL DEFAULT 0,
        search_results INTEGER NOT NULL DEFAULT 0,
        queued INTEGER NOT NULL DEFAULT 0,
        skipped_invited INTEGER NOT NULL DEFAULT 0,
        skipped_invalid INTEGER NOT NULL DEFAULT 0,
        sent_ok INTEGER NOT NULL DEFAULT 0,
        sent_failed INTEGER NOT NULL DEFAULT 0,
        skipped_quota INTEGER NOT NULL DEFAULT 0,
        rate_limit_backoffs INTEGER NOT NULL DEFAULT 0,
        last_quota_json TEXT,
        last_filter_json TEXT,
        last_error TEXT,
        last_backoff_until TEXT,
        updated_at TEXT,
        PRIMARY KEY (shop_id, day)
      )
    `);
  }

  function settingsBundle() {
    return getAgentSettings ? getAgentSettings() : {};
  }

  function searchIntervalMs(settings = settingsBundle()) {
    const configured = numberOr(
      process.env.TK_MARKETPLACE_SEARCH_INTERVAL_MS || settings.marketplace_search_interval_ms,
      DEFAULT_SEARCH_INTERVAL_MS
    );
    return clamp(configured, 60 * 1000, 120 * 1000);
  }

  function sendIntervalMs(settings = settingsBundle()) {
    return Math.max(1000, numberOr(
      process.env.TK_INVITE_SEND_INTERVAL_MS || settings.marketplace_invite_send_interval_ms,
      DEFAULT_SEND_INTERVAL_MS
    ));
  }

  function quotaCacheMs(settings = settingsBundle()) {
    return clamp(
      numberOr(process.env.TK_MARKETPLACE_QUOTA_CACHE_MS || settings.marketplace_quota_cache_ms, DEFAULT_QUOTA_CACHE_MS),
      MIN_QUOTA_CACHE_MS,
      MAX_QUOTA_CACHE_MS
    );
  }

  function searchPageSize() {
    const size = numberOr(process.env.TK_AFFILIATE_CREATOR_POOL_PAGE_SIZE, 20);
    return size === 12 ? 12 : 20;
  }

  function searchPath() {
    return process.env.TK_AFFILIATE_CREATOR_POOL_PATH || DEFAULT_SEARCH_PATH;
  }

  function listKeys() {
    return String(process.env.TK_AFFILIATE_CREATOR_POOL_LIST_KEYS || 'creators,creator_list,marketplace_creators,creator_profiles,list,data')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function baseSearchBody(settings = settingsBundle()) {
    const envBody = parseJsonValue(process.env.TK_AFFILIATE_CREATOR_POOL_BODY, {});
    const settingBody = parseJsonValue(settings.marketplace_search_base_body, {});
    return mergeSearchBody(mergeSearchBody(DEFAULT_BASE_BODY, envBody), settingBody);
  }

  function filterRotation(settings = settingsBundle()) {
    const configured = parseJsonValue(settings.marketplace_search_filters, null);
    return Array.isArray(configured) && configured.length ? configured : DEFAULT_FILTER_ROTATION;
  }

  function configuredDailyLimit(shopId, workflow, settings = settingsBundle()) {
    const byShop = parseJsonValue(settings.invite_daily_limit_by_shop, {}) || {};
    const shopLimit = numberOr(byShop[shopId], 0);
    if (shopLimit > 0) return shopLimit;
    const settingLimit = Math.max(1, numberOr(settings.invite_daily_limit || settings.invite_target_count, DEFAULT_DAILY_LIMIT));
    const workflowLimit = Math.max(1, numberOr(workflow?.config?.invite_daily_limit || workflow?.config?.invite_target_count, settingLimit));
    return Math.max(1, Math.min(settingLimit, workflowLimit));
  }

  function autorunEnabled(settings = settingsBundle()) {
    if (String(process.env.TK_MARKETPLACE_INVITE_AUTORUN || '').toLowerCase() === 'false') return false;
    if (String(process.env.TK_INVITE_EXECUTE) !== '1') return false;
    const flag = settings.marketplace_search_invite_autorun;
    if (flag === undefined || flag === null || flag === '') return true;
    return !['0', 'false', 'off', 'no'].includes(String(flag).toLowerCase());
  }

  function autoInviteActive() {
    if (getAgentRuntime?.().paused) return false;
    const flows = getAgentFlowStates?.() || [];
    const inviteFlow = flows.find((item) => item.key === 'auto_invite' || item.flow_key === 'auto_invite');
    return inviteFlow ? Boolean(inviteFlow.active) : true;
  }

  function statsDay(shopId, day = shanghaiDayRange().day) {
    const now = nowText();
    db.prepare(`
      INSERT INTO marketplace_invite_daily_stats (shop_id, day, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(shop_id, day) DO NOTHING
    `).run(shopId, day, now);
    return db.prepare('SELECT * FROM marketplace_invite_daily_stats WHERE shop_id = ? AND day = ?').get(shopId, day);
  }

  function bumpStats(shopId, fields = {}) {
    const { day } = shanghaiDayRange();
    statsDay(shopId, day);
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (['last_quota_json', 'last_filter_json', 'last_error', 'last_backoff_until'].includes(key)) {
        assignments.push(`${key} = ?`);
        values.push(value);
      } else {
        assignments.push(`${key} = COALESCE(${key}, 0) + ?`);
        values.push(Number(value || 0));
      }
    }
    assignments.push('updated_at = ?');
    values.push(nowText(), shopId, day);
    db.prepare(`UPDATE marketplace_invite_daily_stats SET ${assignments.join(', ')} WHERE shop_id = ? AND day = ?`).run(...values);
    return statsDay(shopId, day);
  }

  function sentTodayCount(shopId) {
    const { startText, endText } = shanghaiDayRange();
    return Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM invitation_records
      WHERE shop_id = ?
        AND status = 'sent'
        AND COALESCE(sent_at, created_at) >= ?
        AND COALESCE(sent_at, created_at) < ?
    `).get(shopId, startText, endText)?.c || 0);
  }

  function pendingQueueCount(workflowId, shopId) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM agent_workflow_tasks
      WHERE workflow_id = ?
        AND task_type = 'invite'
        AND status = 'admin_approved'
        AND shop_id = ?
    `).get(workflowId, shopId)?.c || 0);
  }

  function invitedKeySet(shopId) {
    const set = new Set();
    const add = (...values) => {
      for (const value of values) {
        const text = String(value || '').trim();
        if (text) set.add(text);
      }
    };
    db.prepare(`
      SELECT uid, creator_open_id, creator_handle, status, provider_message
      FROM invitation_records
      WHERE shop_id = ?
    `).all(shopId).forEach((row) => {
      const failedQuota = row.status === 'failed' && /16030100|16024049/.test(String(row.provider_message || ''));
      if (['sent', 'pending'].includes(row.status) || failedQuota) {
        add(row.uid, row.creator_open_id, row.creator_handle);
      }
    });
    db.prepare(`
      SELECT uid, creator_handle
      FROM agent_workflow_tasks
      WHERE task_type = 'invite'
        AND shop_id = ?
        AND status IN ('admin_approved', 'agent_review', 'executed')
    `).all(shopId).forEach((row) => add(row.uid, row.creator_handle));
    return set;
  }

  function alreadyInvited(set, creator) {
    const keys = [creator.uid, creator.creator_open_id, creator.creatorOpenId, creator.creator_handle, creator.creatorHandle]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return keys.some((key) => set.has(key));
  }

  function toCandidate(shop, raw) {
    const item = normalizeAffiliateCreator(raw);
    const profile = raw.creator_profile || raw.profile || {};
    const openId = firstNonEmpty(item.creatorOpenId, item.uid, extractOpenId(raw));
    const unitsMin = numberOr(raw.units_sold_range?.minimum_amount, item.salesCount30d);
    return {
      source: 'marketplace_search',
      uid: openId || item.uid,
      creator_name: item.creatorName,
      creator_handle: item.creatorHandle,
      creator_open_id: openId,
      shop_id: shop.id,
      shop_name: shop.name || shop.id,
      fans: Number(item.fans || raw.follower_count || 0),
      category: item.category || (Array.isArray(raw.category_ids) ? raw.category_ids.join(',') : ''),
      fulfillment_rate: item.fulfillmentRate || 0,
      avg_view: item.avgView || numberOr(raw.avg_ec_video_view_count, 0),
      monthly_avg_view: item.avgView || numberOr(raw.avg_ec_video_view_count, 0),
      monthly_videos: item.videos30d,
      videos_30d: item.videos30d,
      star: 0,
      total_orders: unitsMin || item.salesCount30d || 0,
      sales_count_30d: unitsMin || item.salesCount30d,
      sales_amount: item.salesAmount30d || numberOr(raw.gmv?.amount, 0),
      gmv_30d: item.salesAmount30d || numberOr(raw.gmv?.amount, 0),
      metrics_source: 'marketplace_search',
      has_invited_90d: Boolean(profile.has_invited_90d),
      is_creator_blocked: Boolean(profile.is_creator_blocked),
      raw,
    };
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
    }
    return '';
  }

  function candidateAcceptable(candidate, workflow) {
    if (!candidate.creator_open_id) return { ok: false, reason: '缺少 creator_open_id' };
    if (candidate.is_creator_blocked) return { ok: false, reason: '达人已被屏蔽' };
    if (candidate.has_invited_90d) return { ok: false, reason: '官方标记近90天已邀约' };
    const standard = getReviewStandard ? getReviewStandard() : {};
    const fansLimit = numberOr(standard.fans_hard_limit, 0);
    if (fansLimit && Number(candidate.fans || 0) < fansLimit) {
      return { ok: false, reason: `粉丝数 ${candidate.fans} 低于硬门槛 ${fansLimit}` };
    }
    return { ok: true, reason: '查找达人筛选通过' };
  }

  function getCursor(shopId) {
    return db.prepare('SELECT * FROM marketplace_search_cursors WHERE shop_id = ?').get(shopId) || {
      shop_id: shopId,
      filter_index: 0,
      filter_json: '{}',
      page_token: '',
      search_key: '',
      page_count: 0,
      empty_pages: 0,
      cycle_count: 0,
    };
  }

  function saveCursor(shopId, patch) {
    const current = { ...getCursor(shopId), ...patch, shop_id: shopId, updated_at: nowText() };
    db.prepare(`
      INSERT INTO marketplace_search_cursors (
        shop_id, filter_index, filter_json, page_token, search_key, page_count, empty_pages, cycle_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        filter_index = excluded.filter_index,
        filter_json = excluded.filter_json,
        page_token = excluded.page_token,
        search_key = excluded.search_key,
        page_count = excluded.page_count,
        empty_pages = excluded.empty_pages,
        cycle_count = excluded.cycle_count,
        updated_at = excluded.updated_at
    `).run(
      shopId,
      Number(current.filter_index || 0),
      current.filter_json || '{}',
      current.page_token || '',
      current.search_key || '',
      Number(current.page_count || 0),
      Number(current.empty_pages || 0),
      Number(current.cycle_count || 0),
      current.updated_at
    );
    return getCursor(shopId);
  }

  function rotateCursor(shopId, filters) {
    const current = getCursor(shopId);
    const nextIndex = (Number(current.filter_index || 0) + 1) % filters.length;
    const cycleCount = Number(current.cycle_count || 0) + (nextIndex === 0 ? 1 : 0);
    return saveCursor(shopId, {
      filter_index: nextIndex,
      filter_json: filterKey(filters[nextIndex]),
      page_token: '',
      search_key: '',
      empty_pages: 0,
      cycle_count: cycleCount,
    });
  }

  async function fetchCreatorOutreachQuota(shop, { force = false } = {}) {
    const settings = settingsBundle();
    const cached = quotaCache.get(shop.id);
    const ttl = quotaCacheMs(settings);
    if (!force && cached && (Date.now() - cached.fetchedAt) < ttl) return cached.quota;
    try {
      const data = await tiktokRequest({
        path: process.env.TK_OUTREACH_QUOTA_PATH || DEFAULT_QUOTA_PATH,
        method: 'GET',
        accessToken: shop.access_token,
        shopId: shop.id,
        query: { shop_cipher: shop.shop_cipher },
        body: {},
      });
      const quota = parseQuotaPayload(data);
      quotaCache.set(shop.id, { quota, fetchedAt: Date.now(), sentAtFetch: sentTodayCount(shop.id) });
      bumpStats(shop.id, { last_quota_json: JSON.stringify(publicQuota(quota)) });
      return quota;
    } catch (error) {
      if (cached?.quota) return cached.quota;
      throw error;
    }
  }

  function adjustedQuotaRemain(shopId, quota, sentAtFetch) {
    if (!quota) return 0;
    if (quota.unlimited) return Infinity;
    const sentSince = Math.max(0, sentTodayCount(shopId) - Number(sentAtFetch || 0));
    return Math.max(0, Number(quota.remain || 0) - sentSince);
  }

  async function effectiveShopCap(shop, workflow, { force = false } = {}) {
    const dailyLimit = configuredDailyLimit(shop.id, workflow);
    const sent = sentTodayCount(shop.id);
    const dailyRemain = Math.max(0, dailyLimit - sent);
    let quota;
    try {
      quota = await fetchCreatorOutreachQuota(shop, { force });
    } catch (error) {
      return {
        dailyLimit,
        sent,
        dailyRemain,
        quota: null,
        remain: 0,
        reason: `官方周额度查询失败：${error.message || '未知错误'}`,
      };
    }
    const cached = quotaCache.get(shop.id);
    const quotaRemain = adjustedQuotaRemain(shop.id, quota, cached?.sentAtFetch);
    const remain = quota.unlimited ? dailyRemain : Math.max(0, Math.min(dailyRemain, quotaRemain));
    return {
      dailyLimit,
      sent,
      dailyRemain,
      quota,
      remain,
      reason: remain <= 0
        ? (dailyRemain <= 0 ? '今日额度已用完' : '官方周额度已用完')
        : '',
    };
  }

  async function searchOnePage(shop, { body, pageToken, searchKey, pageSize } = {}) {
    const data = await tiktokRequest({
      path: searchPath(),
      method: 'POST',
      accessToken: shop.access_token,
      shopId: shop.id,
      query: {
        shop_cipher: shop.shop_cipher,
        page_size: pageSize || searchPageSize(),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      body: {
        ...(body || {}),
        ...(searchKey ? { search_key: searchKey } : {}),
      },
    });
    return {
      creators: listFromSearchData(data, listKeys()),
      nextPageToken: data.next_page_token || data.nextPageToken || '',
      searchKey: data.search_key || data.searchKey || searchKey || '',
    };
  }

  function markBackoff(shopId, error, extra = {}) {
    const previous = runtime.backoffMs.get(shopId) || 0;
    const waitMs = extra.waitMs || nextBackoffMs(previous);
    const until = new Date(Date.now() + waitMs);
    const untilText = nowTextFromDate(until);
    runtime.backoffMs.set(shopId, waitMs);
    runtime.backoffUntil.set(shopId, until.getTime());
    bumpStats(shopId, {
      rate_limit_backoffs: 1,
      last_error: String(error?.message || extra.reason || '限流退避').slice(0, 300),
      last_backoff_until: untilText,
    });
    writeSyncLog?.(shopId, 'marketplace-invite', 'skipped', `查找达人限流/额度退避 ${Math.round(waitMs / 1000)} 秒`);
    return { waitMs, until: untilText };
  }

  function nowTextFromDate(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }

  function shopPaused(shopId) {
    const until = runtime.backoffUntil.get(shopId) || 0;
    return until > Date.now();
  }

  function clearBackoff(shopId) {
    runtime.backoffMs.delete(shopId);
    runtime.backoffUntil.delete(shopId);
  }

  function workflowShops(workflow) {
    const shopId = workflow?.config?.shop;
    if (shopId && shopId !== 'all') {
      const row = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
      return row ? [row] : [];
    }
    return db.prepare('SELECT * FROM shops ORDER BY id').all();
  }

  function enqueueCandidate(workflow, candidate) {
    const audit = {
      score: 100,
      recommendation: 'auto_pass',
      reason: '查找达人官方筛选通过，待发送',
      review_standard_version: getReviewStandard?.()?.version || null,
      score_details: [{ name: 'marketplace_search', pass: true, detail: '来自店铺后台查找达人搜索' }],
    };
    insertWorkflowTask(workflow.id, 'invite', 'admin_approved', candidate, audit, {
      candidate,
      config_snapshot: workflow.config,
      source: 'marketplace_search',
    });
  }

  async function replenishShop(shop, workflow, { force = false } = {}) {
    ensureSchema();
    const settings = settingsBundle();
    const cap = await effectiveShopCap(shop, workflow);
    if (cap.remain <= 0) {
      bumpStats(shop.id, { last_error: cap.reason || '额度已用完' });
      return { shop_id: shop.id, queued: 0, skipped: 0, reason: cap.reason, cap };
    }
    if (!force && shopPaused(shop.id)) {
      return { shop_id: shop.id, queued: 0, skipped: 0, reason: '退避中', cap };
    }
    const pending = pendingQueueCount(workflow.id, shop.id);
    if (!force && pending >= Math.min(QUEUE_BUFFER, cap.remain)) {
      return { shop_id: shop.id, queued: 0, skipped: 0, reason: '队列仍有待发送', pending, cap };
    }
    const lastSearch = runtime.lastSearchAt.get(shop.id) || 0;
    if (!force && Date.now() - lastSearch < searchIntervalMs(settings)) {
      return { shop_id: shop.id, queued: 0, skipped: 0, reason: '未到搜索间隔', cap };
    }

    const filters = filterRotation(settings);
    let cursor = getCursor(shop.id);
    if (cursor.filter_index >= filters.length) cursor = saveCursor(shop.id, { filter_index: 0 });
    const filter = filters[Number(cursor.filter_index || 0)] || filters[0];
    const body = mergeSearchBody(baseSearchBody(settings), filter);

    let page;
    try {
      page = await searchOnePage(shop, {
        body,
        pageToken: cursor.page_token,
        searchKey: cursor.search_key,
        pageSize: searchPageSize(),
      });
      runtime.lastSearchAt.set(shop.id, Date.now());
      clearBackoff(shop.id);
    } catch (error) {
      const code = errorCode(error);
      if (isRateLimitError(error)) {
        markBackoff(shop.id, error);
        return { shop_id: shop.id, queued: 0, error: error.message, rate_limited: true, cap };
      }
      if (QUERY_QUOTA_CODES.has(code)) {
        const until = new Date(`${shanghaiDayRange().day}T24:00:00+08:00`);
        runtime.backoffUntil.set(shop.id, until.getTime());
        bumpStats(shop.id, { last_error: '查询类额度已用完(45101004)', last_backoff_until: nowTextFromDate(until) });
        return { shop_id: shop.id, queued: 0, error: '查询类额度已用完', code, cap };
      }
      bumpStats(shop.id, { last_error: String(error.message || '搜索失败').slice(0, 300) });
      return { shop_id: shop.id, queued: 0, error: error.message, cap };
    }

    const invited = invitedKeySet(shop.id);
    let queued = 0;
    let skippedInvited = 0;
    let skippedInvalid = 0;
    const room = Math.max(0, cap.remain - pending);
    for (const raw of page.creators) {
      if (queued >= room) break;
      const candidate = toCandidate(shop, raw);
      if (alreadyInvited(invited, candidate)) {
        skippedInvited += 1;
        continue;
      }
      const accept = candidateAcceptable(candidate, workflow);
      if (!accept.ok) {
        skippedInvalid += 1;
        continue;
      }
      enqueueCandidate(workflow, candidate);
      invited.add(candidate.uid);
      invited.add(candidate.creator_open_id);
      if (candidate.creator_handle) invited.add(candidate.creator_handle);
      queued += 1;
    }

    const emptyPages = queued === 0 ? Number(cursor.empty_pages || 0) + 1 : 0;
    const rotate = shouldRotateFilters({
      resultCount: page.creators.length,
      newCount: queued,
      nextPageToken: page.nextPageToken,
      emptyPagesInFilter: emptyPages,
    });
    if (rotate) {
      const next = rotateCursor(shop.id, filters);
      if (queued === 0 && Number(next.filter_index || 0) === 0) {
        runtime.cycleEmpty.set(shop.id, (runtime.cycleEmpty.get(shop.id) || 0) + 1);
        if ((runtime.cycleEmpty.get(shop.id) || 0) >= 1) {
          markBackoff(shop.id, new Error('本轮筛选未发现新的可邀约达人'), { waitMs: 30 * 60 * 1000 });
        }
      }
    } else {
      runtime.cycleEmpty.set(shop.id, 0);
      saveCursor(shop.id, {
        filter_index: cursor.filter_index,
        filter_json: filterKey(filter),
        page_token: page.nextPageToken,
        search_key: page.searchKey,
        page_count: Number(cursor.page_count || 0) + 1,
        empty_pages: emptyPages,
      });
    }

    bumpStats(shop.id, {
      search_pages: 1,
      search_results: page.creators.length,
      queued,
      skipped_invited: skippedInvited,
      skipped_invalid: skippedInvalid,
      last_filter_json: filterKey(filter),
      last_error: '',
    });

    return {
      shop_id: shop.id,
      queued,
      skipped_invited: skippedInvited,
      skipped_invalid: skippedInvalid,
      result_count: page.creators.length,
      rotated: rotate,
      filter,
      cap,
    };
  }

  async function replenishWorkflow(workflow, options = {}) {
    const results = [];
    for (const shop of workflowShops(workflow)) {
      results.push(await replenishShop(shop, workflow, options));
    }
    return results;
  }

  function nextApprovedTask(workflow, shopId) {
    return db.prepare(`
      SELECT * FROM agent_workflow_tasks
      WHERE workflow_id = ?
        AND task_type = 'invite'
        AND status = 'admin_approved'
        AND shop_id = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(workflow.id, shopId);
  }

  async function sendOneForShop(shop, workflow) {
    const cap = await effectiveShopCap(shop, workflow);
    if (cap.remain <= 0) {
      if (!cap.quota?.unlimited && cap.dailyRemain > 0) bumpStats(shop.id, { skipped_quota: 1, last_error: cap.reason });
      return { shop_id: shop.id, sent: 0, reason: cap.reason, cap };
    }
    if (shopPaused(shop.id)) return { shop_id: shop.id, sent: 0, reason: '退避中', cap };
    const row = nextApprovedTask(workflow, shop.id);
    if (!row) return { shop_id: shop.id, sent: 0, reason: '没有待发送任务', cap };
    const task = { ...row, payload: parseJsonValue(row.payload_json, {}) };
    try {
      const results = await sendWorkflowInvitations([task], workflow);
      const result = results[0] || {};
      const record = result.record_id
        ? db.prepare('SELECT status, provider_message FROM invitation_records WHERE id = ?').get(result.record_id)
        : null;
      const message = String(record?.provider_message || result.provider_message || result.status || '');
      const status = record?.status || result.status;
      if (status === 'sent') {
        clearBackoff(shop.id);
        bumpStats(shop.id, { sent_ok: 1, last_error: '' });
        return { shop_id: shop.id, sent: 1, result, cap };
      }
      if (CREATOR_QUOTA_CODES.has(errorCode({ message, payload: { code: result.code } }))) {
        bumpStats(shop.id, { sent_failed: 1, last_error: '单达人/层级额度用尽，已跳过' });
        return { shop_id: shop.id, sent: 0, skipped_creator: true, result, cap };
      }
      if (isRateLimitError({ message, status: result.status }) || /rate limit|app-group/i.test(message)) {
        markBackoff(shop.id, new Error(message));
        return { shop_id: shop.id, sent: 0, rate_limited: true, result, cap };
      }
      bumpStats(shop.id, { sent_failed: status === 'failed' ? 1 : 0, last_error: message.slice(0, 300) });
      return { shop_id: shop.id, sent: status === 'sent' ? 1 : 0, result, cap };
    } catch (error) {
      const code = errorCode(error);
      if (isRateLimitError(error)) {
        markBackoff(shop.id, error);
        return { shop_id: shop.id, sent: 0, rate_limited: true, error: error.message, cap };
      }
      if (CREATOR_QUOTA_CODES.has(code)) {
        bumpStats(shop.id, { sent_failed: 1, last_error: `单达人额度用尽(${code})` });
        return { shop_id: shop.id, sent: 0, skipped_creator: true, error: error.message, cap };
      }
      if (QUERY_QUOTA_CODES.has(code)) {
        const until = new Date(`${shanghaiDayRange().day}T24:00:00+08:00`);
        runtime.backoffUntil.set(shop.id, until.getTime());
        bumpStats(shop.id, { last_error: '查询类额度已用完(45101004)', last_backoff_until: nowTextFromDate(until) });
        return { shop_id: shop.id, sent: 0, error: '查询类额度已用完', cap };
      }
      bumpStats(shop.id, { sent_failed: 1, last_error: String(error.message || '发送失败').slice(0, 300) });
      return { shop_id: shop.id, sent: 0, error: error.message, cap };
    }
  }

  async function tick() {
    if (runtime.ticking) return { skipped: true, reason: '上一轮仍在进行' };
    runtime.ticking = true;
    try {
      if (!autorunEnabled() || !autoInviteActive()) {
        return { skipped: true, reason: !autorunEnabled() ? '未开启自动发送' : '自动邀约任务流已暂停' };
      }
      const workflow = getWorkflow();
      if (!usesMarketplaceInviteSource(workflow.config.source)) {
        return { skipped: true, reason: '当前工作流不是查找达人来源' };
      }
      const shops = workflowShops(workflow);
      const results = [];
      for (const shop of shops) {
        const refill = await replenishShop(shop, workflow);
        const send = await sendOneForShop(shop, workflow);
        results.push({ shop_id: shop.id, refill, send });
      }
      return { skipped: false, results };
    } finally {
      runtime.ticking = false;
    }
  }

  function startPacer() {
    if (runtime.timer) return runtime;
    ensureSchema();
    runtime.started = true;
    const loop = async () => {
      try {
        await tick();
      } catch (error) {
        writeSyncLog?.(null, 'marketplace-invite', 'failed', error.message || '查找达人边搜边邀巡检失败');
        console.error('[marketplace-invite] tick failed:', error.message);
      } finally {
        runtime.timer = setTimeout(loop, TICK_MS);
      }
    };
    console.log('[marketplace-invite] pacer started: search 1 page at a time, send at configured interval');
    runtime.timer = setTimeout(loop, 1000);
    return runtime;
  }

  function stopPacer() {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    runtime.started = false;
  }

  function totalDailyRemaining(workflow) {
    return workflowShops(workflow).reduce((sum, shop) => {
      const limit = configuredDailyLimit(shop.id, workflow);
      return sum + Math.max(0, limit - sentTodayCount(shop.id));
    }, 0);
  }

  function status(workflow = getWorkflow?.()) {
    ensureSchema();
    const { day } = shanghaiDayRange();
    const settings = settingsBundle();
    const shops = workflow ? workflowShops(workflow) : db.prepare('SELECT id, name FROM shops ORDER BY id').all();
    return {
      enabled: autorunEnabled(settings) && autoInviteActive(),
      pacer_running: Boolean(runtime.timer || runtime.started),
      day,
      timezone: 'Asia/Shanghai',
      send_interval_ms: sendIntervalMs(settings),
      search_interval_ms: searchIntervalMs(settings),
      default_daily_limit: numberOr(settings.invite_daily_limit, DEFAULT_DAILY_LIMIT),
      shops: shops.map((shop) => {
        const capLimit = configuredDailyLimit(shop.id, workflow, settings);
        const sent = sentTodayCount(shop.id);
        const cursor = getCursor(shop.id);
        const row = statsDay(shop.id, day);
        const cached = quotaCache.get(shop.id)?.quota;
        return {
          shop_id: shop.id,
          shop_name: shop.name || shop.id,
          daily_limit: capLimit,
          sent_today: sent,
          daily_remain: Math.max(0, capLimit - sent),
          pending_queue: workflow ? pendingQueueCount(workflow.id, shop.id) : 0,
          quota: publicQuota(cached),
          cursor: {
            filter_index: Number(cursor.filter_index || 0),
            page_count: Number(cursor.page_count || 0),
            has_page_token: Boolean(cursor.page_token),
            cycle_count: Number(cursor.cycle_count || 0),
          },
          stats: {
            search_pages: Number(row?.search_pages || 0),
            search_results: Number(row?.search_results || 0),
            queued: Number(row?.queued || 0),
            sent_ok: Number(row?.sent_ok || 0),
            sent_failed: Number(row?.sent_failed || 0),
            skipped_invited: Number(row?.skipped_invited || 0),
            skipped_quota: Number(row?.skipped_quota || 0),
            rate_limit_backoffs: Number(row?.rate_limit_backoffs || 0),
            last_error: row?.last_error || '',
            last_backoff_until: row?.last_backoff_until || '',
            last_filter_json: row?.last_filter_json || '',
          },
        };
      }),
    };
  }

  return {
    ensureSchema,
    usesMarketplaceInviteSource,
    shanghaiDayRange,
    parseQuotaPayload,
    mergeSearchBody,
    shouldRotateFilters,
    filterRotation,
    searchIntervalMs,
    sendIntervalMs,
    configuredDailyLimit,
    fetchCreatorOutreachQuota,
    effectiveShopCap,
    searchOnePage,
    replenishShop,
    replenishWorkflow,
    sendOneForShop,
    tick,
    startPacer,
    stopPacer,
    status,
    totalDailyRemaining,
    workflowShops,
    sentTodayCount,
    DEFAULT_FILTER_ROTATION,
    DEFAULT_BASE_BODY,
    DEFAULT_DAILY_LIMIT,
    DEFAULT_SEND_INTERVAL_MS,
    DEFAULT_SEARCH_INTERVAL_MS,
  };
}

module.exports = {
  createMarketplaceSearchInvite,
  usesMarketplaceInviteSource,
  shanghaiDayRange,
  parseQuotaPayload,
  mergeSearchBody,
  shouldRotateFilters,
  nextBackoffMs,
  errorCode,
  isRateLimitError,
  DEFAULT_FILTER_ROTATION,
  DEFAULT_BASE_BODY,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_SEND_INTERVAL_MS,
  DEFAULT_SEARCH_INTERVAL_MS,
};
