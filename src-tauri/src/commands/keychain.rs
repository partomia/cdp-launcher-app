use crate::error::AppError;

const SERVICE: &str = "com.partomia.cdp-launcher";

// Known secret keys — document here so callers can use these constants
pub const CM_ADMIN_PASSWORD: &str = "CM_ADMIN_PASSWORD";
pub const DS_PASSWORD: &str = "DS_PASSWORD";
pub const ADM_PASSWORD: &str = "ADM_PASSWORD";
pub const DB_ROOT_PASSWORD: &str = "DB_ROOT_PASSWORD";
pub const PAYWALL_USER: &str = "PAYWALL_USER";
pub const PAYWALL_PASS: &str = "PAYWALL_PASS";

const ALL_KEYS: &[&str] = &[
    CM_ADMIN_PASSWORD,
    DS_PASSWORD,
    ADM_PASSWORD,
    DB_ROOT_PASSWORD,
    PAYWALL_USER,
    PAYWALL_PASS,
];

fn entry_name(cluster_id: &str, key: &str) -> String {
    format!("{cluster_id}:{key}")
}

fn make_entry(cluster_id: &str, key: &str) -> Result<keyring::Entry, AppError> {
    let name = entry_name(cluster_id, key);
    keyring::Entry::new(SERVICE, &name)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn keychain_set(cluster_id: String, key: String, value: String) -> Result<(), AppError> {
    let entry = make_entry(&cluster_id, &key)?;
    entry
        .set_password(&value)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn keychain_get(cluster_id: String, key: String) -> Result<String, AppError> {
    let entry = make_entry(&cluster_id, &key)?;
    entry
        .get_password()
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn keychain_delete(cluster_id: String, key: String) -> Result<(), AppError> {
    let entry = make_entry(&cluster_id, &key)?;
    entry
        .delete_password()
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn keychain_delete_all_for_cluster(cluster_id: String) -> Result<(), AppError> {
    for key in ALL_KEYS {
        if let Ok(entry) = make_entry(&cluster_id, key) {
            let _ = entry.delete_password(); // ignore "not found" errors
        }
    }
    Ok(())
}
