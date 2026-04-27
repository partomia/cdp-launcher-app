// ---------------------------------------------------------------------------
// Cluster health — fetches host and service health from CM via SSH tunnel
//
// Opens a short-lived SSH tunnel on localhost:17186 → util1:7183, makes
// multiple CM API calls, then kills the tunnel and returns the aggregated
// ClusterHealth struct.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::keychain::keychain_get_inner;
use crate::error::AppError;
use crate::orchestrator::install::run_phase;
use crate::runner::RunnerState;
use crate::state::{app_data_dir, Store};

// ---------------------------------------------------------------------------
// Public types (serialised to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CmHostSummary {
    pub hostname: String,
    pub ip_address: String,
    /// "GOOD" | "CONCERNING" | "BAD" | "DISABLED" | "UNKNOWN" | "NOT_AVAILABLE"
    pub health_summary: String,
    pub num_cores: Option<u64>,
    pub total_phys_mem_bytes: Option<u64>,
    /// Derived from inventory groups: "Util" | "Master" | "Worker" | "Edge" | "IPA" | "Bastion"
    pub node_role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CmServiceSummary {
    pub name: String,
    pub service_type: String,
    pub display_name: Option<String>,
    /// "GOOD" | "CONCERNING" | "BAD" | "DISABLED" | "UNKNOWN" | "HISTORY_NOT_AVAILABLE"
    pub health_summary: String,
    /// "STARTED" | "STOPPED" | "STOPPING" | "STARTING" | "UNKNOWN" | "NA"
    pub service_state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CmKerberosInfo {
    /// true = cluster has been kerberized (make kerberos-cluster ran).
    /// Read from GET /clusters/{name}/kerberosInfo → kerberized.
    pub kerberos_enabled: bool,
    /// true = KDC settings (KDC_TYPE, KDC_HOST, SECURITY_REALM) are in /cm/config.
    /// Set by make kerberos early in its run.
    pub kdc_configured: bool,
    /// true = admin credentials have been imported into CM (importAdminCredentials succeeded).
    /// This is the gate for make kerberos-cluster — read from /cm/kerberosInfo → kerberized.
    pub kerberos_cm_ready: bool,
    pub realm: Option<String>,
    pub kdc_host: Option<String>,
    pub kdc_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterHealth {
    pub cm_cluster_name: String,
    pub cm_version: Option<String>,
    pub hosts: Vec<CmHostSummary>,
    pub services: Vec<CmServiceSummary>,
    pub kerberos: CmKerberosInfo,
    pub ldap_enabled: bool,
    pub ldap_url: Option<String>,
    pub ldap_bind_dn: Option<String>,
    pub auto_tls_enabled: bool,
    pub fetched_at: String,
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cluster_health_fetch(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<ClusterHealth, AppError> {
    let cluster = store.get_cluster(&cluster_id)?;

    let key_name = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v["ssh_key_name"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp732".to_string());

    let bastion_ip = cluster
        .metadata_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            for key in &["bastion_public_ip", "bastion_ip", "bastion_host"] {
                if let Some(ip) = v[key].as_str() {
                    return Some(ip.to_string());
                }
            }
            None
        })
        .ok_or_else(|| {
            AppError::Other("Bastion IP not found in cluster metadata".into())
        })?;

    let util1_ip = util1_private_ip(&cluster.repo_path).ok_or_else(|| {
        AppError::Other("util1 IP not found in inventory".into())
    })?;

    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);

    let cm_password = keychain_get_inner(&cluster_id, "CM_ADMIN_PASSWORD")
        .unwrap_or_else(|_| "admin".to_string());

    // Role map from inventory (hostname → role label)
    let role_map = inventory_role_map(&cluster.repo_path);

    // Open SSH tunnel: localhost:17186 → util1_ip:7183
    // (17186 avoids collision with template_capture on 17183 and open_cm_ui on 7183)
    let tunnel_port: u16 = 17186;

    // Kill any stale process still holding this port from a previous fetch that
    // didn't clean up (e.g. the app was force-quit, or SIGTERM raced with a new call).
    kill_port(tunnel_port);

    let proxy_cmd = format!(
        "/usr/bin/ssh -i {key_path} -W %h:%p -q -o StrictHostKeyChecking=no ec2-user@{bastion_ip}"
    );
    let mut tunnel_child = Command::new("/usr/bin/ssh")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-N",
            // ExitOnForwardFailure=yes causes SSH to exit if it cannot bind the local
            // port (already in use). Remove it here — kill_port above ensures the port
            // is free, and removing the flag prevents the tunnel dying on transient
            // remote-side delays.
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ServerAliveInterval=10",
            "-o", "ServerAliveCountMax=6",
            "-o", &format!("ProxyCommand={proxy_cmd}"),
            "-i", &key_path,
            "-L", &format!("{tunnel_port}:{util1_ip}:7183"),
            &format!("ec2-user@{util1_ip}"),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(AppError::Io)?;

    tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;

    let result = fetch_all(tunnel_port, &cm_password, &role_map);

    // SIGTERM the tunnel and reap it so the port is freed before the next call.
    unsafe { libc::kill(tunnel_child.id() as i32, libc::SIGTERM); }
    let _ = tunnel_child.wait();

    result
}

// ---------------------------------------------------------------------------
// Security setup commands — post-install optional one-click actions
// ---------------------------------------------------------------------------

/// Build the standard ansible/make environment for running security commands.
fn make_env(repo_path: &PathBuf, aws_profile: &str, aws_region: &str) -> HashMap<String, String> {
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let tool_paths = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin";
    let full_path = format!("{tool_paths}:{inherited_path}");

    let ansible_cfg = repo_path.join("ansible").join("ansible.cfg");
    let ansible_inv = repo_path.join("ansible").join("inventory").join("prod.ini");

    let mut env = HashMap::new();
    env.insert("PATH".into(), full_path);
    env.insert("AWS_PROFILE".into(), aws_profile.to_string());
    env.insert("AWS_DEFAULT_REGION".into(), aws_region.to_string());
    env.insert("ANSIBLE_CONFIG".into(), ansible_cfg.to_string_lossy().into_owned());
    env.insert("ANSIBLE_INVENTORY".into(), ansible_inv.to_string_lossy().into_owned());
    env
}

/// Runs a make target (e.g. "kerberos", "kerberos-cluster", "cm-ldap") in the repo,
/// streaming output as log-line events. Emits "security-phase-done" when finished.
async fn run_make_phase(
    app: AppHandle,
    store: Arc<Store>,
    runner: Arc<RunnerState>,
    cluster_id: String,
    phase_key: &'static str,
    make_target: &'static str,
    cluster_repo_path: String,
    aws_profile: String,
    aws_region: String,
) {
    let result = run_make_phase_inner(
        &app, &store, &runner, &cluster_id,
        phase_key, make_target,
        &cluster_repo_path, &aws_profile, &aws_region,
    ).await;

    let (success, error_msg) = match &result {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };

    let _ = app.emit(
        "security-phase-done",
        &serde_json::json!({
            "cluster_id": cluster_id,
            "phase": phase_key,
            "success": success,
            "error": error_msg,
        }),
    );
}

async fn run_make_phase_inner(
    app: &AppHandle,
    store: &Arc<Store>,
    runner: &Arc<RunnerState>,
    cluster_id: &str,
    phase_key: &str,
    make_target: &str,
    cluster_repo_path: &str,
    aws_profile: &str,
    aws_region: &str,
) -> Result<(), AppError> {
    let repo_path = PathBuf::from(cluster_repo_path);
    let env = make_env(&repo_path, aws_profile, aws_region);
    let data_dir = app_data_dir()?;
    let log_dir = data_dir.join("logs");

    let started_at = chrono::Utc::now().to_rfc3339();
    let event_id = store.start_phase_event(cluster_id, phase_key, &started_at)?;

    let exit_code = run_phase(
        app,
        cluster_id,
        runner,
        &log_dir,
        phase_key,
        repo_path,
        "make",
        &[make_target],
        env,
    )
    .await?;

    let finished_at = chrono::Utc::now().to_rfc3339();
    if exit_code == 0 {
        store.finish_phase_event(event_id, "success", &finished_at, exit_code, None)?;
        Ok(())
    } else {
        let summary = format!("make {make_target} exited with code {exit_code}");
        store.finish_phase_event(event_id, "failed", &finished_at, exit_code, Some(&summary))?;
        Err(AppError::Other(summary))
    }
}

/// Configure KDC settings in CM and import admin credentials (runs `make kerberos` / 50-kerberos.yml).
/// Post-install optional step — does NOT kerberize the cluster yet.
#[tauri::command]
pub async fn security_setup_kerberos(
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
    let store_arc = Arc::clone(&*store);
    let runner_arc = Arc::clone(&*runner);
    tokio::spawn(run_make_phase(
        app, store_arc, runner_arc, cluster_id,
        "security_kerberos", "kerberos",
        cluster.repo_path, cluster.aws_profile, cluster.aws_region,
    ));
    Ok(())
}

/// Kerberize the CM cluster (runs `make kerberos-cluster` / 55-cluster-kerberos.yml).
/// Requires KDC already configured via security_setup_kerberos.
#[tauri::command]
pub async fn security_setup_kerberos_cluster(
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
    let store_arc = Arc::clone(&*store);
    let runner_arc = Arc::clone(&*runner);
    tokio::spawn(run_make_phase(
        app, store_arc, runner_arc, cluster_id,
        "security_kerberos_cluster", "kerberos-cluster",
        cluster.repo_path, cluster.aws_profile, cluster.aws_region,
    ));
    Ok(())
}

/// Configure CM external LDAP auth against FreeIPA (runs `make cm-ldap` / 51-cm-ldap.yml).
#[tauri::command]
pub async fn security_setup_ldap(
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
    let store_arc = Arc::clone(&*store);
    let runner_arc = Arc::clone(&*runner);
    tokio::spawn(run_make_phase(
        app, store_arc, runner_arc, cluster_id,
        "security_ldap", "cm-ldap",
        cluster.repo_path, cluster.aws_profile, cluster.aws_region,
    ));
    Ok(())
}

/// Fix missing Kerberos keytabs on a cluster that is already kerberized but
/// whose services are failing because generateCredentials never completed.
/// Runs make kerberos-credentials (52-kerberos-credentials.yml) which:
///   1. Installs the FreeIPA import_credentials.sh wrapper on util
///   2. Runs importAdminCredentials
///   3. Runs generateCredentials
///   4. Restarts stale services via 43-cm-restart-stale.sh
#[tauri::command]
pub async fn security_fix_credentials(
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
    let store_arc = Arc::clone(&*store);
    let runner_arc = Arc::clone(&*runner);
    tokio::spawn(run_make_phase(
        app, store_arc, runner_arc, cluster_id,
        "security_fix_credentials", "kerberos-credentials",
        cluster.repo_path, cluster.aws_profile, cluster.aws_region,
    ));
    Ok(())
}

/// Configure an external KDC in CM via the CM API (no ansible required).
/// Useful when the KDC is an external MIT KDC or Active Directory, not FreeIPA.
#[tauri::command]
pub async fn security_configure_external_kdc(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
    kdc_host: String,
    realm: String,
    kdc_type: String,        // "MIT KDC" | "Active Directory"
    admin_principal: String, // e.g. "admin/admin@REALM" or "Administrator@REALM"
    admin_password: String,
) -> Result<(), AppError> {
    let cluster = store.get_cluster(&cluster_id)?;
    let key_name = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v["ssh_key_name"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp732".to_string());
    let bastion_ip = cluster
        .metadata_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            for key in &["bastion_public_ip", "bastion_ip", "bastion_host"] {
                if let Some(ip) = v[key].as_str() {
                    return Some(ip.to_string());
                }
            }
            None
        })
        .ok_or_else(|| AppError::Other("Bastion IP not found in cluster metadata".into()))?;
    let util1_ip = util1_private_ip(&cluster.repo_path)
        .ok_or_else(|| AppError::Other("util1 IP not found in inventory".into()))?;
    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);
    let cm_password = keychain_get_inner(&cluster_id, "CM_ADMIN_PASSWORD")
        .unwrap_or_else(|_| "admin".to_string());

    let tunnel_port: u16 = 17187;
    kill_port(tunnel_port);
    let proxy_cmd = format!(
        "/usr/bin/ssh -i {key_path} -W %h:%p -q -o StrictHostKeyChecking=no ec2-user@{bastion_ip}"
    );
    let mut tunnel_child = Command::new("/usr/bin/ssh")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-N",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", &format!("ProxyCommand={proxy_cmd}"),
            "-i", &key_path,
            "-L", &format!("{tunnel_port}:{util1_ip}:7183"),
            &format!("ec2-user@{util1_ip}"),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(AppError::Io)?;

    tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;

    let body = serde_json::json!({
        "items": [
            {"name": "KDC_TYPE",      "value": kdc_type},
            {"name": "KDC_HOST",      "value": kdc_host},
            {"name": "SECURITY_REALM","value": realm},
        ]
    })
    .to_string();

    let result = cm_api_put(tunnel_port, "admin", &cm_password, "/cm/config", &body)
        .and_then(|_| {
            // Import KDC admin credentials
            let cred_body = serde_json::json!({
                "principal": admin_principal,
                "password": admin_password,
            })
            .to_string();
            cm_api_post(
                tunnel_port,
                "admin",
                &cm_password,
                "/cm/commands/importAdminCredentials",
                &format!("?username={}&password={}", urlencoding::encode(&admin_principal), urlencoding::encode(&admin_password)),
                &cred_body,
            )
        });

    unsafe { libc::kill(tunnel_child.id() as i32, libc::SIGTERM); }
    let _ = tunnel_child.wait();

    result.map(|_| ())
}

