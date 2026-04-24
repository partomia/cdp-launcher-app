use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::orchestrator::error_hints;

// ---------------------------------------------------------------------------
// LogLine — emitted per output line, also persisted to disk
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub cluster_id: String,
    pub phase: String,
    /// "pty" — PTY merges stdout+stderr; callers style by content
    pub stream: String,
    pub line: String,
    pub timestamp: String,
}

// ---------------------------------------------------------------------------
// RunnerState — maps cluster_id → running PID for cancel support
// ---------------------------------------------------------------------------

pub struct RunnerState {
    pids: Mutex<HashMap<String, u32>>,
}

impl RunnerState {
    pub fn new() -> Self {
        Self { pids: Mutex::new(HashMap::new()) }
    }

    pub fn register(&self, cluster_id: &str, pid: u32) {
        tracing::info!("registering PID {pid} for cluster {cluster_id}");
        self.pids.lock().unwrap().insert(cluster_id.to_string(), pid);
    }

    pub fn unregister(&self, cluster_id: &str) {
        self.pids.lock().unwrap().remove(cluster_id);
    }

    /// Send SIGTERM to the running process for this cluster.
    /// Returns false if no process is registered.
    pub fn cancel(&self, cluster_id: &str) -> bool {
        if let Some(&pid) = self.pids.lock().unwrap().get(cluster_id) {
            tracing::info!("sending SIGTERM to PID {pid} for cluster {cluster_id}");
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            true
        } else {
            false
        }
    }

    pub fn is_running(&self, cluster_id: &str) -> bool {
        self.pids.lock().unwrap().contains_key(cluster_id)
    }
}

// ---------------------------------------------------------------------------
// CommandRun — parameters for a single subprocess invocation
// ---------------------------------------------------------------------------

pub struct CommandRun {
    pub cluster_id: String,
    pub phase: String,
    pub cwd: PathBuf,
    pub program: String,
    pub args: Vec<String>,
    /// Extra env vars merged on top of the inherited environment
    pub env: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// execute_command — spawn via PTY, stream lines as Tauri events + log file
// ---------------------------------------------------------------------------

pub async fn execute_command(
    app: AppHandle,
    run: CommandRun,
    log_dir: PathBuf,
    runner_state: Arc<RunnerState>,
) -> Result<i32, AppError> {
    let log_path = log_dir
        .join(&run.cluster_id)
        .join(format!("{}.log", run.phase));
    std::fs::create_dir_all(log_path.parent().unwrap())?;

    let result = tokio::task::spawn_blocking(move || -> Result<i32, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 50, cols: 220, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Other(format!("PTY open failed: {e}")))?;

        let mut cmd = CommandBuilder::new(&run.program);
        for arg in &run.args {
            cmd.arg(arg);
        }
        cmd.cwd(&run.cwd);
        // portable-pty only sets the env vars you provide, so we must
        // seed with the current process environment first, then overlay.
        for (k, v) in std::env::vars_os() {
            cmd.env(k, v);
        }
        for (k, v) in &run.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Other(format!("spawn failed: {e}")))?;
        // Slave fd can be closed; master is the reader end.
        drop(pair.slave);

        let pid = child.process_id().unwrap_or(0);
        runner_state.register(&run.cluster_id, pid);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Other(format!("PTY reader failed: {e}")))?;
        let buf_reader = BufReader::new(reader);

        let mut log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;

        for line_result in buf_reader.lines() {
            let raw = match line_result {
                Ok(l) => l,
                // EIO when slave closes after child exit — treat as EOF
                Err(_) => break,
            };
            let line = raw.trim_end_matches('\r').to_string();
            let timestamp = chrono::Utc::now().to_rfc3339();

            // Persist to log file: "{timestamp}\t{line}"
            let _ = writeln!(log_file, "{timestamp}\t{line}");

            let log_line = LogLine {
                cluster_id: run.cluster_id.clone(),
                phase: run.phase.clone(),
                stream: "pty".to_string(),
                line,
                timestamp,
            };
            if let Err(e) = app.emit("log-line", &log_line) {
                tracing::warn!("emit log-line failed: {e}");
            }

            // Check for known error patterns and emit an error-hint event
            if let Some(hint) = error_hints::check_line(&log_line.line) {
                tracing::warn!("error hint matched: {} ({})", hint.name, hint.summary);
                let payload = serde_json::json!({
                    "cluster_id": run.cluster_id,
                    "phase": run.phase,
                    "hint": hint,
                });
                if let Err(e) = app.emit("error-hint", &payload) {
                    tracing::warn!("emit error-hint failed: {e}");
                }
            }
        }

        runner_state.unregister(&run.cluster_id);

        let status = child
            .wait()
            .map_err(|e| AppError::Other(format!("wait failed: {e}")))?;

        Ok(status.exit_code() as i32)
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking join error: {e}")))??;

    Ok(result)
}
