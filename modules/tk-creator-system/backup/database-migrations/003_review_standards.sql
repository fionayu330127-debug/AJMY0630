-- SQLite migration record for modules/tk-creator-system.
CREATE TABLE IF NOT EXISTS review_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  sample_pass_line REAL NOT NULL DEFAULT 70,
  invite_pass_line REAL NOT NULL DEFAULT 70,
  orders_base REAL NOT NULL DEFAULT 1000,
  views_base REAL NOT NULL DEFAULT 5000,
  conversion_base REAL NOT NULL DEFAULT 10,
  orders_weight REAL NOT NULL DEFAULT 30,
  views_weight REAL NOT NULL DEFAULT 30,
  conversion_weight REAL NOT NULL DEFAULT 30,
  fans_hard_limit REAL NOT NULL DEFAULT 1000,
  fans_score_1000 REAL NOT NULL DEFAULT 3,
  fans_score_5000 REAL NOT NULL DEFAULT 5,
  fans_score_50000 REAL NOT NULL DEFAULT 8,
  fans_score_200000 REAL NOT NULL DEFAULT 10,
  missing_data_action TEXT NOT NULL DEFAULT '疑',
  zero_video_action TEXT NOT NULL DEFAULT '第三项计0分，其余照常',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Existing task columns are added idempotently by server.js because SQLite has
-- no portable ADD COLUMN IF NOT EXISTS syntax across supported versions.
