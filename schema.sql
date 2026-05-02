CREATE TABLE verify_attempts (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    temp_image_id TEXT,

    nim TEXT,
    nama TEXT,
    study_program TEXT,
    ut_region TEXT,
    class_of TEXT,
    myut_url TEXT,

    ektm_image_url TEXT,

    created_at TEXT DEFAULT (datetime('now')),
    verified_at TEXT,

    CONSTRAINT valid_status CHECK (status IN ('processing', 'approved', 'failed', 'expired'))
);

CREATE INDEX idx_attempts_discord_id ON verify_attempts(discord_id);
CREATE UNIQUE INDEX idx_attempts_nim_approved ON verify_attempts(nim) WHERE status = 'approved';

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,

    CONSTRAINT valid_session_status CHECK (status IN ('active', 'used', 'expired'))
);

CREATE INDEX idx_sessions_discord_id ON sessions(discord_id);

CREATE TABLE admins (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    invited_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Default admin: krismyid@gmail.com
-- Note: password_hash is NULL initially. Set password after deployment:
--   1. GET /admin/hash-password?pwd=YourPassword to generate hash
--   2. UPDATE admins SET password_hash = '<generated_hash>' WHERE email = 'krismyid@gmail.com'
INSERT INTO admins (id, email) VALUES ('default', 'krismyid@gmail.com');
