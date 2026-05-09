CREATE TABLE IF NOT EXISTS admin_tokens (
    id TEXT PRIMARY KEY,
    admin_email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_type TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_tokens_email ON admin_tokens(admin_email);
CREATE INDEX IF NOT EXISTS idx_admin_tokens_token_hash ON admin_tokens(token_hash);
