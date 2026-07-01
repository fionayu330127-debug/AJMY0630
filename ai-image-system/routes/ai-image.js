// routes/ai-image.js
// AI image module for extracting product selling points and generating/editing images.

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

const textClient = new OpenAI({
  apiKey: env('OPENAI_TEXT_API_KEY') || env('OPENAI_API_KEY'),
  baseURL: env('OPENAI_BASE_URL') || undefined,
});

const IMAGE_BASE_URL = Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_IMAGE_BASE_URL')
  ? env('OPENAI_IMAGE_BASE_URL')
  : env('OPENAI_BASE_URL');

const TEXT_MODEL = env('OPENAI_TEXT_MODEL', 'gpt-4o');
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_SIZE = env('OPENAI_IMAGE_SIZE');
const TEXT_LIKE_MODEL_RE = /^(gpt-[45]|o[134]|chatgpt-|claude-|gemini-|deepseek-)/i;

const SHOT_LIST = [
  { key: 'hero', label: '主图 / 产品正面展示' },
  { key: 'scenario', label: '使用场景图' },
  { key: 'feature', label: '核心卖点特写' },
  { key: 'size', label: '尺寸标注图' },
  { key: 'accessory', label: '配件/包装展示' },
  { key: 'comparison', label: '与竞品对比卖点图' },
  { key: 'lifestyle', label: '生活方式/搭配场景图' },
];

function getShotByIndex(index) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= SHOT_LIST.length) {
    const error = new Error(`Invalid shotIndex: must be 0-${SHOT_LIST.length - 1}`);
    error.statusCode = 400;
    throw error;
  }
  return SHOT_LIST[numericIndex];
}

function buildBaseInfo(extracted) {
  return [
    extracted.function_desc,
    extracted.target_buyer,
    extracted.buy_reason,
    extracted.trigger_scenario,
    extracted.competitor_points,
    extracted.complaint_insights,
    extracted.size_info,
    extracted.accessory_info,
  ].filter(Boolean).join('；');
}

function buildShotPrompt(shot, baseInfo) {
  return String(baseInfo || '').trim();
}

function assertImageModelConfigured() {
  if (!IMAGE_MODEL) {
    const error = new Error('OPENAI_IMAGE_MODEL is empty. Set OPENAI_IMAGE_MODEL=gpt-image-2 in ai-image-system/.env and restart the server.');
    error.statusCode = 500;
    throw error;
  }
  if (!env('CCTQ_IMAGE') && !env('OPENAI_IMAGE_API_KEY') && !env('OPENAI_API_KEY')) {
    const error = new Error('CCTQ_IMAGE or OPENAI_IMAGE_API_KEY is empty. Set the image API key in ai-image-system/.env and restart the server.');
    error.statusCode = 500;
    throw error;
  }
  if (TEXT_LIKE_MODEL_RE.test(IMAGE_MODEL)) {
    const error = new Error(
      `OPENAI_IMAGE_MODEL must be an image model, got "${IMAGE_MODEL}". Use a model such as "gpt-image-2" or the image model name provided by your gateway.`
    );
    error.statusCode = 500;
    throw error;
  }
}

function sendUpstreamError(res, err, fallbackMessage) {
  const status = err.statusCode || err.status || 500;
  const causeMessage = err.cause?.message || err.cause?.code || '';
  const upstreamMessage = [err.error?.message || err.message || fallbackMessage, causeMessage]
    .filter(Boolean)
    .join(' - ');
  res.status(status).json({ error: `生成失败：${upstreamMessage}` });
}

function parseJsonField(value, fieldName) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const err = new Error(`Invalid ${fieldName}: must be valid JSON`);
    err.statusCode = 400;
    throw err;
  }
}

function bufferToDataUrl(buffer, mimetype) {
  return `data:${mimetype};base64,${buffer.toString('base64')}`;
}

async function uploadableImage(buffer, filename = 'image.png', mimetype = 'image/png') {
  return { buffer, filename, mimetype };
}

