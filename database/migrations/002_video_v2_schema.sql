BEGIN;

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

COMMIT;
