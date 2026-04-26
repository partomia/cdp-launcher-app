use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AppError;

pub fn app_data_dir() -> Result<std::path::PathBuf, AppError> {
    dirs::data_dir()
        .ok_or_else(|| AppError::Other("cannot determine data directory".into()))
        .map(|d| d.join("com.partomia.cdp-launcher"))
}

// ---------------------------------------------------------------------------
// Embedded migrations
// ---------------------------------------------------------------------------

mod embedded {
    refinery::embed_migrations!("migrations");
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cluster {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub aws_profile: String,
    pub aws_region: String,
    pub state: String,
    pub created_at: String,
    pub destroyed_at: Option<String>,
    pub tfvars_json: Option<String>,
    pub metadata_json: Option<String>,
    /// "aws" | "gcp" | "azure" | "onprem"
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseEvent {
    pub id: i64,
    pub cluster_id: String,
    pub phase: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterTemplate {
    pub id: String,
    pub cluster_id: String,
    pub label: String,
    pub cm_cluster_name: String,
    pub captured_at: String,
    /// Comma-separated service types, e.g. "HDFS,YARN,HIVE,RANGER"
    pub services: String,
    pub template_json: String,
}

#[derive(Debug, Deserialize)]
pub struct ClusterCreateInput {
    pub name: String,
    pub repo_path: String,
    pub aws_profile: String,
    pub aws_region: String,
    pub tfvars_json: Option<String>,
    /// "aws" | "gcp" | "azure" | "onprem" — defaults to "aws"
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String { "aws".to_string() }

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open() -> Result<Self, AppError> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| AppError::Other("cannot determine data directory".into()))?
            .join("com.partomia.cdp-launcher");

        std::fs::create_dir_all(&data_dir)?;

        let db_path = data_dir.join("launcher.db");
        tracing::info!("opening database at {}", db_path.display());

        let mut conn = Connection::open(&db_path)?;

        // Enable WAL mode and foreign keys
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
        )?;

        // Run migrations
        embedded::migrations::runner()
            .run(&mut conn)
            .map_err(|e| AppError::Migration(e.to_string()))?;

        tracing::info!("database ready");
        Ok(Self { conn: Mutex::new(conn) })
    }

    // -----------------------------------------------------------------------
    // Cluster queries
    // -----------------------------------------------------------------------

