mod commands;
mod error;
mod orchestrator;
mod runner;
mod state;

use std::sync::Arc;

use commands::{aws, cluster, install, keychain, license, ui};
use runner::RunnerState;
use state::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let store = Arc::new(Store::open().expect("failed to open database"));
    let runner = Arc::new(RunnerState::new());

    // On startup: mark any phase that was "running" for > 5 min as interrupted.
    // This handles app restarts mid-install.
    match store.mark_stale_phases() {
        Ok(0) => {}
        Ok(n) => tracing::warn!("marked {n} stale phase(s) as interrupted on startup"),
        Err(e) => tracing::error!("failed to mark stale phases: {e}"),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(store)
        .manage(runner)
        .invoke_handler(tauri::generate_handler![
            // Keychain
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            keychain::keychain_delete_all_for_cluster,
            // AWS helpers
            aws::aws_profile_list,
            aws::aws_caller_identity,
            aws::aws_check_key_pair,
            aws::aws_detect_public_ip,
            // Cluster CRUD
            cluster::cluster_list,
            cluster::cluster_get,
            cluster::cluster_create,
            cluster::cluster_delete_metadata,
            cluster::cluster_phase_events,
            // Install / destroy / scale orchestration
            install::install_start,
            install::install_cancel,
            install::destroy_start,
            install::scale_start,
            install::logs_fetch,
            // License
            license::license_info,
            license::license_activate,
            license::license_check,
            // Settings + UI helpers
            ui::settings_get,
            ui::settings_set,
            ui::forget_all_secrets,
            ui::delete_all_clusters,
            ui::cluster_env_vars,
            ui::open_cm_ui,
            ui::open_cm_tunnel,
            ui::open_ssh_terminal,
            ui::run_remediation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
