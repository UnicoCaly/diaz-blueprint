CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'callback',  -- callback | handbook | pro
  name TEXT,
  phone TEXT,
  email TEXT,
  company TEXT,        -- pro lane: contractor / investor company
  address TEXT,
  verdict TEXT,
  goal TEXT,            -- qualification: family | rental | office | value | legacy
  owner TEXT,           -- qualification: own | helping | looking
  timeline TEXT,        -- qualification: now | year | exploring
  source TEXT,          -- utm / referrer captured on the landing page (attribution)
  user_agent TEXT
);
