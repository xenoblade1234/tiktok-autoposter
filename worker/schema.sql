-- status: pending -> scheduled -> processing -> posted | failed ; pending -> rejected
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  file_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration REAL,
  topic TEXT,
  caption TEXT,
  vars TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT,
  privacy_level TEXT,
  disable_comment INTEGER DEFAULT 1,
  disable_duet INTEGER DEFAULT 1,
  disable_stitch INTEGER DEFAULT 1,
  brand_organic INTEGER DEFAULT 0,
  brand_content INTEGER DEFAULT 0,
  scheduled_at INTEGER,
  publish_id TEXT,
  post_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS videos_status ON videos(status, scheduled_at);

-- Single row (id = 1): the connected TikTok account, tokens encrypted with APP_SECRET.
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open_id TEXT,
  scope TEXT,
  token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
