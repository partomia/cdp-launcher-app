mod commands;
mod error;
mod state;

use commands::{aws, cluster, keychain};
use state::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let store = Store::open().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(store)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
