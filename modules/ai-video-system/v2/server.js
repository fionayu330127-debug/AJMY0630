const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const PROTOCOL_VERSION = '1';
const DEFAULT_MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;

function isEnabled() {
  return String(process.env.AI_VIDEO_V2_ENABLED || '').toLowerCase() === 'true';
}

function safeName(value) {
  const name = path.basename(String(value || 'upload.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return name || 'upload.bin';
}

function constantTimeTokenMatch(expected, received) {
  if (!expected || !received) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseRange(value, size) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(value || ''));
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

function nowPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function createVideoV2({ query, pool, getSessionUser, isAdmin }) {
  const router = express.Router();
  const dataDir = process.env.VIDEO_DATA_DIR ? path.resolve(process.env.VIDEO_DATA_DIR) : null;
  const fileDir = dataDir ? path.join(dataDir, 'worker-files') : null;
  let reaper = null;

  const jsonError = (res, status, error) => res.status(status).json({ error });

  async function ensureVideoSchema() {
    if (!isEnabled()) return;
    await query(`
      CREATE TABLE IF NOT EXISTS video_assets (
        id TEXT PRIMARY KEY,
        file_id TEXT,
        kind VARCHAR(30) NOT NULL,
        original_name TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS video_clips (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
        start_sec NUMERIC NOT NULL,
        end_sec NUMERIC NOT NULL,
        description TEXT DEFAULT '',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        embedding JSONB,
        impact_score NUMERIC,
        disabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS video_music (
        id TEXT PRIMARY KEY,
        asset_id TEXT REFERENCES video_assets(id) ON DELETE SET NULL,
        duration_sec NUMERIC,
        bpm NUMERIC,
        energy NUMERIC,
        mood_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS video_jobs (
        id TEXT PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'queued',
        params JSONB NOT NULL DEFAULT '{}'::jsonb,
        progress INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result JSONB,
        triggered_by VARCHAR(20) NOT NULL DEFAULT 'user',
        reason TEXT DEFAULT '',
        worker_id TEXT,
        lease_expires_at TIMESTAMP,
        heartbeat_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now(),
        completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS video_outputs (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        script JSONB NOT NULL DEFAULT '[]'::jsonb,
        clip_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        bgm_id TEXT,
        duration_sec NUMERIC,
        size_bytes BIGINT,
        cover_file_id TEXT,
        output_file_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        ai_voice BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS video_workers (
        id TEXT PRIMARY KEY,
        worker_version TEXT DEFAULT '',
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'online',
        last_seen_at TIMESTAMP DEFAULT now(),
        created_at TIMESTAMP DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_video_jobs_claim ON video_jobs(status, type, created_at);
      CREATE INDEX IF NOT EXISTS idx_video_jobs_lease ON video_jobs(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_video_clips_asset ON video_clips(asset_id, disabled);
    `);
  }

  async function recoverExpiredJobs() {
    if (!isEnabled()) return;
    await query(`
      UPDATE video_jobs
      SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
          attempts = attempts + 1,
          error = CASE WHEN attempts + 1 >= max_attempts THEN 'worker lease expired' ELSE error END,
          worker_id = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = now()
      WHERE status IN ('claimed', 'running')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
    `);
  }

  async function startLeaseReaper() {
    if (!isEnabled() || reaper) return;
    await recoverExpiredJobs();
    reaper = setInterval(() => recoverExpiredJobs().catch((error) => console.error('video lease recovery failed', error)), 30000);
    reaper.unref?.();
  }

  function requireWorker(req, res, next) {
    if (!isEnabled()) return jsonError(res, 404, 'not_found');
    if (req.get('X-Protocol-Version') !== PROTOCOL_VERSION) return jsonError(res, 409, 'protocol_mismatch');
    if (!process.env.VIDEO_WORKER_TOKEN) return jsonError(res, 503, 'worker_not_configured');
    const authorization = String(req.get('Authorization') || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!constantTimeTokenMatch(process.env.VIDEO_WORKER_TOKEN, token)) return jsonError(res, 401, 'unauthorized');
    if (!String(req.get('X-Worker-Id') || '').trim()) return jsonError(res, 400, 'worker_id_required');
    req.workerId = String(req.get('X-Worker-Id')).trim().slice(0, 100);
    next();
  }

  async function touchWorker(req) {
    await query(`
      INSERT INTO video_workers (id, worker_version, capabilities, status, last_seen_at)
      VALUES ($1, $2, $3::jsonb, 'online', now())
      ON CONFLICT (id) DO UPDATE SET
        worker_version = EXCLUDED.worker_version,
        capabilities = EXCLUDED.capabilities,
        status = 'online',
        last_seen_at = now()
    `, [req.workerId, String(req.body.worker_version || ''), JSON.stringify(Array.isArray(req.body.capabilities) ? req.body.capabilities : [])]);
  }

  router.use('/video-worker', requireWorker);

  router.post('/video-worker/heartbeat', async (req, res, next) => {
    try {
      await touchWorker(req);
      res.json({ ok: true, server_time: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  router.post('/video-worker/claim', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const types = Array.isArray(req.body.types) ? req.body.types.map(String).slice(0, 20) : [];
      const max = Math.min(10, Math.max(1, Number(req.body.max) || 1));
      await client.query('BEGIN');
      await client.query(`UPDATE video_jobs SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'queued' END, attempts = attempts + 1, worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE status IN ('claimed', 'running') AND lease_expires_at < now()`);
      const { rows } = await client.query(`
        SELECT id, type, params, attempts
        FROM video_jobs
        WHERE status = 'queued' AND ($1::text[] = '{}'::text[] OR type = ANY($1::text[]))
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      `, [types, max]);
      const jobs = [];
      for (const row of rows) {
        const lease = new Date(Date.now() + LEASE_SECONDS * 1000);
        const updated = await client.query(`UPDATE video_jobs SET status = 'claimed', attempts = attempts + 1, worker_id = $1, lease_expires_at = $2, heartbeat_at = now(), updated_at = now() WHERE id = $3 RETURNING id, type, params, attempts, lease_expires_at`, [req.workerId, lease, row.id]);
        jobs.push(updated.rows[0]);
      }
      await client.query('COMMIT');
      res.json({ job: jobs[0] || null, jobs });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  router.post('/video-worker/jobs/:id/progress', async (req, res, next) => {
    try {
      const percent = Math.min(100, Math.max(0, Number(req.body.percent) || 0));
      const result = await query(`UPDATE video_jobs SET status = 'running', progress = $1, error = NULL, heartbeat_at = now(), lease_expires_at = now() + interval '300 seconds', updated_at = now() WHERE id = $2 AND worker_id = $3 AND status IN ('claimed', 'running') RETURNING lease_expires_at`, [percent, req.params.id, req.workerId]);
      if (!result.rows[0]) return jsonError(res, 404, 'job_not_owned');
      res.json({ ok: true, lease_expires_at: result.rows[0].lease_expires_at });
    } catch (error) { next(error); }
  });

  router.get('/video-worker/files/:fileId', async (req, res, next) => {
    try {
      if (!fileDir) return jsonError(res, 503, 'worker_data_not_configured');
      const file = path.basename(req.params.fileId);
      const target = path.join(fileDir, file);
      const stat = await fsp.stat(target);
      const range = parseRange(req.get('Range'), stat.size);
      if (!range) {
        res.setHeader('Content-Length', stat.size);
        return fs.createReadStream(target).pipe(res);
      }
      res.status(206).set({ 'Accept-Ranges': 'bytes', 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` });
      fs.createReadStream(target, { start: range.start, end: range.end }).pipe(res);
    } catch (error) { if (error.code === 'ENOENT') return jsonError(res, 404, 'file_not_found'); next(error); }
  });

  router.put('/video-worker/jobs/:id/upload', async (req, res, next) => {
    try {
      if (!fileDir) return jsonError(res, 503, 'worker_data_not_configured');
      const range = parseContentRange(req.get('Content-Range'));
      if (!range) return jsonError(res, 400, 'content_range_required');
      const name = safeName(req.query.name);
      await fsp.mkdir(fileDir, { recursive: true });
      const target = path.join(fileDir, `${req.params.id}-${name}`);
      const handle = await fsp.open(target, 'a+');
      try {
        const body = await readRequestBody(req);
        if (body.length !== range.end - range.start + 1) return jsonError(res, 400, 'content_range_length_mismatch');
        await handle.write(body, 0, body.length, range.start);
      } finally { await handle.close(); }
      const complete = range.end + 1 >= range.total;
      res.json({ ok: true, complete, ...(complete ? { file_id: path.basename(target) } : {}) });
    } catch (error) { next(error); }
  });

  router.post('/video-worker/jobs/:id/complete', async (req, res, next) => {
    try {
      const result = await query(`SELECT status, result FROM video_jobs WHERE id = $1 AND worker_id = $2`, [req.params.id, req.workerId]);
      if (!result.rows[0]) return jsonError(res, 404, 'job_not_owned');
      if (result.rows[0].status === 'succeeded') return res.json({ ok: true, result: result.rows[0].result });
      const updated = await query(`UPDATE video_jobs SET status = 'succeeded', progress = 100, result = $1::jsonb, error = NULL, lease_expires_at = NULL, heartbeat_at = now(), updated_at = now(), completed_at = now() WHERE id = $2 AND worker_id = $3 AND status IN ('claimed', 'running') RETURNING result`, [JSON.stringify(req.body.result || {}), req.params.id, req.workerId]);
      if (!updated.rows[0]) return jsonError(res, 409, 'job_not_claimable');
      res.json({ ok: true, result: updated.rows[0].result });
    } catch (error) { next(error); }
  });

  router.post('/video-worker/jobs/:id/fail', async (req, res, next) => {
    try {
      const retryable = req.body.retryable !== false;
      const updated = await query(`UPDATE video_jobs SET status = CASE WHEN $1 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END, error = $2, worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now() WHERE id = $3 AND worker_id = $4 AND status IN ('claimed', 'running') RETURNING status`, [retryable, String(req.body.error || 'worker reported failure').slice(0, 2000), req.params.id, req.workerId]);
      if (!updated.rows[0]) return jsonError(res, 404, 'job_not_owned');
      res.json({ ok: true, status: updated.rows[0].status });
    } catch (error) { next(error); }
  });

  router.use(async (req, res, next) => {
    if (!isEnabled()) return jsonError(res, 404, 'not_found');
    const user = await getSessionUser(req);
    if (!user || !isAdmin(user)) return jsonError(res, 403, 'admin_required');
    next();
  });

  router.post('/video-v2/admin/jobs', async (req, res, next) => {
    try {
      const type = String(req.body.type || 'ping').trim();
      const job = { id: crypto.randomUUID(), type, status: 'queued', params: req.body.params && typeof req.body.params === 'object' ? req.body.params : {}, triggered_by: 'user', reason: String(req.body.reason || 'admin test task').slice(0, 500) };
      const { rows } = await query(`INSERT INTO video_jobs (id, type, params, triggered_by, reason) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`, [job.id, job.type, JSON.stringify(job.params), job.triggered_by, job.reason]);
      res.status(201).json({ job: rows[0] });
    } catch (error) { next(error); }
  });

  router.get('/video-v2/admin/jobs', async (req, res, next) => {
    try {
      const { rows } = await query('SELECT * FROM video_jobs ORDER BY created_at DESC, id DESC LIMIT 100');
      res.json({ jobs: rows });
    } catch (error) { next(error); }
  });

  router.get('/video-v2/admin/workers', async (req, res, next) => {
    try {
      const { rows } = await query(`SELECT *, CASE WHEN last_seen_at > now() - interval '90 seconds' THEN 'online' ELSE 'offline' END AS live_status FROM video_workers ORDER BY last_seen_at DESC`);
      res.json({ workers: rows });
    } catch (error) { next(error); }
  });

  router.ensureVideoSchema = ensureVideoSchema;
  router.startLeaseReaper = startLeaseReaper;
  return router;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { createVideoV2 };
