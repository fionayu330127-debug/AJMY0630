#!/usr/bin/env node
// Offline unit tests for marketplace search-and-invite helpers.
// Does not call the real TikTok API.

const assert = require('node:assert/strict');
const {
  usesMarketplaceInviteSource,
  shanghaiDayRange,
  parseQuotaPayload,
  mergeSearchBody,
  shouldRotateFilters,
  nextBackoffMs,
  errorCode,
  isRateLimitError,
  parseProductIds,
  officialReceiveLimitReached,
  shouldSkipCreatorRecord,
  createMarketplaceSearchInvite,
  DEFAULT_BASE_BODY,
} = require('../marketplaceSearchInvite');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const DEFAULT_REVIEW_STANDARD = {
  version: 1,
  sample_pass_line: 70,
  invite_pass_line: 50,
  orders_base: 200,
  views_base: 5000,
  conversion_base: 5,
  orders_weight: 30,
  views_weight: 30,
  conversion_weight: 30,
  fans_hard_limit: 1000,
  fans_score_1000: 3,
  fans_score_5000: 5,
  fans_score_50000: 8,
  fans_score_200000: 10,
  missing_data_action: '疑',
};

// Mirrors server.js scoreByReviewStandard / fansScoreForValue for offline tests.
function fansScoreForValue(fans, standard) {
  if (fans < standard.fans_hard_limit) return 0;
  if (fans < 5000) return standard.fans_score_1000;
  if (fans < 50000) return standard.fans_score_5000;
  if (fans < 200000) return standard.fans_score_50000;
  return standard.fans_score_200000;
}

function scoreByReviewStandard(item, standard, thresholdType) {
  const ordersValue = item.monthly_orders ?? item.total_orders ?? item.sales_count_30d ?? item.sales_count;
  const viewsValue = item.monthly_avg_view ?? item.avg_view;
  const videosValue = item.monthly_videos ?? item.videos ?? item.published_videos;
  const orders = Number(ordersValue || 0);
  const views = Number(viewsValue || 0);
  const videos = Number(videosValue || 0);
  const conversion = videos > 0 ? orders / videos : 0;
  // Missing or zero 30-day video count: conversion scores 0; this alone must not trigger missing-data / manual_review.
  const missing = [ordersValue, viewsValue].some((value) => value === undefined || value === null || value === '');
  const fanScore = fansScoreForValue(Number(item.fans || item.followers || 0), standard);
  const checks = [
    { name: '粉丝数', metric: 'fans', actual: Number(item.fans || item.followers || 0), base: standard.fans_hard_limit, weight: fanScore, score: fanScore },
    { name: '30天成交件数', metric: 'orders', actual: orders, base: standard.orders_base, weight: standard.orders_weight, score: Math.min(orders / standard.orders_base, 1) * standard.orders_weight },
    { name: '30天视频平均播放量', metric: 'views', actual: views, base: standard.views_base, weight: standard.views_weight, score: Math.min(views / standard.views_base, 1) * standard.views_weight },
    { name: '成交件数 ÷ 发布视频数', metric: 'conversion', actual: conversion, base: standard.conversion_base, weight: standard.conversion_weight, score: Math.min(conversion / standard.conversion_base, 1) * standard.conversion_weight },
  ].map((check) => ({
    ...check,
    score: Math.round(check.score * 100) / 100,
  }));
  const score = Math.round(checks.reduce((sum, check) => sum + check.score, 0) * 100) / 100;
  const fans = Number(item.fans || item.followers || 0);
  const threshold = thresholdType === 'invite' ? standard.invite_pass_line : standard.sample_pass_line;
  let recommendation = 'auto_pass';
  let reason = `总分 ${score}，达到${thresholdType === 'invite' ? '邀约筛选' : '样品审核'}通过线 ${threshold}`;
  if (fans < standard.fans_hard_limit) {
    recommendation = 'manual_review';
    reason = `粉丝数 ${fans} 低于硬门槛 ${standard.fans_hard_limit}`;
  } else if (missing) {
    recommendation = 'manual_review';
    reason = standard.missing_data_action === '不通过' ? '缺少30天数据，按当前标准不通过' : '缺少30天数据，需人工确认';
  } else if (score < threshold) {
    recommendation = 'manual_review';
    reason = `总分 ${score} 未达到通过线 ${threshold}`;
  }
  return {
    score,
    recommendation,
    reason,
    checks: checks.map((check) => ({ ...check, pass: check.score > 0 })),
    score_details: checks,
    review_standard_version: standard.version,
  };
}

function testScoreCandidate(item) {
  return scoreByReviewStandard(item, DEFAULT_REVIEW_STANDARD, 'invite');
}


test('marketplace and shop_pool use official search path', () => {
  assert.equal(usesMarketplaceInviteSource('marketplace_search'), true);
  assert.equal(usesMarketplaceInviteSource('shop_pool'), true);
  assert.equal(usesMarketplaceInviteSource(''), true);
  assert.equal(usesMarketplaceInviteSource('library'), false);
  assert.equal(usesMarketplaceInviteSource('import'), false);
});

