require('dotenv').config();

const fs = require('node:fs');
const db = require('../db');
const { tiktokRequest } = require('../tiktokApi');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function parseJson(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 参数解析失败：${error.message}`);
  }
}

function readJsonArg(args, key, fileKey, fallback = {}) {
  if (args[fileKey]) {
    return parseJson(fs.readFileSync(args[fileKey], 'utf8'), fallback);
  }
  return parseJson(args[key], fallback);
}

function printUsageAndExit() {
  console.log(`
用法：
  node scripts/test-tiktok-im-api.js --shop oku --mode list --path "/affiliate_seller/202508/conversations" --query "{}"
  node scripts/test-tiktok-im-api.js --shop oku --mode create --creator-open-id "xxx" --path "/affiliate_seller/202508/conversations" --body '{"creator_open_id":"xxx"}' --execute
  node scripts/test-tiktok-im-api.js --shop oku --mode send --path "/affiliate_seller/202412/conversations/xxx/messages" --body '{"msg_type":"TEXT","content":"{\"content\":\"测试消息\"}"}' --execute
  node scripts/test-tiktok-im-api.js --shop oku --mode send --path "/affiliate_seller/202412/conversations/xxx/messages" --body-file .tmp-im-body.json --execute

说明：
  --execute 不传时只打印将要请求的内容，不会真实调用 TikTok API。
  --path 和 --body 请优先从 TikTok 文档右侧 API Testing Tool 复制。
  当前脚本会自动使用系统 shops 表里的 access_token 和 shop_cipher。
`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printUsageAndExit();

  const shopId = args.shop || 'oku';
  const mode = args.mode || 'list';
  const method = String(args.method || (mode === 'list' ? 'GET' : 'POST')).toUpperCase();
  const path = args.path;
  const execute = Boolean(args.execute);

  if (!path) {
    console.error('缺少 --path。请从 TikTok 文档 API Testing Tool 复制接口 path。');
    printUsageAndExit();
  }

  const shop = db.prepare(`
    SELECT id, name, access_token, shop_cipher
    FROM shops
    WHERE id = ?
  `).get(shopId);

  if (!shop) throw new Error(`找不到店铺：${shopId}`);
  if (!shop.access_token) throw new Error(`${shop.name} 缺少 access_token，请先授权`);
  if (!shop.shop_cipher) throw new Error(`${shop.name} 缺少 shop_cipher，请先授权`);

  const query = {
    shop_cipher: shop.shop_cipher,
    ...readJsonArg(args, 'query', 'query-file', {}),
  };
  const body = readJsonArg(args, 'body', 'body-file', {});

  if (args['creator-open-id'] && !body.creator_open_id) {
    body.creator_open_id = args['creator-open-id'];
  }
  if (args.message && !body.content) {
    body.content = args.message;
  }

  const request = {
    shop: { id: shop.id, name: shop.name },
    mode,
    method,
    path,
    query,
    body,
    execute,
  };

  console.log('TikTok IM API 测试请求：');
  console.log(JSON.stringify(request, null, 2));

  if (!execute) {
    console.log('\n当前为 dry-run，未发送请求。确认参数无误后追加 --execute。');
    return;
  }

  const data = await tiktokRequest({
    path,
    method,
    query,
    body,
    accessToken: shop.access_token,
    shopId: shop.id,
  });

  console.log('\nTikTok API 返回：');
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
