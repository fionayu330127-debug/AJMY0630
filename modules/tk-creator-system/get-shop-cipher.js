// get-shop-cipher.js
// 一次性脚本：调用 TikTok Shop "Get Authorized Shops" 接口，查询并打印 shop_id 对应的 shop_cipher
// 用法：在 tk-creator-system 目录下执行  node get-shop-cipher.js

require('dotenv').config();
const https = require('https');
const crypto = require('crypto');

const APP_KEY = process.env.TK_APP_KEY;
const APP_SECRET = process.env.TK_APP_SECRET;
const ACCESS_TOKEN = process.env.TK_ACCESS_TOKEN;

if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
  console.error('❌ .env 里缺少 TK_APP_KEY / TK_APP_SECRET / TK_ACCESS_TOKEN，请先确认这三个值都存在');
  process.exit(1);
}

const HOST = 'open-api.tiktokglobalshop.com'; // 如果你的 App 是美区独立站点，可能要换成对应区域的 host
const PATH = '/authorization/202309/shops';

// TikTok Shop 请求签名算法：
// 1. 取出除 sign / access_token 外的所有参数，按 key 字母顺序排序
// 2. 拼接成 key1value1key2value2... 的形式
// 3. 前面拼上请求路径，前后用 app_secret 包裹
// 4. 用 app_secret 做 HMAC-SHA256，转成十六进制
function generateSign(path, params, appSecret) {
  const sortedKeys = Object.keys(params).sort();
  let base = path;
  for (const key of sortedKeys) {
    base += key + params[key];
  }
  base = appSecret + base + appSecret;
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex');
}

const timestamp = Math.floor(Date.now() / 1000).toString();
const baseParams = { app_key: APP_KEY, timestamp };
const sign = generateSign(PATH, baseParams, APP_SECRET);

const query = new URLSearchParams({ ...baseParams, sign }).toString();

const options = {
  hostname: HOST,
  port: 443,
  path: `${PATH}?${query}`,
  method: 'GET',
  headers: {
    'x-tts-access-token': ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let buf = '';
  res.on('data', chunk => buf += chunk);
  res.on('end', () => {
    console.log(`HTTP状态码: ${res.statusCode}`);
    let data;
    try {
      data = JSON.parse(buf);
    } catch (e) {
      console.error('❌ 返回的不是 JSON，原始内容如下（前 300 字符）：');
      console.error(buf.slice(0, 300));
      return;
    }

    if (data.code !== 0) {
      console.error(`❌ 接口返回错误：code=${data.code}, message=${data.message}`);
      console.error('完整返回：', JSON.stringify(data, null, 2));
      return;
    }

    const shops = data.data && data.data.shops;
    if (!shops || !shops.length) {
      console.log('⚠️ 没有查到任何已授权的店铺，请确认授权流程是否真的完成了');
      return;
    }

    console.log('✅ 查到以下已授权店铺：\n');
    shops.forEach(shop => {
      console.log(`店铺名: ${shop.name || '(无)'}`);
      console.log(`shop_id: ${shop.id}`);
      console.log(`shop_cipher: ${shop.cipher}`);
      console.log('---');
    });
    console.log('\n把对应店铺的 shop_cipher 复制到 .env 里的 TK_SHOP_CIPHER= 后面即可。');
  });
});

req.on('error', (e) => {
  console.error('❌ 请求出错：', e.message);
});

req.end();