test('shanghai day range is a 24h window in Asia/Shanghai', () => {
  const sample = new Date('2026-11-19T01:30:00+08:00');
  const range = shanghaiDayRange(sample);
  assert.equal(range.day, '2026-11-19');
  assert.equal(range.startText, '2026-11-18 16:00:00');
  assert.equal(range.endText, '2026-11-19 16:00:00');
});

test('quota remain honors unlimited and quota_detail', () => {
  const unlimited = parseQuotaPayload({ unlimited: true, quota_use: 360, quota_sum: 0 });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.remain, Infinity);
  assert.equal(unlimited.quota_use, 360);

  const limited = parseQuotaPayload({ unlimited: false, quota_sum: 500, quota_use: 426 });
  assert.equal(limited.remain, 74);

  const detailed = parseQuotaPayload({
    unlimited: false,
    quota_sum: 500,
    quota_use: 426,
    quota_detail: [
      { quota_period_sum: 400, quota_period_use: 390, quota_bonus_sum: 100, quota_bonus_use: 36 },
    ],
  });
  assert.equal(detailed.remain, 74);
});

test('search body merge keeps official nested filters', () => {
  const merged = mergeSearchBody(
    { affiliate_data: { not_invited_l90_days: true }, follower_demographics: { age_ranges: ['AGE_RANGE_25_34'] } },
    { follower_demographics: { count_range: { count_ge: 1000, count_le: 10000 } }, gmv_ranges: ['GMV_RANGE_100_1000'] }
  );
  assert.equal(merged.affiliate_data.not_invited_l90_days, true);
  assert.deepEqual(merged.gmv_ranges, ['GMV_RANGE_100_1000']);
  assert.equal(merged.follower_demographics.age_ranges[0], 'AGE_RANGE_25_34');
  assert.equal(merged.follower_demographics.count_range.count_ge, 1000);
});

test('rotate when page is empty, exhausted, or all duplicates', () => {
  assert.equal(shouldRotateFilters({ resultCount: 0, newCount: 0, nextPageToken: 'x', emptyPagesInFilter: 1 }), true);
  assert.equal(shouldRotateFilters({ resultCount: 20, newCount: 0, nextPageToken: 'x', emptyPagesInFilter: 1 }), true);
  assert.equal(shouldRotateFilters({ resultCount: 20, newCount: 5, nextPageToken: '', emptyPagesInFilter: 0 }), true);
  assert.equal(shouldRotateFilters({ resultCount: 20, newCount: 5, nextPageToken: 'next', emptyPagesInFilter: 0 }), false);
});

test('rate limit and official error codes are detected', () => {
  assert.equal(isRateLimitError({ status: 429, message: 'too many requests' }), true);
  assert.equal(isRateLimitError({ message: 'This app has exceeded a shared app-group rate limit' }), true);
  assert.equal(errorCode({ payload: { code: 16030100 } }), 16030100);
  assert.equal(errorCode({ message: 'failed 45101004 query quota' }), 45101004);
  assert.equal(nextBackoffMs(0), 2 * 60 * 1000);
  assert.equal(nextBackoffMs(2 * 60 * 1000), 5 * 60 * 1000);
  assert.equal(nextBackoffMs(60 * 60 * 1000), 60 * 60 * 1000);
});