/// Configure CM external LDAP authentication via the CM API directly.
/// Use this for external AD or LDAP servers that are not FreeIPA.
#[tauri::command]
pub async fn security_configure_external_ldap(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
    ldap_url: String,        // e.g. "ldaps://ldap.example.com:636"
    bind_dn: String,         // e.g. "cn=cm-bind,dc=example,dc=com"
    bind_password: String,
    search_base: String,     // e.g. "dc=example,dc=com"
    ldap_type: String,       // "LDAP" | "AD"
) -> Result<(), AppError> {
    let cluster = store.get_cluster(&cluster_id)?;
    let key_name = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v["ssh_key_name"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp732".to_string());
    let bastion_ip = cluster
        .metadata_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            for key in &["bastion_public_ip", "bastion_ip", "bastion_host"] {
                if let Some(ip) = v[key].as_str() {
                    return Some(ip.to_string());
                }
            }
            None
        })
        .ok_or_else(|| AppError::Other("Bastion IP not found in cluster metadata".into()))?;
    let util1_ip = util1_private_ip(&cluster.repo_path)
        .ok_or_else(|| AppError::Other("util1 IP not found in inventory".into()))?;
    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);
    let cm_password = keychain_get_inner(&cluster_id, "CM_ADMIN_PASSWORD")
        .unwrap_or_else(|_| "admin".to_string());

    let (user_filter, group_filter, username_attr) = if ldap_type == "AD" {
        (
            "(&(sAMAccountName={0})(objectClass=user))".to_string(),
            "(&(member={0})(objectClass=group))".to_string(),
            "sAMAccountName".to_string(),
        )
    } else {
        (
            "(&(uid={0})(objectClass=person))".to_string(),
            "(&(member={0})(objectClass=posixgroup)(!(cn=admins)))".to_string(),
            "uid".to_string(),
        )
    };

    let tunnel_port: u16 = 17188;
    kill_port(tunnel_port);
    let proxy_cmd = format!(
        "/usr/bin/ssh -i {key_path} -W %h:%p -q -o StrictHostKeyChecking=no ec2-user@{bastion_ip}"
    );
    let mut tunnel_child = Command::new("/usr/bin/ssh")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-N",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", &format!("ProxyCommand={proxy_cmd}"),
            "-i", &key_path,
            "-L", &format!("{tunnel_port}:{util1_ip}:7183"),
            &format!("ec2-user@{util1_ip}"),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(AppError::Io)?;

    tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;

    let body = serde_json::json!({
        "items": [
            {"name": "AUTH_BACKEND_ORDER",        "value": "db,ldap"},
            {"name": "LDAP_URL",                  "value": ldap_url},
            {"name": "LDAP_BIND_DN",              "value": bind_dn},
            {"name": "LDAP_BIND_PASSWORD",        "value": bind_password},
            {"name": "LDAP_USER_SEARCH_BASE",     "value": search_base.clone()},
            {"name": "LDAP_USER_SEARCH_FILTER",   "value": user_filter},
            {"name": "LDAP_GROUP_SEARCH_BASE",    "value": search_base},
            {"name": "LDAP_GROUP_SEARCH_FILTER",  "value": group_filter},
            {"name": "LDAP_ATTR_USERNAME_MAPPING","value": username_attr},
            {"name": "LDAP_GROUP_SEARCH_ATTR",    "value": "cn"},
            {"name": "LDAP_DN_PATTERN",           "value": ""},
            {"name": "LDAP_TYPE",                 "value": ldap_type},
        ]
    })
    .to_string();

    let result = cm_api_put(tunnel_port, "admin", &cm_password, "/cm/config", &body);

    unsafe { libc::kill(tunnel_child.id() as i32, libc::SIGTERM); }
    let _ = tunnel_child.wait();

    result.map(|_| ())
}

