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

CREATE TABLE major_tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    discord_role_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE major_tag_members (
    tag_id TEXT NOT NULL REFERENCES major_tags(id) ON DELETE CASCADE,
    study_program TEXT NOT NULL,
    PRIMARY KEY (tag_id, study_program)
);

CREATE INDEX idx_tag_members_study_program ON major_tag_members(study_program);

CREATE TABLE admin_tokens (
    id TEXT PRIMARY KEY,
    admin_email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_type TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_tokens_email ON admin_tokens(admin_email);
CREATE INDEX idx_admin_tokens_token_hash ON admin_tokens(token_hash);