test('in-memory flow: one page enqueue, skip invited, stop when remain is 0', async () => {
  const shops = [{ id: 'mir', name: 'MIR HOME', access_token: 't', shop_cipher: 'c' }];
  const tasks = [];
  const records = [
    { uid: 'old-1', creator_open_id: 'old-1', creator_handle: 'old_handle', status: 'failed', provider_message: '16030100 invitation receive limit', shop_id: 'mir', sent_at: '2026-11-19 02:00:00' },
  ];
  const cursors = new Map();
  const stats = new Map();
  const state = { quotaRemain: 2, pages: 0 };

  const db = {
    exec() {},
    prepare(sql) {
      return {
        run(...args) {
          if (/INSERT INTO marketplace_search_cursors/.test(sql)) {
            cursors.set(args[0], {
              shop_id: args[0],
              filter_index: args[1],
              filter_json: args[2],
              page_token: args[3],
              search_key: args[4],
              page_count: args[5],
              empty_pages: args[6],
              cycle_count: args[7],
              updated_at: args[8],
            });
          }
          if (/INSERT INTO marketplace_invite_daily_stats/.test(sql)) {
            const key = `${args[0]}:${args[1]}`;
            if (!stats.has(key)) stats.set(key, { shop_id: args[0], day: args[1], search_pages: 0, queued: 0, skipped_invited: 0, skipped_invalid: 0, sent_ok: 0 });
          }
          if (/UPDATE marketplace_invite_daily_stats/.test(sql)) {
            const shopId = args[args.length - 2];
            const day = args[args.length - 1];
            const row = stats.get(`${shopId}:${day}`) || { shop_id: shopId, day };
            if (/search_pages = COALESCE/.test(sql)) row.search_pages = (row.search_pages || 0) + Number(args[0] || 0);
            if (/queued = COALESCE/.test(sql)) row.queued = (row.queued || 0) + 1;
            stats.set(`${shopId}:${day}`, row);
          }
        },
        get(...args) {
          if (/FROM invitation_records/.test(sql) && /COUNT/.test(sql)) {
            const shopId = args[0];
            const start = args[1];
            const end = args[2];
            const count = records.filter((row) => row.shop_id === shopId && row.status === 'sent' && row.sent_at >= start && row.sent_at < end).length;
            return { c: count };
          }
          if (/FROM marketplace_search_cursors/.test(sql)) return cursors.get(args[0]) || null;
          if (/FROM marketplace_invite_daily_stats/.test(sql)) return stats.get(`${args[0]}:${args[1]}`) || { shop_id: args[0], day: args[1], search_pages: 0, queued: 0 };
          if (/FROM shops WHERE id/.test(sql)) return shops.find((item) => item.id === args[0]) || null;
          if (/FROM agent_workflow_tasks/.test(sql) && /COUNT/.test(sql)) return { c: tasks.filter((item) => item.shop_id === args[1] && item.status === 'admin_approved').length };
          if (/FROM agent_workflow_tasks/.test(sql) && /admin_approved/.test(sql) && /LIMIT 1/.test(sql)) {
            return tasks.find((item) => item.shop_id === args[1] && item.status === 'admin_approved') || null;
          }
          return null;
        },
        all(...args) {
          if (/FROM invitation_records/.test(sql)) return records.filter((row) => row.shop_id === args[0]);
          if (/FROM agent_workflow_tasks/.test(sql)) return tasks.filter((item) => item.shop_id === args[0]);
          if (/FROM shops/.test(sql)) return shops;
          return [];
        },
      };
    },
  };

  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async ({ path }) => {
      if (path.includes('creator_outreach/quota')) {
        return { unlimited: false, quota_sum: 500, quota_use: 500 - state.quotaRemain };
      }
      state.pages += 1;
      return {
        creators: [
          { creator_open_id: 'old-1', username: 'old_handle', nickname: 'Old', follower_count: 2000 },
          { creator_open_id: 'new-1', username: 'new_one', nickname: 'New One', follower_count: 3000 },
          { creator_open_id: 'new-2', username: 'new_two', nickname: 'New Two', follower_count: 4000 },
        ],
        next_page_token: 'page-2',
        search_key: 'key-1',
      };
    },
    normalizeAffiliateCreator: (raw) => ({
      uid: raw.creator_open_id,
      creatorOpenId: raw.creator_open_id,
      creatorName: raw.nickname,
      creatorHandle: raw.username,
      fans: raw.follower_count,
      category: '',
      fulfillmentRate: 0,
      avgView: raw.avgView ?? 5000,
      videos30d: raw.videos30d ?? 100,
      salesCount30d: raw.salesCount30d ?? 1000,
      salesAmount30d: raw.salesAmount30d ?? 10000,
    }),
    insertWorkflowTask: (_workflowId, _type, status, candidate, audit) => {
      tasks.push({ id: tasks.length + 1, shop_id: candidate.shop_id, uid: candidate.uid, status, audit, payload: { candidate } });
    },
    sendWorkflowInvitations: async () => [],
    getWorkflow: () => ({ id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } }),
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_target_count: 1000, invite_daily_limit_by_shop: '{"mir":1000}', marketplace_search_invite_autorun: 1 }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    getReviewStandard: () => DEFAULT_REVIEW_STANDARD,
    agentScoreCandidate: testScoreCandidate,
    writeSyncLog: () => {},
  });

  const workflow = api.get ? null : { id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } };
  const result = await api.replenishShop(shops[0], workflow, { force: true });
  assert.equal(state.pages, 1);
  assert.equal(result.queued, 2);
  assert.equal(result.skipped_invited, 1);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].uid, 'new-1');

  // Official remain is 2, two already queued: a forced second search should not enqueue more.
  const second = await api.replenishShop(shops[0], workflow, { force: true });
  assert.equal(second.queued, 0);
  assert.equal(tasks.length, 2);

  // When official remain is 0, stop even if daily limit still has room.
  state.quotaRemain = 0;
  const stopped = await api.effectiveShopCap(shops[0], workflow, { force: true });
  assert.equal(stopped.remain, 0);
  assert.match(stopped.reason, /周额度/);
});

test('cursor advances and rotates after duplicate-only page', async () => {
  const shop = { id: 'oku', name: 'OKUYOSHI', access_token: 't', shop_cipher: 'c' };
  const cursors = new Map();
  const stats = new Map();
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run(...args) {
          if (/INSERT INTO marketplace_search_cursors/.test(sql)) {
            cursors.set(args[0], {
              shop_id: args[0], filter_index: args[1], filter_json: args[2], page_token: args[3],
              search_key: args[4], page_count: args[5], empty_pages: args[6], cycle_count: args[7],
            });
          }
          if (/INSERT INTO marketplace_invite_daily_stats/.test(sql)) {
            stats.set(`${args[0]}:${args[1]}`, { shop_id: args[0], day: args[1] });
          }
        },
        get(...args) {
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: 0 };
          if (/marketplace_search_cursors/.test(sql)) return cursors.get(args[0]) || null;
          if (/marketplace_invite_daily_stats/.test(sql)) return stats.get(`${args[0]}:${args[1]}`) || { shop_id: args[0], day: args[1] };
          return null;
        },
        all() { return []; },
      };
    },
  };
  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async ({ path }) => {
      if (path.includes('quota')) return { unlimited: true, quota_use: 10 };
      return { creators: [], next_page_token: '', search_key: 'k' };
    },
    normalizeAffiliateCreator: (raw) => raw,
    insertWorkflowTask() {},
    getWorkflow: () => ({ id: 1, config: { source: 'shop_pool', shop: 'oku', invite_daily_limit: 1000 } }),
    getAgentSettings: () => ({ invite_daily_limit: 1000 }),
    getReviewStandard: () => ({ fans_hard_limit: 0 }),
    writeSyncLog: () => {},
  });
  const workflow = { id: 1, config: { source: 'shop_pool', shop: 'oku', invite_daily_limit: 1000 } };
  await api.replenishShop(shop, workflow, { force: true });
  assert.equal(cursors.get('oku').filter_index, 1);
  assert.equal(cursors.get('oku').page_token, '');
});


