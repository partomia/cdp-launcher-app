CREATE TABLE IF NOT EXISTS clusters (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    repo_path    TEXT NOT NULL DEFAULT '',
    aws_profile  TEXT NOT NULL DEFAULT '',
    aws_region   TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'draft',
    created_at   TEXT NOT NULL,
    destroyed_at TEXT,
    tfvars_json  TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS phase_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id    TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    phase         TEXT NOT NULL,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    exit_code     INTEGER,
    error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_phase_events_cluster_id ON phase_events(cluster_id);
