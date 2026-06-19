-- 搜尋過的屋苑
CREATE TABLE IF NOT EXISTS estates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  bigestcode  TEXT    NOT NULL UNIQUE,
  district    TEXT,
  is_bigest    INTEGER NOT NULL DEFAULT 1,
  is_favourite INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  first_seen   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_synced  TEXT
);

-- 每次搜尋的單位快照
CREATE TABLE IF NOT EXISTS listings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  estate_id     INTEGER NOT NULL REFERENCES estates(id) ON DELETE CASCADE,
  listing_id    TEXT    NOT NULL,
  ref_no        TEXT,
  estate_name   TEXT,
  phase         TEXT,
  building_name TEXT,
  floor         TEXT,
  unit          TEXT,
  bedrooms      INTEGER,
  direction     TEXT,
  size_net      REAL,
  size_gross    REAL,
  price         REAL,
  price_per_ft  REAL,
  building_age  INTEGER,
  detail_url    TEXT,
  thumbnail     TEXT,
  snapshot_date TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(listing_id, snapshot_date)
);

-- 每日屋苑平均呎價快照（用於趨勢圖）
CREATE TABLE IF NOT EXISTS price_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  estate_id     INTEGER NOT NULL REFERENCES estates(id) ON DELETE CASCADE,
  snapshot_date TEXT    NOT NULL,
  avg_price_ft  REAL,
  median_price  REAL,
  min_price     REAL,
  max_price     REAL,
  listing_count INTEGER,
  UNIQUE(estate_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_listings_estate ON listings(estate_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_estate ON price_snapshots(estate_id, snapshot_date DESC);

-- 每個 refNo 的每日價格記錄（用於追蹤個別單位升跌）
CREATE TABLE IF NOT EXISTS listing_price_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no        TEXT    NOT NULL,
  estate_id     INTEGER NOT NULL REFERENCES estates(id) ON DELETE CASCADE,
  price         REAL    NOT NULL,
  price_per_ft  REAL,
  snapshot_date TEXT    NOT NULL,
  UNIQUE(ref_no, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_lph_ref ON listing_price_history(ref_no, snapshot_date DESC);