// ---------------------------------------------------------------------------
// Core fetch logic — runs against the open tunnel
// ---------------------------------------------------------------------------

fn fetch_all(
    port: u16,
    cm_pass: &str,
    role_map: &HashMap<String, String>,
) -> Result<ClusterHealth, AppError> {
    let cm_user = "admin";

    // 1. CM version
    let version_val = curl_cm(port, cm_user, cm_pass, "/cm/version").ok();
    let cm_version = version_val
        .as_ref()
        .and_then(|v| v["version"].as_str().map(|s| s.to_string()));

    // 2. Discover cluster name
    let clusters_val = curl_cm(port, cm_user, cm_pass, "/clusters")?;
    let cm_cluster_name = clusters_val["items"][0]["name"]
        .as_str()
        .ok_or_else(|| AppError::Other("No clusters found in CM".into()))?
        .to_string();

    // 3. Services
    let services_path = format!("/clusters/{}/services", urlencoding::encode(&cm_cluster_name));
    let services_val = curl_cm(port, cm_user, cm_pass, &services_path)?;
    let services = parse_services(&services_val);

    // 4. Hosts
    let hosts_val = curl_cm(port, cm_user, cm_pass, "/hosts")?;
    let hosts = parse_hosts(&hosts_val, role_map);

    // 5. CM config — reads KDC settings, LDAP, Auto-TLS in one call
    // KDC_TYPE/KDC_HOST/SECURITY_REALM are written by `make kerberos` even before
    // the cluster is kerberized, so we can show them regardless of kerberosEnabled.
    let (ldap_enabled, ldap_url, ldap_bind_dn, auto_tls_enabled,
         kdc_configured_from_config, realm_from_config, kdc_host_from_config, kdc_type_from_config) =
        curl_cm(port, cm_user, cm_pass, "/cm/config")
            .map(|v| parse_cm_config(&v))
            .unwrap_or((false, None, None, true, false, None, None, None));

    // 6. kerberosInfo — reflects whether cluster is actually kerberized
    let kerberos = curl_cm(port, cm_user, cm_pass, "/cm/kerberosInfo")
        .map(|v| {
            let mut k = parse_kerberos(&v);
            k.kdc_configured = kdc_configured_from_config;
            // Fill in KDC details from /cm/config if kerberosInfo doesn't have them
            if k.realm.is_none() { k.realm = realm_from_config.clone(); }
            if k.kdc_host.is_none() { k.kdc_host = kdc_host_from_config.clone(); }
            if k.kdc_type.is_none() { k.kdc_type = kdc_type_from_config.clone(); }
            k
        })
        .unwrap_or_else(|_| CmKerberosInfo {
            kerberos_enabled: false,
            kdc_configured: kdc_configured_from_config,
            kerberos_cm_ready: false,
            realm: realm_from_config,
            kdc_host: kdc_host_from_config,
            kdc_type: kdc_type_from_config,
        });

    Ok(ClusterHealth {
        cm_cluster_name,
        cm_version,
        hosts,
        services,
        kerberos,
        ldap_enabled,
        ldap_url,
        ldap_bind_dn,
        auto_tls_enabled,
        fetched_at: chrono::Utc::now().to_rfc3339(),
    })
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn parse_services(v: &serde_json::Value) -> Vec<CmServiceSummary> {
    v["items"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|s| CmServiceSummary {
            name: s["name"].as_str().unwrap_or("").to_string(),
            service_type: s["serviceType"].as_str().unwrap_or("").to_string(),
            display_name: s["displayName"].as_str().map(|s| s.to_string()),
            health_summary: s["healthSummary"]
                .as_str()
                .unwrap_or("UNKNOWN")
                .to_string(),
            service_state: s["serviceState"]
                .as_str()
                .unwrap_or("UNKNOWN")
                .to_string(),
        })
        .collect()
}

fn parse_hosts(
    v: &serde_json::Value,
    role_map: &HashMap<String, String>,
) -> Vec<CmHostSummary> {
    let mut hosts: Vec<CmHostSummary> = v["items"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|h| {
            let hostname = h["hostname"].as_str().unwrap_or("").to_string();
            let node_role = role_map.get(&hostname).cloned();
            CmHostSummary {
                hostname: hostname.clone(),
                ip_address: h["ipAddress"].as_str().unwrap_or("").to_string(),
                health_summary: h["healthSummary"]
                    .as_str()
                    .unwrap_or("UNKNOWN")
                    .to_string(),
                num_cores: h["numCores"].as_u64(),
                total_phys_mem_bytes: h["totalPhysMemBytes"].as_u64(),
                node_role,
            }
        })
        .collect();

    // Sort: Util → Master → Edge → IPA → Worker → Bastion → unknown
    let role_order = |r: &Option<String>| match r.as_deref() {
        Some("Util") => 0,
        Some("Master") => 1,
        Some("Edge") => 2,
        Some("IPA") => 3,
        Some("Worker") => 4,
        Some("Bastion") => 5,
        _ => 6,
    };
    hosts.sort_by(|a, b| {
        role_order(&a.node_role)
            .cmp(&role_order(&b.node_role))
            .then(a.hostname.cmp(&b.hostname))
    });
    hosts
}

fn parse_kerberos(v: &serde_json::Value) -> CmKerberosInfo {
    // /cm/kerberosInfo has:
    //   kerberosEnabled  — old field name (some CM builds)
    //   kerberized       — true after importAdminCredentials completes (make kerberos)
    // Both are checked so we handle different CM versions.
    let kerberos_enabled =
        v["kerberosEnabled"].as_bool().unwrap_or(false)
        || v["kerberized"].as_bool().unwrap_or(false);
    // kerberos_cm_ready: true when admin credentials have been imported into CM.
    // The 41-cm-cluster-kerberize.sh script gates on this via /cm/kerberosInfo → .kerberized.
    let kerberos_cm_ready = v["kerberized"].as_bool().unwrap_or(false);
    CmKerberosInfo {
        kerberos_enabled,
        kdc_configured: false,   // filled in by caller from /cm/config
        kerberos_cm_ready,
        realm: v["realm"].as_str().map(|s| s.to_string()),
        kdc_host: v["kdcHost"].as_str().map(|s| s.to_string()),
        kdc_type: v["kdcType"].as_str().map(|s| s.to_string()),
    }
}

/// Parses /cm/config items.
/// Returns: (ldap_enabled, ldap_url, ldap_bind_dn, auto_tls, kerberos_configured, realm, kdc_host, kdc_type)
fn parse_cm_config(
    v: &serde_json::Value,
) -> (bool, Option<String>, Option<String>, bool, bool, Option<String>, Option<String>, Option<String>) {
    let items = v["items"].as_array();
    let mut ldap_url: Option<String> = None;
    let mut ldap_bind_dn: Option<String> = None;
    let mut auth_order: Option<String> = None;
    let mut auto_tls = true;
    // KDC config keys written by make kerberos (40-cm-kerberos-enable.sh)
    let mut kdc_type: Option<String> = None;
    let mut kdc_host: Option<String> = None;
    let mut realm: Option<String> = None;

    if let Some(arr) = items {
        for item in arr {
            let name = item["name"].as_str().unwrap_or("");
            let value = item["value"].as_str().unwrap_or("").to_string();
            if value.is_empty() { continue; }
            match name {
                "LDAP_URL"          => ldap_url    = Some(value),
                "LDAP_BIND_DN"      => ldap_bind_dn = Some(value),
                "AUTH_BACKEND_ORDER"=> auth_order  = Some(value),
                "WEB_TLS" | "AGENT_TLS" => {
                    if value == "false" { auto_tls = false; }
                }
                // Kerberos KDC settings — written by make kerberos even before cluster is kerberized
                "KDC_TYPE"          => kdc_type = Some(value),
                "KDC_HOST"          => kdc_host = Some(value),
                "SECURITY_REALM"    => realm    = Some(value),
                _ => {}
            }
        }
    }

    let ldap_enabled = ldap_url.is_some()
        || auth_order.as_deref().map(|s| s.contains("ldap")).unwrap_or(false);

    // KDC is configured if KDC_TYPE and KDC_HOST are present (set by make kerberos)
    let kerberos_configured = kdc_type.is_some() && kdc_host.is_some();

    (ldap_enabled, ldap_url, ldap_bind_dn, auto_tls, kerberos_configured, realm, kdc_host, kdc_type)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn curl_cm(
    port: u16,
    cm_user: &str,
    cm_pass: &str,
    path: &str,
) -> Result<serde_json::Value, AppError> {
    let url = format!("https://localhost:{port}/api/v54{path}");
    let out = Command::new("/usr/bin/curl")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-sk",
            "-u", &format!("{cm_user}:{cm_pass}"),
            "-H", "Accept: application/json",
            "--connect-timeout", "15",
            "--max-time", "30",
            &url,
        ])
        .output()
        .map_err(AppError::Io)?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(AppError::Other(format!(
            "CM API {path} returned empty response (exit={}, stderr={:?})",
            out.status, stderr
        )));
    }
    serde_json::from_str(&stdout).map_err(|e| {
        AppError::Other(format!(
            "Cannot parse CM response for {path}: {} — first 300 chars: {}",
            e,
            &stdout[..stdout.len().min(300)]
        ))
    })
}