test('score gate: below invite_pass_line is skipped, passing score is queued, hard gates still reject', async () => {
  const shops = [{ id: 'mir', name: 'MIR HOME', access_token: 't', shop_cipher: 'c' }];
  const tasks = [];
  const cursors = new Map();
  const stats = new Map();
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run(...args) {
          if (/INSERT INTO marketplace_search_cursors/.test(sql)) {
            cursors.set(args[0], {
              shop_id: args[0], filter_index: args[1], filter_json: args[2], page_token: args[3],
              search_key: args[4], page_count: args[5], empty_pages: args[6], cycle_count: args[7],
            });
          }
          if (/INSERT INTO marketplace_invite_daily_stats/.test(sql)) {
            stats.set(`${args[0]}:${args[1]}`, { shop_id: args[0], day: args[1] });
          }
        },
        get(...args) {
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: 0 };
          if (/marketplace_search_cursors/.test(sql)) return cursors.get(args[0]) || null;
          if (/marketplace_invite_daily_stats/.test(sql)) return stats.get(`${args[0]}:${args[1]}`) || { shop_id: args[0], day: args[1] };
          if (/FROM shops WHERE id/.test(sql)) return shops.find((item) => item.id === args[0]) || null;
          return null;
        },
        all(...args) {
          if (/FROM invitation_records/.test(sql)) return [];
          if (/FROM agent_workflow_tasks/.test(sql)) return tasks.filter((item) => item.shop_id === args[0]);
          if (/FROM shops/.test(sql)) return shops;
          return [];
        },
      };
    },
  };

  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async ({ path }) => {
      if (path.includes('creator_outreach/quota')) return { unlimited: true, quota_use: 0 };
      return {
        creators: [
          { username: 'no_id', nickname: 'No Id', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000 },
          { creator_open_id: 'blocked-1', username: 'blocked', nickname: 'Blocked', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000, profile: { is_creator_blocked: true } },
          { creator_open_id: 'low-1', username: 'low_score', nickname: 'Low Score', follower_count: 3000, avgView: 100, videos30d: 10, salesCount30d: 10 },
          { creator_open_id: 'pass-1', username: 'pass_one', nickname: 'Pass One', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000 },
        ],
        next_page_token: 'page-2',
        search_key: 'key-1',
      };
    },
    normalizeAffiliateCreator: (raw) => ({
      uid: raw.creator_open_id,
      creatorOpenId: raw.creator_open_id,
      creatorName: raw.nickname,
      creatorHandle: raw.username,
      fans: raw.follower_count,
      category: '',
      fulfillmentRate: 0,
      avgView: raw.avgView,
      videos30d: raw.videos30d,
      salesCount30d: raw.salesCount30d,
      salesAmount30d: raw.salesAmount30d || 0,
    }),
    insertWorkflowTask: (_workflowId, _type, status, candidate, audit) => {
      tasks.push({ id: tasks.length + 1, shop_id: candidate.shop_id, uid: candidate.uid, status, audit, payload: { candidate } });
    },
    sendWorkflowInvitations: async () => [],
    getWorkflow: () => ({ id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } }),
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_target_count: 1000, invite_daily_limit_by_shop: '{"mir":1000}', marketplace_search_invite_autorun: 1 }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    getReviewStandard: () => DEFAULT_REVIEW_STANDARD,
    agentScoreCandidate: testScoreCandidate,
    writeSyncLog: () => {},
  });

  const workflow = { id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } };
  const result = await api.replenishShop(shops[0], workflow, { force: true });
  assert.equal(result.queued, 1);
  assert.equal(result.skipped_invalid, 2);
  assert.equal(result.skipped_score, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].uid, 'pass-1');
  assert.equal(tasks[0].audit.recommendation, 'auto_pass');
  assert.notEqual(tasks[0].audit.score, 100);
  assert.ok(tasks[0].audit.score >= DEFAULT_REVIEW_STANDARD.invite_pass_line);
  assert.equal(tasks[0].audit.review_standard_version, DEFAULT_REVIEW_STANDARD.version);
  assert.match(String(tasks[0].audit.reason), /邀约筛选通过线/);
  assert.ok(Array.isArray(tasks[0].audit.checks) && tasks[0].audit.checks.length > 0);

  const lowAudit = testScoreCandidate({
    fans: 3000,
    avg_view: 100,
    monthly_avg_view: 100,
    monthly_videos: 10,
    total_orders: 10,
    sales_count_30d: 10,
  });
  assert.equal(lowAudit.recommendation, 'manual_review');
  assert.ok(lowAudit.score < DEFAULT_REVIEW_STANDARD.invite_pass_line);
});


