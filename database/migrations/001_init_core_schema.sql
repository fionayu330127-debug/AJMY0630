-- Agimia ERP core schema
-- PostgreSQL migration: 001_init_core_schema

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  login_name VARCHAR(100) UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(50) DEFAULT 'member',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  platform VARCHAR(50) DEFAULT 'tiktok_shop',
  region VARCHAR(50),
  status VARCHAR(20) DEFAULT 'active',
  external_store_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_credentials (
  id SERIAL PRIMARY KEY,
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  platform VARCHAR(50) DEFAULT 'tiktok_shop',
  api_key TEXT,
  api_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  shop_cipher TEXT,
  expires_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  platform VARCHAR(50) DEFAULT 'tiktok_shop',
  external_product_id VARCHAR(100),
  sku VARCHAR(100),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50),
  image_url TEXT,
  raw_json JSONB,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creators (
  id SERIAL PRIMARY KEY,
  tiktok_uid VARCHAR(100),
  tiktok_handle VARCHAR(100),
  display_name VARCHAR(150),
  profile_url TEXT,
  follower_count INT,
  star_rating SMALLINT DEFAULT 0 CHECK (star_rating BETWEEN 0 AND 5),
  source VARCHAR(50),
  raw_json JSONB,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sample_requests (
  id SERIAL PRIMARY KEY,
  creator_id INT REFERENCES creators(id) ON DELETE SET NULL,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  external_request_id VARCHAR(100),
  applied_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  shipped BOOLEAN DEFAULT false,
  received BOOLEAN DEFAULT false,
  video_posted BOOLEAN DEFAULT false,
  video_url TEXT,
  order_count INT DEFAULT 0,
  raw_json JSONB,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_notes (
  id SERIAL PRIMARY KEY,
  creator_id INT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  bd_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitations (
  id SERIAL PRIMARY KEY,
  creator_id INT REFERENCES creators(id) ON DELETE SET NULL,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  channel VARCHAR(50),
  sent_by VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending',
  message_content TEXT,
  sent_at TIMESTAMP,
  raw_json JSONB,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_messages (
  id SERIAL PRIMARY KEY,
  creator_id INT REFERENCES creators(id) ON DELETE SET NULL,
  direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
  content TEXT,
  matched_intent VARCHAR(50),
  raw_json JSONB,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS affiliate_orders (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  creator_id INT REFERENCES creators(id) ON DELETE SET NULL,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  external_order_id VARCHAR(100),
  order_time TIMESTAMP,
  amount NUMERIC(12, 2),
  currency VARCHAR(20),
  status VARCHAR(50),
  raw_json JSONB,
  synced_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_configs (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50),
  param_key VARCHAR(100),
  param_value TEXT,
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_skills (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50),
  skill_name VARCHAR(100),
  skill_content TEXT,
  version INT DEFAULT 1,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50),
  action VARCHAR(100),
  input TEXT,
  output TEXT,
  status VARCHAR(20),
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_webhooks (
  id SERIAL PRIMARY KEY,
  purpose VARCHAR(50),
  webhook_url TEXT,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  source VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  message TEXT,
  detail JSONB,
  created_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name
  ON users(name);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_platform_external
  ON stores(platform, external_store_id)
  WHERE external_store_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_credentials_store_platform
  ON store_credentials(store_id, platform);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_store_external
  ON products(store_id, external_product_id)
  WHERE external_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_store_sku
  ON products(store_id, sku);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_tiktok_uid
  ON creators(tiktok_uid)
  WHERE tiktok_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creators_handle
  ON creators(tiktok_handle);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sample_requests_external
  ON sample_requests(store_id, external_request_id)
  WHERE external_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sample_requests_unique
  ON sample_requests(creator_id, store_id, product_id)
  WHERE creator_id IS NOT NULL AND store_id IS NOT NULL AND product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sample_requests_status
  ON sample_requests(status);

CREATE INDEX IF NOT EXISTS idx_creator_notes_creator
  ON creator_notes(creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitations_creator_store
  ON invitations(creator_id, store_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_messages_creator
  ON creator_messages(creator_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_orders_external
  ON affiliate_orders(store_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_affiliate_orders_creator
  ON affiliate_orders(creator_id, order_time DESC);

CREATE INDEX IF NOT EXISTS idx_sync_logs_store
  ON sync_logs(store_id, created_at DESC);

COMMIT;