/// PUT to the CM API with a JSON body; returns the parsed response.
fn cm_api_put(
    port: u16,
    cm_user: &str,
    cm_pass: &str,
    path: &str,
    body: &str,
) -> Result<serde_json::Value, AppError> {
    let url = format!("https://localhost:{port}/api/v54{path}");
    let out = Command::new("/usr/bin/curl")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-sk",
            "-X", "PUT",
            "-u", &format!("{cm_user}:{cm_pass}"),
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json",
            "--connect-timeout", "15",
            "--max-time", "30",
            "-d", body,
            &url,
        ])
        .output()
        .map_err(AppError::Io)?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(AppError::Other(format!(
            "CM API PUT {path} returned empty response (exit={}, stderr={:?})",
            out.status, stderr
        )));
    }
    serde_json::from_str(&stdout).map_err(|e| {
        AppError::Other(format!(
            "Cannot parse CM PUT response for {path}: {} — first 300 chars: {}",
            e,
            &stdout[..stdout.len().min(300)]
        ))
    })
}

/// POST to the CM API with optional query string; returns the parsed response.
fn cm_api_post(
    port: u16,
    cm_user: &str,
    cm_pass: &str,
    path: &str,
    query: &str,
    body: &str,
) -> Result<serde_json::Value, AppError> {
    let url = format!("https://localhost:{port}/api/v54{path}{query}");
    let out = Command::new("/usr/bin/curl")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-sk",
            "-X", "POST",
            "-u", &format!("{cm_user}:{cm_pass}"),
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json",
            "--connect-timeout", "15",
            "--max-time", "30",
            "-d", body,
            &url,
        ])
        .output()
        .map_err(AppError::Io)?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(AppError::Other(format!(
            "CM API POST {path} returned empty response (exit={}, stderr={:?})",
            out.status, stderr
        )));
    }
    serde_json::from_str(&stdout).map_err(|e| {
        AppError::Other(format!(
            "Cannot parse CM POST response for {path}: {} — first 300 chars: {}",
            e,
            &stdout[..stdout.len().min(300)]
        ))
    })
}