test('missing 30-day videos scores conversion as 0 and can auto_pass', () => {
  const audit = testScoreCandidate({
    fans: 8000,
    avg_view: 5000,
    monthly_avg_view: 5000,
    total_orders: 200,
    sales_count_30d: 200,
  });
  const conversion = audit.checks.find((check) => check.metric === 'conversion');
  assert.equal(conversion.actual, 0);
  assert.equal(conversion.score, 0);
  assert.equal(typeof audit.score, 'number');
  assert.ok(Number.isFinite(audit.score));
  assert.equal(audit.score, 65);
  assert.ok(audit.score >= DEFAULT_REVIEW_STANDARD.invite_pass_line);
  assert.equal(audit.recommendation, 'auto_pass');
  assert.doesNotMatch(String(audit.reason), /缺少30天数据/);
  assert.match(String(audit.reason), /邀约筛选通过线 50/);

  const zeroVideos = testScoreCandidate({
    fans: 8000,
    avg_view: 5000,
    monthly_avg_view: 5000,
    monthly_videos: 0,
    total_orders: 200,
    sales_count_30d: 200,
  });
  assert.equal(zeroVideos.recommendation, 'auto_pass');
  assert.equal(zeroVideos.score, 65);
  assert.equal(zeroVideos.checks.find((check) => check.metric === 'conversion').score, 0);
});

test('missing orders or views still follows missing_data_action', () => {
  const missingOrders = testScoreCandidate({
    fans: 8000,
    avg_view: 5000,
    monthly_avg_view: 5000,
    monthly_videos: 20,
  });
  assert.equal(typeof missingOrders.score, 'number');
  assert.ok(Number.isFinite(missingOrders.score));
  assert.equal(missingOrders.recommendation, 'manual_review');
  assert.match(String(missingOrders.reason), /缺少30天数据，需人工确认/);

  const missingViews = testScoreCandidate({
    fans: 8000,
    monthly_videos: 20,
    total_orders: 200,
    sales_count_30d: 200,
  });
  assert.equal(missingViews.recommendation, 'manual_review');
  assert.match(String(missingViews.reason), /缺少30天数据，需人工确认/);

  const failOnMissing = scoreByReviewStandard({
    fans: 8000,
    avg_view: 5000,
    monthly_avg_view: 5000,
    monthly_videos: 20,
  }, { ...DEFAULT_REVIEW_STANDARD, missing_data_action: '不通过' }, 'invite');
  assert.equal(failOnMissing.recommendation, 'manual_review');
  assert.match(String(failOnMissing.reason), /缺少30天数据，按当前标准不通过/);
});

test('score gate queues creators missing videos if the numeric score passes', async () => {
  const shops = [{ id: 'mir', name: 'MIR HOME', access_token: 't', shop_cipher: 'c' }];
  const tasks = [];
  const cursors = new Map();
  const stats = new Map();
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run(...args) {
          if (/INSERT INTO marketplace_search_cursors/.test(sql)) {
            cursors.set(args[0], {
              shop_id: args[0], filter_index: args[1], filter_json: args[2], page_token: args[3],
              search_key: args[4], page_count: args[5], empty_pages: args[6], cycle_count: args[7],
            });
          }
          if (/INSERT INTO marketplace_invite_daily_stats/.test(sql)) {
            stats.set(`${args[0]}:${args[1]}`, { shop_id: args[0], day: args[1] });
          }
        },
        get(...args) {
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: 0 };
          if (/marketplace_search_cursors/.test(sql)) return cursors.get(args[0]) || null;
          if (/marketplace_invite_daily_stats/.test(sql)) return stats.get(`${args[0]}:${args[1]}`) || { shop_id: args[0], day: args[1] };
          if (/FROM shops WHERE id/.test(sql)) return shops.find((item) => item.id === args[0]) || null;
          return null;
        },
        all(...args) {
          if (/FROM invitation_records/.test(sql)) return [];
          if (/FROM agent_workflow_tasks/.test(sql)) return tasks.filter((item) => item.shop_id === args[0]);
          if (/FROM shops/.test(sql)) return shops;
          return [];
        },
      };
    },
  };

  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async ({ path }) => {
      if (path.includes('creator_outreach/quota')) return { unlimited: true, quota_use: 0 };
      return {
        creators: [
          { creator_open_id: 'novid-1', username: 'no_videos', nickname: 'No Videos', follower_count: 8000, avgView: 5000, salesCount30d: 200 },
          { creator_open_id: 'low-1', username: 'low_score', nickname: 'Low Score', follower_count: 3000, avgView: 100, videos30d: 10, salesCount30d: 10 },
        ],
        next_page_token: '',
        search_key: 'key-1',
      };
    },
    normalizeAffiliateCreator: (raw) => ({
      uid: raw.creator_open_id,
      creatorOpenId: raw.creator_open_id,
      creatorName: raw.nickname,
      creatorHandle: raw.username,
      fans: raw.follower_count,
      category: '',
      fulfillmentRate: 0,
      avgView: raw.avgView,
      videos30d: raw.videos30d,
      salesCount30d: raw.salesCount30d,
      salesAmount30d: raw.salesAmount30d || 0,
    }),
    insertWorkflowTask: (_workflowId, _type, status, candidate, audit) => {
      tasks.push({ id: tasks.length + 1, shop_id: candidate.shop_id, uid: candidate.uid, status, audit, payload: { candidate } });
    },
    sendWorkflowInvitations: async () => [],
    getWorkflow: () => ({ id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } }),
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_target_count: 1000, invite_daily_limit_by_shop: '{"mir":1000}', marketplace_search_invite_autorun: 1 }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    getReviewStandard: () => DEFAULT_REVIEW_STANDARD,
    agentScoreCandidate: testScoreCandidate,
    writeSyncLog: () => {},
  });

  const workflow = { id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } };
  const result = await api.replenishShop(shops[0], workflow, { force: true });
  assert.equal(result.queued, 1);
  assert.equal(result.skipped_score, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].uid, 'novid-1');
  assert.equal(tasks[0].audit.recommendation, 'auto_pass');
  assert.equal(tasks[0].audit.score, 65);
  assert.equal(tasks[0].audit.checks.find((check) => check.metric === 'conversion').score, 0);
  assert.equal(tasks[0].payload.candidate.monthly_videos, 0);
});