    pub fn list_clusters(&self) -> Result<Vec<Cluster>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, repo_path, aws_profile, aws_region, state,
                    created_at, destroyed_at, tfvars_json, metadata_json, provider
             FROM clusters ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Cluster {
                id: row.get(0)?,
                name: row.get(1)?,
                repo_path: row.get(2)?,
                aws_profile: row.get(3)?,
                aws_region: row.get(4)?,
                state: row.get(5)?,
                created_at: row.get(6)?,
                destroyed_at: row.get(7)?,
                tfvars_json: row.get(8)?,
                metadata_json: row.get(9)?,
                provider: row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "aws".into()),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Database)
    }

    pub fn get_cluster(&self, id: &str) -> Result<Cluster, AppError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, repo_path, aws_profile, aws_region, state,
                    created_at, destroyed_at, tfvars_json, metadata_json, provider
             FROM clusters WHERE id = ?1",
            params![id],
            |row| Ok(Cluster {
                id: row.get(0)?,
                name: row.get(1)?,
                repo_path: row.get(2)?,
                aws_profile: row.get(3)?,
                aws_region: row.get(4)?,
                state: row.get(5)?,
                created_at: row.get(6)?,
                destroyed_at: row.get(7)?,
                tfvars_json: row.get(8)?,
                metadata_json: row.get(9)?,
                provider: row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "aws".into()),
            }),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("cluster {id}")),
            other => AppError::Database(other),
        })
    }

    pub fn insert_cluster(&self, input: &ClusterCreateInput, id: &str) -> Result<Cluster, AppError> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clusters (id, name, repo_path, aws_profile, aws_region,
                                   state, created_at, tfvars_json, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8)",
            params![
                id,
                input.name,
                input.repo_path,
                input.aws_profile,
                input.aws_region,
                now,
                input.tfvars_json,
                input.provider,
            ],
        )?;
        Ok(Cluster {
            id: id.to_string(),
            name: input.name.clone(),
            repo_path: input.repo_path.clone(),
            aws_profile: input.aws_profile.clone(),
            aws_region: input.aws_region.clone(),
            state: "draft".to_string(),
            created_at: now,
            destroyed_at: None,
            tfvars_json: input.tfvars_json.clone(),
            metadata_json: None,
            provider: input.provider.clone(),
        })
    }

    pub fn update_cluster_state(&self, id: &str, state: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE clusters SET state = ?1 WHERE id = ?2",
            params![state, id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("cluster {id}")));
        }
        Ok(())
    }

    pub fn delete_cluster(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM clusters WHERE id = ?1", params![id])?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Phase event queries
    // -----------------------------------------------------------------------

    pub fn update_cluster_destroyed(&self, id: &str, destroyed_at: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE clusters SET state='destroyed', destroyed_at=?1 WHERE id=?2",
            params![destroyed_at, id],
        )?;
        Ok(())
    }

    /// Insert a phase_event row with status="running" and return its rowid.
    pub fn start_phase_event(
        &self,
        cluster_id: &str,
        phase: &str,
        started_at: &str,
    ) -> Result<i64, AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO phase_events (cluster_id, phase, status, started_at)
             VALUES (?1, ?2, 'running', ?3)",
            params![cluster_id, phase, started_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Update a phase_event row when the subprocess finishes.
    pub fn finish_phase_event(
        &self,
        event_id: i64,
        status: &str,
        finished_at: &str,
        exit_code: i32,
        error_summary: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE phase_events
             SET status=?1, finished_at=?2, exit_code=?3, error_summary=?4
             WHERE id=?5",
            params![status, finished_at, exit_code, error_summary, event_id],
        )?;
        Ok(())
    }

    /// On app startup: mark any phase_event with status='running' that
    /// started more than 5 minutes ago as 'interrupted' (stale from a crash).
    pub fn mark_stale_phases(&self) -> Result<u64, AppError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE phase_events SET status='interrupted', finished_at=datetime('now')
             WHERE status='running'
               AND started_at < datetime('now', '-5 minutes')",
            [],
        )?;
        Ok(n as u64)
    }

    pub fn update_cluster_tfvars_json(&self, id: &str, tfvars_json: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE clusters SET tfvars_json = ?1 WHERE id = ?2",
            params![tfvars_json, id],
        )?;
        Ok(())
    }

    pub fn update_cluster_metadata(&self, id: &str, metadata_json: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE clusters SET metadata_json = ?1 WHERE id = ?2",
            params![metadata_json, id],
        )?;
        Ok(())
    }

    pub fn delete_all_clusters(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM clusters", [])?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Settings queries
    // -----------------------------------------------------------------------

    #[allow(dead_code)]
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e)),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn list_settings(&self) -> Result<std::collections::HashMap<String, String>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(AppError::Database)?;
            map.insert(k, v);
        }
        Ok(map)
    }

    /// Returns true if the most-recent event for this phase has status='success'.
    /// Used by the orchestrator to skip already-completed phases on resume.
    pub fn phase_succeeded(&self, cluster_id: &str, phase: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT status FROM phase_events
             WHERE cluster_id=?1 AND phase=?2
             ORDER BY id DESC LIMIT 1",
            params![cluster_id, phase],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(status) => Ok(status == "success"),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(AppError::Database(e)),
        }
    }

    /// Delete all phase_events for a phase so the orchestrator will re-run it on resume.
    pub fn reset_phase(&self, cluster_id: &str, phase: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM phase_events WHERE cluster_id=?1 AND phase=?2",
            params![cluster_id, phase],
        )
        .map_err(AppError::Database)?;
        Ok(())
    }

    pub fn list_phase_events_for_cluster(&self, cluster_id: &str) -> Result<Vec<PhaseEvent>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, phase, status, started_at, finished_at,
                    exit_code, error_summary
             FROM phase_events WHERE cluster_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![cluster_id], |row| {
            Ok(PhaseEvent {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                phase: row.get(2)?,
                status: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                exit_code: row.get(6)?,
                error_summary: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Database)
    }

    // -----------------------------------------------------------------------
    // Cluster templates
    // -----------------------------------------------------------------------

    pub fn insert_cluster_template(
        &self,
        id: &str,
        cluster_id: &str,
        label: &str,
        cm_cluster_name: &str,
        captured_at: &str,
        services: &str,
        template_json: &str,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cluster_templates
             (id, cluster_id, label, cm_cluster_name, captured_at, services, template_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, cluster_id, label, cm_cluster_name, captured_at, services, template_json],
        )
        .map_err(AppError::Database)?;
        Ok(())
    }

    pub fn list_cluster_templates(&self, cluster_id: &str) -> Result<Vec<ClusterTemplate>, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, label, cm_cluster_name, captured_at, services, template_json
             FROM cluster_templates WHERE cluster_id = ?1 ORDER BY captured_at DESC",
        )?;
        let rows = stmt.query_map(params![cluster_id], |row| {
            Ok(ClusterTemplate {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                label: row.get(2)?,
                cm_cluster_name: row.get(3)?,
                captured_at: row.get(4)?,
                services: row.get(5)?,
                template_json: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Database)
    }

    pub fn get_cluster_template(&self, id: &str) -> Result<ClusterTemplate, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, label, cm_cluster_name, captured_at, services, template_json
             FROM cluster_templates WHERE id = ?1",
        )?;
        stmt.query_row(params![id], |row| {
            Ok(ClusterTemplate {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                label: row.get(2)?,
                cm_cluster_name: row.get(3)?,
                captured_at: row.get(4)?,
                services: row.get(5)?,
                template_json: row.get(6)?,
            })
        })
        .map_err(|_| AppError::NotFound(format!("template {id}")))
    }

    pub fn delete_cluster_template(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM cluster_templates WHERE id = ?1", params![id])
            .map_err(AppError::Database)?;
        Ok(())
    }

    pub fn update_cluster_template_label(&self, id: &str, label: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE cluster_templates SET label = ?1 WHERE id = ?2",
            params![label, id],
        )
        .map_err(AppError::Database)?;
        Ok(())
    }
}
