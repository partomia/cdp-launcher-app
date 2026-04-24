-- App-wide key-value settings
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL DEFAULT ''
);

-- Seed defaults (only if not already present)
INSERT OR IGNORE INTO app_settings (key, value) VALUES
    ('default_repo_path',   ''),
    ('default_aws_profile', ''),
    ('default_aws_region',  'ap-south-1');
