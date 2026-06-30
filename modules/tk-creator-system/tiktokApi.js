const crypto = require('node:crypto');
const { getAppConfig } = require('./tiktokSecrets');
const db = require('./db');

const DEFAULT_BASE_URL = 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE_URL = 'https://auth.tiktok-shops.com';

function stableJson(value) {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value);
}

function buildSign({ path, query, body, appSecret }) {
  const sortedKeys = Object.keys(query)
    .filter((key) => key !== 'sign' && key !== 'access_token')
    .sort();

  const queryText = sortedKeys.map((key) => `${key}${query[key]}`).join('');
  const bodyText = stableJson(body);
  const signText = `${appSecret}${path}${queryText}${bodyText}${appSecret}`;

  return crypto.createHmac('sha256', appSecret).update(signText).digest('hex');
}

function isExpiredCredential(payload, status, text = '') {
  const message = String(payload?.message || payload?.error?.message || text || '');
  return /expired credentials|access_token.*expired|x-tts-access-token.*expired|token.*expired/i.test(message) ||
    [105005, 105008, 106001].includes(Number(payload?.code || status || 0));
}

function isRateLimited(payload, status, text = '') {
  const message = String(payload?.message || payload?.error?.message || text || '');
  return Number(status || 0) === 429 || /too many requests|rate limit|throttl/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshAccessToken(shopId) {
  const shop = db.prepare('SELECT id, refresh_token FROM shops WHERE id = ?').get(shopId);
  if (!shop?.refresh_token) {
    throw new Error(`${shopId || '店铺'} access_token 已过期，且没有 refresh_token，请重新授权`);
  }

  const { appKey: app_key, appSecret: app_secret } = getAppConfig(shopId);
  if (!app_key || !app_secret) {
    throw new Error(`缺少 ${shopId} 店铺的 TikTok App Key 或 App Secret，无法自动刷新 token`);
  }

  const url = new URL('/api/v2/token/refresh', AUTH_BASE_URL);
  url.searchParams.set('app_key', app_key);
  url.searchParams.set('app_secret', app_secret);
  url.searchParams.set('refresh_token', shop.refresh_token);
  url.searchParams.set('grant_type', 'refresh_token');

  const response = await fetch(url);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`TikTok token 刷新接口未返回 JSON：HTTP ${response.status} ${text.slice(0, 160)}`);
  }
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message || `TikTok token 自动刷新失败（HTTP ${response.status}）`);
  }

  const data = payload.data || {};
  const nextAccessToken = data.access_token || data.accessToken;
  const nextRefreshToken = data.refresh_token || data.refreshToken || shop.refresh_token;
  if (!nextAccessToken) throw new Error('TikTok token 自动刷新成功但未返回 access_token');

  db.prepare(`
    UPDATE shops
    SET access_token = ?, refresh_token = ?
    WHERE id = ?
  `).run(nextAccessToken, nextRefreshToken, shopId);
  try {
    db.prepare(`
      INSERT INTO sync_logs (shop_id, source, status, message, created_at)
      VALUES (?, 'token-refresh', 'success', 'access_token 自动刷新成功', datetime('now'))
    `).run(shopId);
  } catch (_) {}
  return nextAccessToken;
}

async function tiktokRequestOnce({ path, method = 'GET', query = {}, body = {}, accessToken, shopId }) {
  const { appKey, appSecret } = getAppConfig(shopId);
  const baseUrl = process.env.TK_API_BASE || DEFAULT_BASE_URL;

  if (!appKey || !appSecret) {
    throw new Error('缺少 TK_APP_KEY 或 TK_APP_SECRET');
  }
  if (!accessToken) {
    throw new Error('缺少店铺 access_token');
  }

  const finalQuery = {
    app_key: appKey,
    timestamp: Math.floor(Date.now() / 1000),
    ...query,
  };
  finalQuery.sign = buildSign({ path, query: finalQuery, body, appSecret });

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(finalQuery)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const options = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tts-access-token': accessToken,
    },
  };

  if (method !== 'GET') {
    options.body = stableJson(body || {});
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`TikTok API 返回非 JSON：HTTP ${response.status} ${text.slice(0, 160)}`);
  }

  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    const error = new Error(payload.message || payload.error?.message || `TikTok API 请求失败：HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    error.responseText = text;
    throw error;
  }

  return payload.data || payload;
}

async function tiktokRequest(args) {
  const maxRetries = Number(process.env.TK_API_RATE_LIMIT_RETRIES || 2);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await tiktokRequestOnce(args);
    } catch (error) {
      if (args.shopId && isExpiredCredential(error.payload, error.status, error.responseText || error.message)) {
        const nextAccessToken = await refreshAccessToken(args.shopId);
        return tiktokRequestOnce({ ...args, accessToken: nextAccessToken });
      }
      if (attempt < maxRetries && isRateLimited(error.payload, error.status, error.responseText || error.message)) {
        const delay = Number(process.env.TK_API_RATE_LIMIT_DELAY_MS || 3000) * (attempt + 1);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

module.exports = {
  tiktokRequest,
  refreshAccessToken,
};
