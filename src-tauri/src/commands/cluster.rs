use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;
use uuid::Uuid;
use serde::Serialize;

use crate::error::AppError;
use crate::state::{Cluster, ClusterCreateInput, PhaseEvent, Store};

#[derive(Debug, Serialize)]
pub struct RepoPathValidation {
    pub ok: bool,
    pub message: String,
}

fn validate_installer_repo_path(path: &str) -> Result<PathBuf, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("installer repo path is required".into()));
    }

    let repo_path = PathBuf::from(trimmed);
    if !repo_path.is_absolute() {
        return Err(AppError::Other(format!(
            "installer repo path must be absolute: {trimmed}"
        )));
    }
    if !repo_path.exists() {
        return Err(AppError::Other(format!(
            "installer repo path does not exist: {trimmed}"
        )));
    }
    if !repo_path.is_dir() {
        return Err(AppError::Other(format!(
            "installer repo path is not a directory: {trimmed}"
        )));
    }

    let required_paths = [
        ("Makefile", repo_path.join("Makefile")),
        ("terraform/", repo_path.join("terraform")),
        ("ansible/", repo_path.join("ansible")),
        ("ansible/ansible.cfg", repo_path.join("ansible").join("ansible.cfg")),
    ];

    for (label, p) in required_paths {
        if !Path::new(&p).exists() {
            return Err(AppError::Other(format!(
                "installer repo path is missing {label}: {}",
                p.display()
            )));
        }
    }

    Ok(repo_path)
}

#[tauri::command]
pub fn cluster_list(store: State<'_, Arc<Store>>) -> Result<Vec<Cluster>, AppError> {
    store.list_clusters()
}

#[tauri::command]
pub fn cluster_get(store: State<'_, Arc<Store>>, id: String) -> Result<Cluster, AppError> {
    store.get_cluster(&id)
}

/// Creates a draft cluster record (no AWS/Terraform interaction)
#[tauri::command]
pub fn cluster_create(
    store: State<'_, Arc<Store>>,
    input: ClusterCreateInput,
) -> Result<Cluster, AppError> {
    validate_installer_repo_path(&input.repo_path)?;
    let id = Uuid::new_v4().to_string();
    tracing::info!("creating cluster id={id} name={}", input.name);
    store.insert_cluster(&input, &id)
}

#[tauri::command]
pub fn cluster_validate_repo_path(path: String) -> Result<RepoPathValidation, AppError> {
    match validate_installer_repo_path(&path) {
        Ok(repo_path) => Ok(RepoPathValidation {
            ok: true,
            message: format!("Installer repo looks valid: {}", repo_path.display()),
        }),
        Err(e) => Ok(RepoPathValidation {
            ok: false,
            message: e.to_string(),
        }),
    }
}

#[tauri::command]
pub fn cluster_update_repo_path(
    store: State<'_, Arc<Store>>,
    id: String,
    repo_path: String,
) -> Result<Cluster, AppError> {
    let repo_path = validate_installer_repo_path(&repo_path)?;
    let repo_path = repo_path.to_string_lossy().into_owned();
    store.update_cluster_repo_path(&id, &repo_path)?;
    store.get_cluster(&id)
}

/// Removes the SQLite row — does NOT destroy AWS resources
#[tauri::command]
pub fn cluster_delete_metadata(store: State<'_, Arc<Store>>, id: String) -> Result<(), AppError> {
    tracing::info!("deleting cluster metadata id={id}");
    store.delete_cluster(&id)
}

#[tauri::command]
pub fn cluster_phase_events(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<Vec<PhaseEvent>, AppError> {
    store.list_phase_events_for_cluster(&cluster_id)
}
