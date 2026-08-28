const fs = require('node:fs');
const path = require('node:path');
const { importResponse } = require('../db');

const file = process.argv[2];
const rankingType = process.argv[3] || 'overall';
if (!file) throw new Error('用法: node scripts/import-response.js <响应JSON路径> [overall|video|new]');
const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
console.log(importResponse(payload, { rankingType, source: `local-file:${path.basename(file)}` }));
