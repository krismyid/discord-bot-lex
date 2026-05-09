CREATE TABLE IF NOT EXISTS blocked_members (
    id TEXT PRIMARY KEY,
    discord_id TEXT,
    nim TEXT,
    reason TEXT,
    blocked_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    blocked_by_email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocked_discord_id ON blocked_members(discord_id);
CREATE INDEX IF NOT EXISTS idx_blocked_nim ON blocked_members(nim);