/// Reads prod.ini and returns hostname → role-label map.
fn inventory_role_map(repo_path: &str) -> HashMap<String, String> {
    let inv = PathBuf::from(repo_path)
        .join("ansible/inventory/prod.ini");
    let content = match std::fs::read_to_string(&inv) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };

    let group_labels: &[(&str, &str)] = &[
        ("[util]",    "Util"),
        ("[masters]", "Master"),
        ("[workers]", "Worker"),
        ("[edge]",    "Edge"),
        ("[ipa]",     "IPA"),
        ("[bastion]", "Bastion"),
    ];

    let mut map = HashMap::new();
    let mut current_label: Option<&str> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current_label = group_labels
                .iter()
                .find(|(g, _)| line.starts_with(g))
                .map(|(_, l)| *l);
            continue;
        }
        if let Some(label) = current_label {
            if !line.is_empty() && !line.starts_with('#') {
                let hostname = line.split_whitespace().next().unwrap_or("").to_string();
                if !hostname.is_empty() {
                    map.insert(hostname, label.to_string());
                }
            }
        }
    }
    map
}

/// Kill any process currently listening on a given TCP port on localhost.
/// Uses `lsof -ti tcp:<port>` which is available on macOS.
/// This is called before opening a new SSH tunnel to ensure the port is free,
/// preventing ExitOnForwardFailure / EADDRINUSE failures on rapid re-fetch.
fn kill_port(port: u16) {
    let out = Command::new("/usr/sbin/lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output();
    if let Ok(o) = out {
        let pids = String::from_utf8_lossy(&o.stdout);
        for pid_str in pids.split_whitespace() {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                unsafe { libc::kill(pid, libc::SIGTERM); }
            }
        }
        // Brief pause so the kernel releases the port before we bind it again.
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

/// Returns util1 private IP from the [util] group in prod.ini.
fn util1_private_ip(repo_path: &str) -> Option<String> {
    let inv = PathBuf::from(repo_path)
        .join("ansible/inventory/prod.ini");
    let content = std::fs::read_to_string(&inv).ok()?;
    let mut in_util = false;
    for line in content.lines() {
        let line = line.trim();
        if line == "[util]" { in_util = true; continue; }
        if line.starts_with('[') { in_util = false; continue; }
        if in_util && !line.is_empty() && !line.starts_with('#') {
            for part in line.split_whitespace() {
                if let Some(ip) = part.strip_prefix("ansible_host=") {
                    return Some(ip.to_string());
                }
            }
        }
    }
    None
}
