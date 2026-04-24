use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::{Cluster, ClusterCreateInput, PhaseEvent, Store};

#[tauri::command]
pub fn cluster_list(store: State<'_, Store>) -> Result<Vec<Cluster>, AppError> {
    store.list_clusters()
}

#[tauri::command]
pub fn cluster_get(store: State<'_, Store>, id: String) -> Result<Cluster, AppError> {
    store.get_cluster(&id)
}

/// Creates a draft cluster record (no AWS/Terraform interaction)
#[tauri::command]
pub fn cluster_create(
    store: State<'_, Store>,
    input: ClusterCreateInput,
) -> Result<Cluster, AppError> {
    let id = Uuid::new_v4().to_string();
    tracing::info!("creating cluster id={id} name={}", input.name);
    store.insert_cluster(&input, &id)
}

/// Removes the SQLite row — does NOT destroy AWS resources
#[tauri::command]
pub fn cluster_delete_metadata(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    tracing::info!("deleting cluster metadata id={id}");
    store.delete_cluster(&id)
}

#[tauri::command]
pub fn cluster_phase_events(
    store: State<'_, Store>,
    cluster_id: String,
) -> Result<Vec<PhaseEvent>, AppError> {
    store.list_phase_events_for_cluster(&cluster_id)
}