test('pacer tick does not send for historical active workflows unless one is individually running', async () => {
  const previousExecute = process.env.TK_INVITE_EXECUTE;
  const previousAutorun = process.env.TK_MARKETPLACE_INVITE_AUTORUN;
  process.env.TK_INVITE_EXECUTE = '1';
  delete process.env.TK_MARKETPLACE_INVITE_AUTORUN;
  try {
    const historical = { id: 99, config: { source: 'marketplace_search', shop: 'oku', invite_daily_limit: 1000 } };
    const running = { id: 4, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000 } };
    let selected = null;
    const stubDb = {
      exec() {},
      prepare() {
        return { get() { return null; }, all() { return []; }, run() { return {}; } };
      },
    };
    const api = createMarketplaceSearchInvite({
      db: stubDb,
      getWorkflow: () => historical,
      getRunningMarketplaceWorkflow: () => selected,
      getAgentSettings: () => ({ marketplace_search_invite_autorun: 1, invite_daily_limit: 1000 }),
      getAgentRuntime: () => ({ paused: false }),
      getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
      writeSyncLog: () => {},
    });
    const skipped = await api.tick();
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, '没有进行中的查找达人任务');

    // A running workflow is selected instead of the latest active=1 row.
    selected = running;
    const started = await api.tick();
    assert.equal(started.skipped, false);
    assert.ok(Array.isArray(started.results));
  } finally {
    if (previousExecute === undefined) delete process.env.TK_INVITE_EXECUTE;
    else process.env.TK_INVITE_EXECUTE = previousExecute;
    if (previousAutorun === undefined) delete process.env.TK_MARKETPLACE_INVITE_AUTORUN;
    else process.env.TK_MARKETPLACE_INVITE_AUTORUN = previousAutorun;
  }
});



test('daily limit does not inherit the task target, and the target is a hard stop', async () => {
  const shop = { id: 'mir', name: 'MIR HOME', access_token: 't', shop_cipher: 'c' };
  const records = [];
  for (let i = 0; i < 100; i += 1) {
    records.push({ uid: `sent-${i}`, status: 'sent', source: 'workflow:1', shop_id: 'mir', sent_at: '2026-11-23 02:00:00' });
  }
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run() { return {}; },
        get(...args) {
          if (/COUNT\(DISTINCT uid\)/.test(sql) && /source = \?/.test(sql)) {
            return { c: records.filter((row) => row.source === args[0] && row.status === 'sent').length };
          }
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: records.length };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: 0 };
          return null;
        },
        all() { return []; },
      };
    },
  };
  const workflow = { id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 100 } };
  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async () => ({ unlimited: true, quota_sum: 0, quota_use: 0 }),
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_target_count: 1000, invite_daily_limit_by_shop: '{}' }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    nowText: () => '2026-11-23 13:00:00',
  });
  assert.equal(api.configuredDailyLimit(shop.id, workflow), 1000);
  assert.equal(api.workflowTargetCount(workflow), 100);
  assert.equal(api.workflowSentCount(workflow), 100);
  assert.equal(api.workflowTargetRemain(workflow), 0);
  const cap = await api.effectiveShopCap(shop, workflow, { force: true });
  assert.equal(cap.remain, 0);
  assert.match(cap.reason, /任务邀约人数已达上限/);
});

