use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::AppError;
use crate::state::Store;

const KEY_ENABLED: &str = "managed_repo_sync_enabled";
const KEY_URL: &str = "managed_repo_url";
const KEY_BRANCH: &str = "managed_repo_branch";
const KEY_PATH: &str = "managed_repo_local_path";
const KEY_LAST_STATUS: &str = "managed_repo_last_sync_status";
const KEY_LAST_MESSAGE: &str = "managed_repo_last_sync_message";
const KEY_LAST_AT: &str = "managed_repo_last_sync_at";
const KEY_HEAD: &str = "managed_repo_last_head";

#[derive(Debug, Clone, serde::Serialize)]
pub struct RepoSyncStatus {
    pub enabled: bool,
    pub url: String,
    pub branch: String,
    pub local_path: String,
    pub last_status: String,
    pub last_message: String,
    pub last_synced_at: String,
    pub head: String,
}

fn setting(store: &Store, key: &str) -> Result<String, AppError> {
    Ok(store.get_setting(key)?.unwrap_or_default())
}

fn set_status(
    store: &Store,
    status: &str,
    message: &str,
    head: &str,
) -> Result<(), AppError> {
    store.set_setting(KEY_LAST_STATUS, status)?;
    store.set_setting(KEY_LAST_MESSAGE, message)?;
    store.set_setting(KEY_HEAD, head)?;
    store.set_setting(KEY_LAST_AT, &chrono::Utc::now().to_rfc3339())?;
    Ok(())
}

fn run_git(path: Option<&Path>, args: &[&str]) -> Result<String, AppError> {
    let mut cmd = Command::new("git");
    if let Some(path) = path {
        cmd.current_dir(path);
    }
    let output = cmd.args(args).output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        Err(AppError::Other(format!("git {} failed: {}", args.join(" "), msg)))
    }
}

fn head_commit(path: &Path) -> String {
    run_git(Some(path), &["rev-parse", "HEAD"]).unwrap_or_default()
}

fn ensure_clone(url: &str, branch: &str, local_path: &Path) -> Result<(), AppError> {
    if local_path.join(".git").exists() {
        return Ok(());
    }
    if local_path.exists() && local_path.read_dir()?.next().is_some() {
        return Err(AppError::Other(format!(
            "managed repo path exists but is not a git checkout: {}",
            local_path.display()
        )));
    }
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let target = local_path.to_string_lossy().into_owned();
    run_git(None, &["clone", "--branch", branch, "--single-branch", url, &target])?;
    Ok(())
}

fn sync_checkout(url: &str, branch: &str, local_path: &Path) -> Result<String, AppError> {
    ensure_clone(url, branch, local_path)?;

    let remote_url = run_git(Some(local_path), &["remote", "get-url", "origin"])?;
    if remote_url != url {
        run_git(Some(local_path), &["remote", "set-url", "origin", url])?;
    }

    let status = run_git(Some(local_path), &["status", "--porcelain"])?;
    if !status.is_empty() {
        return Err(AppError::Other(format!(
            "managed repo checkout has local changes; sync skipped for {}",
            local_path.display()
        )));
    }

    run_git(Some(local_path), &["fetch", "origin", branch])?;
    run_git(Some(local_path), &["checkout", branch])?;
    run_git(Some(local_path), &["pull", "--ff-only", "origin", branch])?;
    Ok(head_commit(local_path))
}

pub fn sync_managed_repo(store: &Store) -> Result<RepoSyncStatus, AppError> {
    let enabled = setting(store, KEY_ENABLED)? == "true";
    let url = setting(store, KEY_URL)?;
    let branch = {
        let value = setting(store, KEY_BRANCH)?;
        if value.is_empty() { "main".to_string() } else { value }
    };
    let local_path = {
        let value = setting(store, KEY_PATH)?;
        if !value.is_empty() {
            value
        } else {
            setting(store, "default_repo_path")?
        }
    };

    if !enabled {
        let status = RepoSyncStatus {
            enabled,
            url,
            branch,
            local_path,
            last_status: setting(store, KEY_LAST_STATUS)?,
            last_message: setting(store, KEY_LAST_MESSAGE)?,
            last_synced_at: setting(store, KEY_LAST_AT)?,
            head: setting(store, KEY_HEAD)?,
        };
        return Ok(status);
    }

    if url.trim().is_empty() || local_path.trim().is_empty() {
        set_status(store, "error", "Managed repo sync is enabled but URL or local path is empty.", "")?;
        return repo_sync_status(store);
    }

    let path = PathBuf::from(local_path.trim());
    match sync_checkout(url.trim(), branch.trim(), &path) {
        Ok(head) => {
            let msg = format!("Synced {} ({}) into {}", url.trim(), branch.trim(), path.display());
            store.set_setting("default_repo_path", &path.to_string_lossy())?;
            set_status(store, "ok", &msg, &head)?;
        }
        Err(e) => {
            let existing_head = if path.join(".git").exists() {
                head_commit(&path)
            } else {
                String::new()
            };
            let msg = format!("Sync failed; using existing local checkout. {}", e);
            set_status(store, "error", &msg, &existing_head)?;
        }
    }

    repo_sync_status(store)
}

pub fn repo_sync_status(store: &Store) -> Result<RepoSyncStatus, AppError> {
    Ok(RepoSyncStatus {
        enabled: setting(store, KEY_ENABLED)? == "true",
        url: setting(store, KEY_URL)?,
        branch: {
            let value = setting(store, KEY_BRANCH)?;
            if value.is_empty() { "main".to_string() } else { value }
        },
        local_path: {
            let value = setting(store, KEY_PATH)?;
            if !value.is_empty() {
                value
            } else {
                setting(store, "default_repo_path")?
            }
        },
        last_status: setting(store, KEY_LAST_STATUS)?,
        last_message: setting(store, KEY_LAST_MESSAGE)?,
        last_synced_at: setting(store, KEY_LAST_AT)?,
        head: setting(store, KEY_HEAD)?,
    })
}
