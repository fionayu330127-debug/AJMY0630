const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-agent-smoke-'));
const port = 18787;
const env = {
  ...process.env,
  TK_CREATOR_DATA_DIR: dataDir,
  TK_AGENT_AUTORUN: 'false',
  TK_INVITE_EXECUTE: '0',
  HOST: '127.0.0.1',
  PORT: String(port),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${body.error || response.statusText}`);
  return body;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request('/api/shops');
      return;
    } catch (_) {
      await sleep(100);
    }
  }
  throw new Error('服务未能在 4 秒内启动');
}

async function main() {
  const child = spawn(process.execPath, ['start.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    await waitForServer();
    const shops = await request('/api/shops');
    if (!Array.isArray(shops) || !shops.length) throw new Error('没有初始化店铺');

    const settings = await request('/api/agent/settings');
    if (!Number.isFinite(Number(settings.invite_daily_limit))) throw new Error('Agent 配置读取失败');

    await request('/api/agent/workflow');
    const workflows = await request('/api/agent/workflows');
    if (!workflows.workflows?.length) throw new Error('没有初始化工作流');
    const workflowId = workflows.workflows[0].id;

    const preview = await request(`/api/agent/workflows/${workflowId}/preview`);
    if (!Array.isArray(preview.stages) || !Array.isArray(preview.blockers)) throw new Error('工作流预检结果不完整');

    const queue = await request(`/api/agent/workflows/${workflowId}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    if (queue.success !== true || !Array.isArray(queue.tasks)) throw new Error('工作流队列生成失败');
    const overview = await request('/api/agent/overview');
    if (!Array.isArray(overview.flows) || overview.flows.length !== 4) throw new Error('Agent任务流状态不完整');
    const trial = await request('/api/agent/flows/auto_invite/trial', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (trial.mode !== 'trial' || !String(trial.summary?.result || '').includes('未创建任务')) throw new Error('试运行触发了非预期动作');
    console.log(`agent smoke passed: shops=${shops.length}, workflow=${workflowId}, tasks=${queue.tasks.length}, flows=${overview.flows.length}`);
  } finally {
    child.kill();
    await sleep(100);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0) process.stderr.write(logs);
  }
}

main().catch((error) => {
  console.error(`agent smoke failed: ${error.message}`);
  process.exitCode = 1;
});
