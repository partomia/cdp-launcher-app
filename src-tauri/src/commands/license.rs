use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::state::Store;

// ---------------------------------------------------------------------------
// HMAC secret
// Change this string before distributing the app. Keep it in sync with
// the same constant in tools/gen_license.py.
// ---------------------------------------------------------------------------
const LICENSE_SECRET: &[u8] = b"cdp-launcher-2026-partomia-f7a3d1b9e5c2-change-me";

// ---------------------------------------------------------------------------
// License payload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseClaims {
    /// Username / email the license was issued to
    pub user: String,
    /// Organisation name
    pub org: String,
    /// Issued-at Unix timestamp
    pub iat: i64,
    /// Expiry Unix timestamp
    pub exp: i64,
}

#[derive(Debug, Serialize)]
pub struct LicenseInfo {
    pub valid: bool,
    pub user: String,
    pub org: String,
    pub issued: String,
    pub expires: String,
    /// Days remaining (negative = already expired)
    pub days_remaining: i64,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Core validation (also used at startup)
// ---------------------------------------------------------------------------

pub fn verify_token(token: &str) -> Result<LicenseClaims, String> {
    let token = token.trim();
    let dot = token.rfind('.').ok_or("invalid license format")?;
    let payload_b64 = &token[..dot];
    let sig_b64 = &token[dot + 1..];

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "invalid license encoding".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "invalid license signature encoding".to_string())?;

    // Verify HMAC-SHA256
    let mut mac = Hmac::<Sha256>::new_from_slice(LICENSE_SECRET)
        .map_err(|e| format!("hmac init failed: {e}"))?;
    mac.update(&payload_bytes);
    mac.verify_slice(&sig_bytes)
        .map_err(|_| "license signature invalid — this license was not issued for CDP Launcher".to_string())?;

    // Decode payload
    let claims: LicenseClaims = serde_json::from_slice(&payload_bytes)
        .map_err(|e| format!("invalid license payload: {e}"))?;

    // Check expiry
    let now = chrono::Utc::now().timestamp();
    if claims.exp < now {
        let expired_on = chrono::DateTime::from_timestamp(claims.exp, 0)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!("license expired on {expired_on}"));
    }

    Ok(claims)
}

fn claims_to_info(claims: &LicenseClaims) -> LicenseInfo {
    let now = chrono::Utc::now().timestamp();
    LicenseInfo {
        valid: true,
        user: claims.user.clone(),
        org: claims.org.clone(),
        issued: chrono::DateTime::from_timestamp(claims.iat, 0)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default(),
        expires: chrono::DateTime::from_timestamp(claims.exp, 0)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default(),
        days_remaining: (claims.exp - now) / 86400,
        error: None,
    }
}

fn invalid_info(error: String) -> LicenseInfo {
    LicenseInfo {
        valid: false,
        user: String::new(),
        org: String::new(),
        issued: String::new(),
        expires: String::new(),
        days_remaining: 0,
        error: Some(error),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Check and return info about the currently stored license.
#[tauri::command]
pub fn license_info(store: State<'_, Arc<Store>>) -> LicenseInfo {
    match store.get_setting("license_token") {
        Ok(Some(token)) => match verify_token(&token) {
            Ok(claims) => claims_to_info(&claims),
            Err(e) => invalid_info(e),
        },
        _ => invalid_info("no license activated".to_string()),
    }
}

/// Validate and store a new license token. Returns error string on failure.
#[tauri::command]
pub fn license_activate(
    store: State<'_, Arc<Store>>,
    token: String,
) -> Result<LicenseInfo, AppError> {
    let claims = verify_token(&token)
        .map_err(AppError::Other)?;
    store.set_setting("license_token", &token)?;
    tracing::info!("license activated for {} ({})", claims.user, claims.org);
    Ok(claims_to_info(&claims))
}

/// Returns true if a valid (non-expired) license is stored.
#[tauri::command]
pub fn license_check(store: State<'_, Arc<Store>>) -> bool {
    match store.get_setting("license_token") {
        Ok(Some(token)) => verify_token(&token).is_ok(),
        _ => false,
    }
}
