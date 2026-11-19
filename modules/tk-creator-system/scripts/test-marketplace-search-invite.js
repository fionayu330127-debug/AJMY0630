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
  createMarketplaceSearchInvite,
} = require('../marketplaceSearchInvite');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
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
    { uid: 'old-1', creator_open_id: 'old-1', creator_handle: 'old_handle', status: 'sent', provider_message: 'ok', shop_id: 'mir', sent_at: '2026-11-19 02:00:00' },
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
      avgView: 0,
      videos30d: 1,
      salesCount30d: 10,
      salesAmount30d: 100,
    }),
    insertWorkflowTask: (_workflowId, _type, status, candidate) => {
      tasks.push({ id: tasks.length + 1, shop_id: candidate.shop_id, uid: candidate.uid, status, payload: { candidate } });
    },
    sendWorkflowInvitations: async () => [],
    getWorkflow: () => ({ id: 1, config: { source: 'marketplace_search', shop: 'mir', invite_daily_limit: 1000, invite_target_count: 1000, invite_max_per_creator: 1 } }),
    getAgentSettings: () => ({ invite_daily_limit: 1000, invite_target_count: 1000, invite_daily_limit_by_shop: '{"mir":1000}', marketplace_search_invite_autorun: 1 }),
    getAgentRuntime: () => ({ paused: false }),
    getAgentFlowStates: () => [{ key: 'auto_invite', active: true }],
    getReviewStandard: () => ({ fans_hard_limit: 1000, version: 1 }),
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