test('sendBatchForShop sends at most 50 creators in one official invitation group', async () => {
  const shop = { id: 'mir', name: 'MIR HOME', access_token: 't', shop_cipher: 'c' };
  const tasks = [];
  for (let i = 0; i < 60; i += 1) {
    tasks.push({
      id: i + 1,
      workflow_id: 1,
      task_type: 'invite',
      status: 'admin_approved',
      shop_id: 'mir',
      uid: `u${i}`,
      payload_json: JSON.stringify({ candidate: { shop_id: 'mir', uid: `u${i}`, creator_open_id: `open-${i}` } }),
    });
  }
  let sentBatch = null;
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run() { return {}; },
        get(...args) {
          if (/COUNT\(DISTINCT uid\)/.test(sql) && /source = \?/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: tasks.length };
          return null;
        },
        all(...args) {
          if (/FROM agent_workflow_tasks/.test(sql) && /admin_approved/.test(sql)) {
            const shopId = args[1];
            const limit = Number(args[2] || 0);
            return tasks.filter((item) => item.shop_id === shopId).slice(0, limit);
          }
          return [];
        },
      };
    },
  };
  const workflow = { id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000 } };
  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async () => ({ unlimited: true, quota_sum: 0, quota_use: 0 }),
    sendWorkflowInvitations: async (batch) => {
      sentBatch = batch;
      return batch.map((task) => ({ task_id: task.id, status: 'sent' }));
    },
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_daily_limit_by_shop: '{"mir":1000}' }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    nowText: () => '2026-11-23 13:00:00',
  });
  const result = await api.sendBatchForShop(shop, workflow);
  assert.equal(result.sent, 50);
  assert.equal(sentBatch.length, 50);
  assert.equal(sentBatch[0].uid, 'u0');
  assert.equal(sentBatch[49].uid, 'u49');
});

test('tick pauses the workflow when its invite target is already reached', async () => {
  const previousExecute = process.env.TK_INVITE_EXECUTE;
  const previousAutorun = process.env.TK_MARKETPLACE_INVITE_AUTORUN;
  process.env.TK_INVITE_EXECUTE = '1';
  delete process.env.TK_MARKETPLACE_INVITE_AUTORUN;
  try {
    const running = { id: 11, config: { source: 'marketplace_search', shop: 'oku', invite_daily_limit: 1000, invite_target_count: 100 } };
    const paused = [];
    const db = {
      exec() {},
      prepare(sql) {
        return {
          run(...args) {
            if (/UPDATE agent_workflows/.test(sql)) paused.push({ id: args[1], run_state: args[0] });
            return {};
          },
          get(...args) {
            if (/COUNT\(DISTINCT uid\)/.test(sql) && /source = \?/.test(sql)) return { c: 384 };
            if (/COUNT\(\*\)/.test(sql)) return { c: 0 };
            return null;
          },
          all() { return []; },
        };
      },
    };
    const api = createMarketplaceSearchInvite({
      db,
      getRunningMarketplaceWorkflow: () => running,
      getAgentSettings: () => ({ marketplace_search_invite_autorun: 1, invite_daily_limit: 1000 }),
      getAgentRuntime: () => ({ paused: false }),
      getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
      pauseWorkflowTask: (workflowId) => { paused.push({ id: workflowId, run_state: 'paused' }); },
      sendWorkflowInvitations: async () => { throw new Error('should not send after the target is reached'); },
      writeSyncLog: () => {},
    });
    const result = await api.tick();
    assert.equal(result.skipped, true);
    assert.match(result.reason, /任务邀约人数已达上限/);
    assert.equal(result.paused, true);
    assert.equal(paused.length, 1);
    assert.equal(paused[0].id, 11);
  } finally {
    if (previousExecute === undefined) delete process.env.TK_INVITE_EXECUTE;
    else process.env.TK_INVITE_EXECUTE = previousExecute;
    if (previousAutorun === undefined) delete process.env.TK_MARKETPLACE_INVITE_AUTORUN;
    else process.env.TK_MARKETPLACE_INVITE_AUTORUN = previousAutorun;
  }
});



test('product id parsing and skip rules prefer receive limits over prior invites', () => {
  assert.deepEqual(parseProductIds([36], '36', '["36"]'), ['36']);
  assert.equal(officialReceiveLimitReached({}, {}), false);
  assert.equal(officialReceiveLimitReached({ profile: { has_invited_90d: true } }, { has_invited_90d: true }), false);
  assert.equal(officialReceiveLimitReached({ can_receive_invitation: false }), true);
  assert.equal(officialReceiveLimitReached({}, { invitation_remain: 0 }), true);
  assert.equal(officialReceiveLimitReached({ invitation_received_count: 5, invitation_limit: 5 }), true);
  assert.equal(officialReceiveLimitReached({ invitation_received_count: 2, invitation_limit: 5 }), false);

  assert.equal(shouldSkipCreatorRecord({ status: 'failed', provider_message: 'error 16024049' }, ['36']), true);
  assert.equal(shouldSkipCreatorRecord({
    status: 'sent', product_id: 1, product_ids: '[1]', provider_message: 'ok',
  }, ['36']), false);
  assert.equal(shouldSkipCreatorRecord({
    status: 'sent', product_id: 36, product_ids: '[36]', provider_message: 'ok',
  }, ['36']), true);
  assert.equal(shouldSkipCreatorRecord({
    status: 'failed', product_id: 36, provider_message: 'TikTok Target Collaboration 创建成功但未返回 target_collaboration_id：{"target_collaboration_conflicts":[]}',
  }, ['36']), true);
  assert.equal(shouldSkipCreatorRecord({
    status: 'failed', product_id: 1, provider_message: 'target_collaboration_conflicts',
  }, ['36']), false);
  assert.equal(DEFAULT_BASE_BODY.affiliate_data.not_invited_l90_days, false);
});

