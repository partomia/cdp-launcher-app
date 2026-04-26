-- Versioned CM cluster template snapshots
-- Each row is one captured export of a running cluster's CM configuration.
-- template_json stores the raw JSON returned by GET /clusters/{name}/export
-- and can be fed directly into POST /cm/importClusterTemplate.

CREATE TABLE IF NOT EXISTS cluster_templates (
    id           TEXT PRIMARY KEY,
    cluster_id   TEXT NOT NULL,
    label        TEXT NOT NULL,
    cm_cluster_name TEXT NOT NULL,
    captured_at  TEXT NOT NULL,
    services     TEXT NOT NULL,   -- comma-separated service types for display
    template_json TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cluster_templates_cluster_id
    ON cluster_templates(cluster_id);
