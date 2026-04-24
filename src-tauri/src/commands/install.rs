use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::orchestrator::{
    destroy::{run_destroy, DestroyCtx},
    install::{run_install, InstallCtx},
};
use crate::runner::{LogLine, RunnerState};
use crate::state::{app_data_dir, Store};

// ---------------------------------------------------------------------------
// install_start — non-blocking; spawns orchestrator as a tokio task
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn install_start(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    runner: State<'_, Arc<RunnerState>>,
    cluster_id: String,
) -> Result<(), AppError> {
    if runner.is_running(&cluster_id) {
        return Err(AppError::Other(format!(
            "install already in progress for cluster {cluster_id}"
        )));
    }

    let cluster = store.get_cluster(&cluster_id)?;
    let data_dir = app_data_dir()?;
    let log_dir = data_dir.join("logs");

    let ctx = InstallCtx {
        app: app.clone(),
        store: Arc::clone(&*store),
        runner: Arc::clone(&*runner),
        cluster_id,
        repo_path: PathBuf::from(&cluster.repo_path),
        aws_profile: cluster.aws_profile,
        aws_region: cluster.aws_region,
        log_dir,
    };

    tokio::spawn(run_install(ctx));
    Ok(())
}

// ---------------------------------------------------------------------------
// install_cancel — sends SIGTERM to the running subprocess
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn install_cancel(
    runner: State<'_, Arc<RunnerState>>,
    cluster_id: String,
) -> Result<(), AppError> {
    if !runner.cancel(&cluster_id) {
        return Err(AppError::Other(format!(
            "no running install found for cluster {cluster_id}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// destroy_start — non-blocking; spawns destroy orchestrator
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn destroy_start(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    runner: State<'_, Arc<RunnerState>>,
    cluster_id: String,
) -> Result<(), AppError> {
    if runner.is_running(&cluster_id) {
        return Err(AppError::Other(format!(
            "operation already in progress for cluster {cluster_id}"
        )));
    }

    let cluster = store.get_cluster(&cluster_id)?;
    let data_dir = app_data_dir()?;
    let log_dir = data_dir.join("logs");

    let ctx = DestroyCtx {
        app: app.clone(),
        store: Arc::clone(&*store),
        runner: Arc::clone(&*runner),
        cluster_id,
        repo_path: PathBuf::from(&cluster.repo_path),
        aws_profile: cluster.aws_profile,
        aws_region: cluster.aws_region,
        log_dir,
    };

    tokio::spawn(run_destroy(ctx));
    Ok(())
}

// ---------------------------------------------------------------------------
// logs_fetch — reads persisted log file for pagination / initial load
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn logs_fetch(
    cluster_id: String,
    phase: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<LogLine>, AppError> {
    use std::io::BufRead;

    let data_dir = app_data_dir()?;
    let log_path = data_dir.join("logs").join(&cluster_id).join(format!("{phase}.log"));

    if !log_path.exists() {
        return Ok(vec![]);
    }

    let file = std::fs::File::open(&log_path)?;
    let reader = std::io::BufReader::new(file);

    let lines: Vec<LogLine> = reader
        .lines()
        .skip(offset)
        .take(limit)
        .filter_map(|r| r.ok())
        .map(|raw| {
            let mut parts = raw.splitn(2, '\t');
            let timestamp = parts.next().unwrap_or("").to_string();
            let line = parts.next().unwrap_or(&raw).to_string();
            LogLine {
                cluster_id: cluster_id.clone(),
                phase: phase.clone(),
                stream: "pty".to_string(),
                line,
                timestamp,
            }
        })
        .collect();

    Ok(lines)
}
