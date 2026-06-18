const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://open-api.tiktokglobalshop.com';

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

async function tiktokRequest({ path, method = 'GET', query = {}, body = {}, accessToken }) {
  const appKey = process.env.TK_APP_KEY;
  const appSecret = process.env.TK_APP_SECRET;
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
    throw new Error(payload.message || payload.error?.message || `TikTok API 请求失败：HTTP ${response.status}`);
  }

  return payload.data || payload;
}

module.exports = {
  tiktokRequest,
};