test('search enqueue allows previously invited creators unless receive limit or same-product conflict', async () => {
  const shops = [{ id: 'oku', name: 'OKUYOSHI', access_token: 't', shop_cipher: 'c' }];
  const tasks = [];
  const records = [
    { uid: 'other-1', creator_open_id: 'other-1', creator_handle: 'other_handle', status: 'sent', provider_message: 'ok', shop_id: 'oku', product_id: 1, product_ids: '[1]' },
    { uid: 'same-1', creator_open_id: 'same-1', creator_handle: 'same_handle', status: 'failed', provider_message: 'target_collaboration_conflicts', shop_id: 'oku', product_id: 36, product_ids: '[36]' },
    { uid: 'quota-1', creator_open_id: 'quota-1', creator_handle: 'quota_handle', status: 'failed', provider_message: '16030100', shop_id: 'oku' },
  ];
  const cursors = new Map();
  const stats = new Map();
  let searchBody = null;
  const db = {
    exec() {},
    prepare(sql) {
      return {
        run(...args) {
          if (/INSERT INTO marketplace_search_cursors/.test(sql)) {
            cursors.set(args[0], {
              shop_id: args[0], filter_index: args[1], filter_json: args[2], page_token: args[3],
              search_key: args[4], page_count: args[5], empty_pages: args[6], cycle_count: args[7],
            });
          }
          if (/INSERT INTO marketplace_invite_daily_stats/.test(sql)) {
            stats.set(`${args[0]}:${args[1]}`, { shop_id: args[0], day: args[1] });
          }
        },
        get(...args) {
          if (/COUNT\(\*\)/.test(sql) && /invitation_records/.test(sql)) return { c: 0 };
          if (/COUNT\(\*\)/.test(sql) && /agent_workflow_tasks/.test(sql)) return { c: 0 };
          if (/marketplace_search_cursors/.test(sql)) return cursors.get(args[0]) || null;
          if (/marketplace_invite_daily_stats/.test(sql)) return stats.get(`${args[0]}:${args[1]}`) || { shop_id: args[0], day: args[1] };
          if (/FROM shops WHERE id/.test(sql)) return shops[0];
          return null;
        },
        all(...args) {
          if (/FROM invitation_records/.test(sql)) return records.filter((row) => row.shop_id === args[0]);
          if (/FROM agent_workflow_tasks/.test(sql)) return tasks.filter((item) => item.shop_id === args[0]);
          if (/FROM shops/.test(sql)) return shops;
          return [];
        },
      };
    },
  };

  const api = createMarketplaceSearchInvite({
    db,
    tiktokRequest: async ({ path, body }) => {
      if (path.includes('creator_outreach/quota')) return { unlimited: true, quota_use: 0 };
      searchBody = body;
      return {
        creators: [
          { creator_open_id: 'other-1', username: 'other_handle', nickname: 'Other', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000, profile: { has_invited_90d: true } },
          { creator_open_id: 'same-1', username: 'same_handle', nickname: 'Same', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000 },
          { creator_open_id: 'quota-1', username: 'quota_handle', nickname: 'Quota', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000 },
          { creator_open_id: 'limit-1', username: 'limit_handle', nickname: 'Limit', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000, can_receive_invitation: false },
          { creator_open_id: 'fresh-1', username: 'fresh_handle', nickname: 'Fresh', follower_count: 8000, avgView: 5000, videos30d: 100, salesCount30d: 1000 },
        ],
        next_page_token: 'page-2',
        search_key: 'key-1',
      };
    },
    normalizeAffiliateCreator: (raw) => ({
      uid: raw.creator_open_id,
      creatorOpenId: raw.creator_open_id,
      creatorName: raw.nickname,
      creatorHandle: raw.username,
      fans: raw.follower_count,
      category: '',
      fulfillmentRate: 0,
      avgView: raw.avgView,
      videos30d: raw.videos30d,
      salesCount30d: raw.salesCount30d,
      salesAmount30d: 10000,
    }),
    insertWorkflowTask: (_workflowId, _type, status, candidate) => {
      tasks.push({ id: tasks.length + 1, shop_id: candidate.shop_id, uid: candidate.uid, status, workflow_id: 12 });
    },
    sendWorkflowInvitations: async () => [],
    getWorkflow: () => ({ id: 12, config: { source: 'marketplace_search', shop: 'oku', product_ids: [36], invite_daily_limit: 1000, invite_target_count: 1000 } }),
    getAgentSettings: () => ({
      invite_daily_limit: 1000,
      marketplace_search_invite_autorun: 1,
      marketplace_search_base_body: JSON.stringify({ affiliate_data: { not_invited_l90_days: true } }),
    }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    getReviewStandard: () => DEFAULT_REVIEW_STANDARD,
    agentScoreCandidate: testScoreCandidate,
    writeSyncLog: () => {},
  });

  const workflow = { id: 12, config: { source: 'marketplace_search', shop: 'oku', product_ids: [36], invite_daily_limit: 1000, invite_target_count: 1000 } };
  const result = await api.replenishShop(shops[0], workflow, { force: true });
  assert.equal(searchBody.affiliate_data.not_invited_l90_days, false);
  assert.equal(result.queued, 2);
  assert.equal(result.skipped_invited, 2);
  assert.equal(result.skipped_invalid, 1);
  assert.deepEqual(tasks.map((row) => row.uid), ['other-1', 'fresh-1']);
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