function uploadableImagesFromFiles(files, defaultPrefix = 'reference') {
  return (files || []).map((file, index) => ({
    buffer: file.buffer,
    filename: file.originalname || `${defaultPrefix}-${index + 1}.png`,
    mimetype: file.mimetype || 'image/png',
  }));
}

function imageApiKey() {
  return env('CCTQ_IMAGE') || env('OPENAI_IMAGE_API_KEY') || env('OPENAI_API_KEY');
}

function imageApiUrl(endpoint) {
  const baseURL = IMAGE_BASE_URL || 'https://www.cctq.ai/v1';
  return `${baseURL.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
}

function logImageEditRequest(label, images, prompt) {
  console.log('[ai-image] images/edits request', {
    label,
    model: IMAGE_MODEL,
    size: chooseImageSize(images),
    imageCount: images.length,
    imageBytes: images.map((image) => image.buffer?.length || 0),
    filenames: images.map((image) => image.filename || 'image.png'),
    promptChars: String(prompt || '').length,
  });
}

function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpegSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readImageSize(buffer) {
  return readPngSize(buffer) || readJpegSize(buffer);
}

function chooseImageSize(images = []) {
  if (IMAGE_SIZE) return IMAGE_SIZE;
  const size = readImageSize(images[0]?.buffer);
  if (!size?.width || !size?.height) return '1024x1024';
  const ratio = size.width / size.height;
  if (ratio < 0.85) return '1024x1536';
  if (ratio > 1.18) return '1536x1024';
  return '1024x1024';
}

function buildMultipartBody(fields, images = []) {
  const boundary = `----ai-image-system-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  function push(value) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
  }

  for (const [name, value] of Object.entries(fields)) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(value);
    push('\r\n');
  }

  for (const image of images) {
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="image"; filename="${image.filename || 'image.png'}"\r\n` +
      `Content-Type: ${image.mimetype || 'image/png'}\r\n\r\n`
    );
    push(image.buffer);
    push('\r\n');
  }

  push(`--${boundary}--\r\n`);
  const body = Buffer.concat(chunks);
  return { body, boundary };
}

async function readImageResultAsB64(item) {
  if (item?.b64_json) return item.b64_json;
  if (!item?.url) throw new Error('image result did not include b64_json or url');

  const resp = await fetch(item.url, {
    headers: {
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
      'User-Agent': 'ai-image-system-cctq-image/1.0',
    },
  });
  if (!resp.ok) throw new Error(`failed to download image result: ${resp.status} ${resp.statusText}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function parseImageResponse(resp) {
  const text = await resp.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`image API did not return JSON: ${resp.status} ${resp.statusText} - ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const message = payload.error?.message || payload.message || text;
    const error = new Error(`request failed with HTTP ${resp.status}: ${message}`);
    error.statusCode = resp.status;
    throw error;
  }
  if (!Array.isArray(payload.data) || !payload.data.length) {
    throw new Error('image result did not include a non-empty data list');
  }
  return payload;
}

function isTransientImageNetworkError(err) {
  const message = String(err?.message || err?.cause?.message || err?.code || '');
  return /socket hang up|ECONNRESET|fetch failed|other side closed|timeout|bad gateway|Client network socket disconnected before secure TLS connection was established|TLS connection/i.test(message);
}

async function postBufferWithFetch(urlString, headers, body) {
  const fetchHeaders = { ...headers };
  delete fetchHeaders.Connection;
  delete fetchHeaders.connection;
  delete fetchHeaders['Content-Length'];
  delete fetchHeaders['content-length'];

  const resp = await fetch(urlString, {
    method: 'POST',
    headers: fetchHeaders,
    body,
  });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    text: async () => text,
  };
}

function postBufferRaw(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: 600000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        resolve({
          ok: resp.statusCode >= 200 && resp.statusCode < 300,
          status: resp.statusCode,
          statusText: resp.statusMessage,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Network timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postBuffer(urlString, headers, body) {
  try {
    return await postBufferRaw(urlString, headers, body);
  } catch (err) {
    if (!isTransientImageNetworkError(err)) throw err;
    console.warn('[ai-image] native https post failed, retrying with fetch transport:', err.message);
    return postBufferWithFetch(urlString, headers, body);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isImageEditGatewayFailure(err) {
  const message = String(err?.message || '');
  const status = err?.statusCode || err?.status || 0;
  return status === 502 || isTransientImageNetworkError(err) || /bad gateway/i.test(message);
}

async function withImageRetry(task, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      const message = err.message || '';
      const retryable = isTransientImageNetworkError(err);
      if (!retryable || attempt === 3) break;
      console.warn(`[ai-image] ${label} failed, retry ${attempt + 1}/3:`, message);
      await wait(3000 * attempt);
    }
  }
  throw lastError;
}

async function cctqImageEdit({ prompt, images, retry = true, label = 'edit' }) {
  const finalPrompt = String(prompt || '').trim();
  const size = chooseImageSize(images);
  logImageEditRequest(label, images, finalPrompt);
  const { body, boundary } = buildMultipartBody({
    model: IMAGE_MODEL,
    prompt: finalPrompt,
    size,
    quality: 'auto',
  }, images);

  const request = () => postBuffer(imageApiUrl('/images/edits'), {
      Authorization: `Bearer ${imageApiKey()}`,
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
      'User-Agent': 'cctq-image-skill/1.0',
      Connection: 'close',
    }, body);
  const resp = retry ? await withImageRetry(request, 'cctq images edit') : await request();
  const payload = await parseImageResponse(resp);
  return readImageResultAsB64(payload.data[0]);
}

async function cctqImageEditStrict({ prompt, images, label }) {
  try {
    return await cctqImageEdit({ prompt, images, label });
  } catch (err) {
    if (!isImageEditGatewayFailure(err)) throw err;
    console.warn('[ai-image] images/edits failed; refusing text-to-image fallback:', err.message);
    throw err;
  }
}

router.get('/config', (req, res) => {
  res.json({
    baseURL: env('OPENAI_BASE_URL') || null,
    imageBaseURL: IMAGE_BASE_URL || 'openai-default',
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    hasTextApiKey: Boolean(env('OPENAI_TEXT_API_KEY') || env('OPENAI_API_KEY')),
    hasImageApiKey: Boolean(env('CCTQ_IMAGE') || env('OPENAI_IMAGE_API_KEY') || env('OPENAI_API_KEY')),
    imageApiMode: 'cctq-image-skill',
  });
});

router.post('/extract', upload.array('images', 8), async (req, res) => {
  try {
    const { product_link, note } = req.body;
    const files = req.files || [];

    if (!files.length && !product_link) {
      return res.status(400).json({ error: '请至少上传一张参考图，或填写产品链接说明' });
    }

    const userContent = [
      {
        type: 'text',
        text: [
          '请基于我提供的参考图（和/或下面的补充说明），提炼这款产品的卖点信息，',
          '并用日语输出，严格按以下 JSON 结构返回，不要任何多余文字：',
          '{',
          '  "function_desc": "产品功能表达",',
          '  "target_buyer": "谁在买",',
          '  "buy_reason": "为什么买",',
          '  "trigger_scenario": "什么场景触发购买",',
          '  "competitor_points": "竞品的卖点",',
          '  "complaint_insights": "评论区用户抱怨的问题，以及能否转成视觉解释",',
          '  "size_info": "尺寸信息",',
          '  "accessory_info": "配件信息"',
          '}',
          product_link ? `\n产品/竞品链接：${product_link}` : '',
          note ? `\n补充说明：${note}` : '',
        ].join('\n'),
      },
      ...files.map((f) => ({
        type: 'image_url',
        image_url: { url: bufferToDataUrl(f.buffer, f.mimetype) },
      })),
    ];

    const completion = await textClient.chat.completions.create({
      model: TEXT_MODEL,
      messages: [{ role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
    });

    const extracted = JSON.parse(completion.choices[0].message.content);
    res.json({ extracted });
  } catch (err) {
    console.error('[ai-image/extract] 出错：', err);
    res.status(500).json({ error: err.message || '提炼卖点信息失败' });
  }
});

router.post('/generate', upload.array('images', 8), async (req, res) => {
  try {
    assertImageModelConfigured();

    const extracted = parseJsonField(req.body.extracted, 'extracted');
    const files = req.files || [];
    if (!extracted) return res.status(400).json({ error: '缺少卖点信息（extracted）' });
    if (!files.length) return res.status(400).json({ error: '缺少参考图，无法基于原图生成多图' });

    const baseInfo = buildBaseInfo(extracted);

    const referenceImage = await uploadableImage(
      files[0].buffer,
      files[0].originalname || 'reference-1.png',
      files[0].mimetype || 'image/png'
    );

    const images = [];
    for (const shot of SHOT_LIST) {
      const b64 = await cctqImageEditStrict({
        images: [referenceImage],
        prompt: baseInfo,
        label: `generate:${shot.key}`,
      });

      images.push({ key: shot.key, label: shot.label, b64 });
    }

    res.json({ images });
  } catch (err) {
    console.error('[ai-image/generate] 出错：', err);
    sendUpstreamError(res, err, '生成图片失败');
  }
});

router.post('/generate-one', upload.array('images', 8), async (req, res) => {
  try {
    assertImageModelConfigured();

    const extracted = parseJsonField(req.body.extracted, 'extracted');
    const files = req.files || [];
    if (!extracted) return res.status(400).json({ error: '缺少卖点信息（extracted）' });
    if (!files.length) return res.status(400).json({ error: '缺少参考图，无法基于原图生成图片' });

    const shot = getShotByIndex(req.body.shotIndex);
    const baseInfo = buildBaseInfo(extracted);
    const referenceImage = await uploadableImage(
      files[0].buffer,
      files[0].originalname || 'reference-1.png',
      files[0].mimetype || 'image/png'
    );
    const prompt = buildShotPrompt(shot, baseInfo);
    const b64 = await cctqImageEditStrict({
      images: [referenceImage],
      prompt,
      label: `generate-one:${shot.key}`,
    });

    res.json({ image: { key: shot.key, label: shot.label, b64 } });
  } catch (err) {
    console.error('[ai-image/generate-one] 出错：', err);
    sendUpstreamError(res, err, '生成图片失败');
  }
});

router.post('/single-generate', upload.array('images', 8), async (req, res) => {
  try {
    assertImageModelConfigured();

    const { prompt } = req.body;
    const files = req.files || [];
    if (!prompt) return res.status(400).json({ error: '缺少作图需求（prompt）' });
    if (!files.length) return res.status(400).json({ error: '请先上传一张参考素材' });

    const imagePrompt = prompt;

    const referenceImages = uploadableImagesFromFiles(files, 'single-reference');

    const b64 = await cctqImageEditStrict({
      images: referenceImages,
      prompt: imagePrompt,
      label: 'single-generate',
    });

    res.json({
      image: {
        key: 'single',
        label: '单图结果',
        b64,
      },
    });
  } catch (err) {
    console.error('[ai-image/single-generate] 出错：', err);
    sendUpstreamError(res, err, '生成单图失败');
  }
});

router.post('/edit', upload.single('image'), async (req, res) => {
  try {
    assertImageModelConfigured();

    const { prompt, image_b64 } = req.body;
    if (!prompt) return res.status(400).json({ error: '缺少修改提示词（prompt）' });

    let imageBuffer;
    if (req.file) {
      imageBuffer = await uploadableImage(req.file.buffer, req.file.originalname || 'image.png', req.file.mimetype || 'image/png');
    } else if (image_b64) {
      imageBuffer = await uploadableImage(Buffer.from(image_b64, 'base64'));
    } else {
      return res.status(400).json({ error: '缺少参考图（上传文件或 image_b64）' });
    }

    const editPrompt = prompt;
    const b64 = await cctqImageEdit({ images: [imageBuffer], prompt: editPrompt, label: 'refine-edit' });

    res.json({ b64 });
  } catch (err) {
    console.error('[ai-image/edit] 出错：', err);
    sendUpstreamError(res, err, '精修图片失败');
  }
});

module.exports = router;
