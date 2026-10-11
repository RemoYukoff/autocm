CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product      TEXT NOT NULL,
  slot_id      INTEGER,
  status       TEXT NOT NULL DEFAULT 'generating',
  goal         TEXT,
  play         TEXT,
  pillar       TEXT,
  angle        TEXT,
  format       TEXT,
  media_kind   TEXT,
  text         TEXT,
  alt_text     TEXT,
  media_json   TEXT,
  brief_json   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  text_hash    TEXT,
  tweet_id     TEXT,
  url          TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  views        INTEGER,
  likes        INTEGER,
  reposts      INTEGER,
  replies      INTEGER,
  quotes       INTEGER,
  bookmarks    INTEGER,
  metrics_at   TEXT
);
CREATE INDEX IF NOT EXISTS posts_product_status ON posts(product, status);
CREATE INDEX IF NOT EXISTS posts_published_at ON posts(published_at);

CREATE TABLE IF NOT EXISTS slots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product      TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  post_id      INTEGER,
  claimed_at   TEXT,
  format       TEXT,  -- text|image|video asked for from the dashboard; NULL: the marketer picks
  UNIQUE(product, scheduled_at)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id   INTEGER,
  stage     TEXT NOT NULL,
  model     TEXT NOT NULL,
  ms        INTEGER NOT NULL,
  ok        INTEGER NOT NULL,
  error     TEXT,
  cost_usd  REAL,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  product TEXT,
  post_id INTEGER,
  type    TEXT NOT NULL,
  payload TEXT
);

-- X account connected through a logged-in browser profile (data/sessions/<product>/). One per product.
CREATE TABLE IF NOT EXISTS x_accounts (
  product      TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  name         TEXT,
  avatar_path  TEXT,
  connected_at TEXT NOT NULL,
  last_ok_at   TEXT,
  error        TEXT
);
