CREATE TABLE IF NOT EXISTS major_tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    discord_role_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS major_tag_members (
    tag_id TEXT NOT NULL REFERENCES major_tags(id) ON DELETE CASCADE,
    study_program TEXT NOT NULL,
    PRIMARY KEY (tag_id, study_program)
);

CREATE INDEX IF NOT EXISTS idx_tag_members_study_program ON major_tag_members(study_program);
