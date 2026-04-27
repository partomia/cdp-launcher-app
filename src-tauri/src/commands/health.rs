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
use tauri::State;

use crate::commands::keychain::keychain_get_inner;
use crate::error::AppError;
use crate::state::Store;

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
    /// true = cluster has been kerberized (make kerberos-cluster ran)
    pub kerberos_enabled: bool,
    /// true = KDC settings are configured in CM (make kerberos ran) even if cluster not yet kerberized
    pub kdc_configured: bool,
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
    let proxy_cmd = format!(
        "/usr/bin/ssh -i {key_path} -W %h:%p -q -o StrictHostKeyChecking=no ec2-user@{bastion_ip}"
    );
    let tunnel_child = Command::new("/usr/bin/ssh")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin")
        .args([
            "-N",
            "-o", "ExitOnForwardFailure=yes",
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

    let result = fetch_all(tunnel_port, &cm_password, &role_map);

    unsafe { libc::kill(tunnel_child.id() as i32, libc::SIGTERM); }

    result
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
    CmKerberosInfo {
        kerberos_enabled: v["kerberosEnabled"].as_bool().unwrap_or(false),
        kdc_configured: false, // filled in by caller from /cm/config
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
