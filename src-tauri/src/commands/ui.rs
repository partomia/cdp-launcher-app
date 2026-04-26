use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::runner::{execute_command, CommandRun, RunnerState};
use crate::state::{app_data_dir, Store};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(store: State<'_, Arc<Store>>) -> Result<HashMap<String, String>, AppError> {
    store.list_settings()
}

#[tauri::command]
pub fn settings_set(
    store: State<'_, Arc<Store>>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    store.set_setting(&key, &value)
}

// ---------------------------------------------------------------------------
// Danger-zone commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn forget_all_secrets(store: State<'_, Arc<Store>>) -> Result<(), AppError> {
    let service = "com.partomia.cdp-launcher";
    let clusters = store.list_clusters()?;
    for cluster in clusters {
        for key in &[
            "PAYWALL_USER",
            "PAYWALL_PASS",
            "DS_PASSWORD",
            "ADM_PASSWORD",
            "CM_ADMIN_PASSWORD",
            "DB_ROOT_PASSWORD",
        ] {
            let account = format!("{}:{key}", cluster.id);
            if let Ok(entry) = keyring::Entry::new(service, &account) {
                let _ = entry.delete_password();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_all_clusters(store: State<'_, Arc<Store>>) -> Result<(), AppError> {
    store.delete_all_clusters()
}

// ---------------------------------------------------------------------------
// Cluster env vars — returns a shell export block for copy-to-clipboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cluster_env_vars(
    _store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<String, AppError> {
    let keys = [
        "PAYWALL_USER",
        "PAYWALL_PASS",
        "DS_PASSWORD",
        "ADM_PASSWORD",
        "CM_ADMIN_PASSWORD",
        "DB_ROOT_PASSWORD",
    ];
    let mut lines = vec![format!("# CDP env vars for cluster {cluster_id}")];
    for key in &keys {
        let account = format!("{cluster_id}:{key}");
        let entry = keyring::Entry::new("com.partomia.cdp-launcher", &account)
            .map_err(|e| AppError::Keychain(e.to_string()))?;
        let value = entry.get_password().unwrap_or_else(|_| "<not set>".to_string());
        lines.push(format!("export {key}='{value}'"));
    }
    Ok(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Open CM UI via SSH tunnel
// ---------------------------------------------------------------------------

/// Parse ansible/inventory/prod.ini and return the `ansible_host` IP of the util node.
fn util1_private_ip_from_inventory(repo_path: &str) -> Option<String> {
    let inv_path = std::path::PathBuf::from(repo_path)
        .join("ansible")
        .join("inventory")
        .join("prod.ini");
    let content = std::fs::read_to_string(&inv_path).ok()?;

    let mut in_util_section = false;
    for line in content.lines() {
        let line = line.trim();
        if line == "[util]" {
            in_util_section = true;
            continue;
        }
        if line.starts_with('[') {
            in_util_section = false;
            continue;
        }
        if in_util_section && !line.is_empty() && !line.starts_with('#') {
            // Format: "util1.cdp.prod.internal ansible_host=10.42.10.XX ..."
            for part in line.split_whitespace() {
                if let Some(ip) = part.strip_prefix("ansible_host=") {
                    return Some(ip.to_string());
                }
            }
        }
    }
    None
}

/// Builds the cluster metadata (bastion_ip, domain) from stored JSON fields.
fn cluster_connection_info(
    store: &Store,
    cluster_id: &str,
) -> Result<(String, String, String), AppError> {
    let cluster = store.get_cluster(cluster_id)?;

    // private_dns_domain from tfvars_json
    let domain = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v.get("private_dns_domain").and_then(|d| d.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp.prod.internal".to_string());

    // ssh_key_name from tfvars_json
    let key_name = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v.get("ssh_key_name").and_then(|d| d.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp732".to_string());

    // bastion_public_ip from metadata_json (populated after terraform apply)
    let bastion_ip = cluster
        .metadata_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            // Try common terraform output key names
            for key in &["bastion_public_ip", "bastion_ip", "bastion_host"] {
                if let Some(ip) = v.get(key).and_then(|d| d.as_str()) {
                    return Some(ip.to_string());
                }
            }
            None
        })
        .ok_or_else(|| AppError::Other(
            "Bastion IP not found in cluster metadata — terraform output must contain bastion_public_ip".to_string()
        ))?;

    Ok((bastion_ip, domain, key_name))
}

#[tauri::command]
pub async fn open_cm_ui(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<(), AppError> {
    let (bastion_ip, domain, key_name) = cluster_connection_info(&store, &cluster_id)?;
    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);

    let cluster = store.get_cluster(&cluster_id)?;
    let util1_ip = util1_private_ip_from_inventory(&cluster.repo_path).ok_or_else(|| {
        AppError::Other(
            "util1 private IP not found in inventory — run 'make inventory' first".to_string(),
        )
    })?;

    // CM's Spring Security CSRF host check validates Origin/Referer against the server
    // hostname. Accessing via https://localhost:7183 causes a 403 on /j_spring_security_check.
    // Fix: ensure the browser uses the actual CM hostname (util1.<domain>) so CSRF passes.
    // The SSH tunnel still carries the traffic — we just need /etc/hosts to resolve the name
    // to 127.0.0.1.
    let util1_fqdn = format!("util1.{domain}");
    let hosts_entry = format!("127.0.0.1 {util1_fqdn}");
    // Only call osascript (which prompts for admin password) if the entry is not already present.
    let hosts_content = std::fs::read_to_string("/etc/hosts").unwrap_or_default();
    if !hosts_content.contains(&hosts_entry) {
        let add_cmd = format!("echo '{}' >> /etc/hosts", hosts_entry);
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(r#"do shell script "{}" with administrator privileges"#, add_cmd),
            ])
            .status();
    }

    // Two-hop tunnel: local:7183 → bastion (ProxyCommand) → util1:7183
    // We forward to util1_ip directly so the TLS certificate hostname (util1.<domain>) matches.
    let proxy_cmd = format!("ssh -i {key_path} -W %h:%p -q ec2-user@{bastion_ip}");
    let _tunnel = std::process::Command::new("ssh")
        .args([
            "-N",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", &format!("ProxyCommand={proxy_cmd}"),
            "-i", &key_path,
            "-L", &format!("7183:{util1_ip}:7183"),
            &format!("ec2-user@{util1_ip}"),
        ])
        .spawn()
        .map_err(AppError::Io)?;

    // Give the tunnel a moment to establish
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Open browser using the real CM hostname — CSRF check will now pass
    let cm_url = format!("https://{util1_fqdn}:7183/");
    let _ = std::process::Command::new("open")
        .arg(&cm_url)
        .spawn();

    tracing::info!("opened CM UI tunnel to {util1_ip} ({util1_fqdn}) via {bastion_ip}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Open CM tunnel in a visible Terminal window
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_cm_tunnel(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<(), AppError> {
    let (bastion_ip, _domain, key_name) = cluster_connection_info(&store, &cluster_id)?;
    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);

    let cluster = store.get_cluster(&cluster_id)?;
    let util1_ip = util1_private_ip_from_inventory(&cluster.repo_path).ok_or_else(|| {
        AppError::Other(
            "util1 private IP not found in inventory — run 'make inventory' first".to_string(),
        )
    })?;

    // Build a shell command for the Terminal window.
    // Single-quoting the ProxyCommand value prevents the shell from splitting it.
    let ssh_cmd = format!(
        "ssh -N -o ExitOnForwardFailure=yes \
         -o 'ProxyCommand=ssh -i {key_path} -W %h:%p -q ec2-user@{bastion_ip}' \
         -i {key_path} -L 7183:localhost:7183 ec2-user@{util1_ip}"
    );
    let script = format!(r#"tell application "Terminal" to do script "{ssh_cmd}""#);
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(AppError::Io)?;

    tracing::info!("opened CM tunnel terminal to {util1_ip} via {bastion_ip}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Open SSH terminal to bastion
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_ssh_terminal(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<(), AppError> {
    let (bastion_ip, _domain, key_name) = cluster_connection_info(&store, &cluster_id)?;
    let key_path = format!("~/.ssh/{key_name}.pem");
    let ssh_cmd = format!("ssh -i {key_path} ec2-user@{bastion_ip}");
    let script = format!(
        r#"tell application "Terminal" to do script "{ssh_cmd}""#
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(AppError::Io)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Ad-hoc remediation command runner
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_remediation(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    runner: State<'_, Arc<RunnerState>>,
    cluster_id: String,
    command: String,
) -> Result<(), AppError> {
    let cluster = store.get_cluster(&cluster_id)?;
    let data_dir = app_data_dir()?;
    let log_dir = data_dir.join("logs");

    let parts: Vec<String> = command
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    if parts.is_empty() {
        return Err(AppError::Other("empty command".into()));
    }
    let program = parts[0].clone();
    let args = parts[1..].to_vec();

    let mut env = std::collections::HashMap::new();
    env.insert("AWS_PROFILE".into(), cluster.aws_profile.clone());
    env.insert("AWS_DEFAULT_REGION".into(), cluster.aws_region.clone());

    let run = CommandRun {
        cluster_id: cluster_id.clone(),
        phase: "remediation".to_string(),
        cwd: std::path::PathBuf::from(&cluster.repo_path),
        program,
        args,
        env,
    };

    let runner_arc = Arc::clone(&*runner);
    tokio::spawn(async move {
        if let Err(e) = execute_command(app, run, log_dir, runner_arc).await {
            tracing::error!("remediation failed: {e}");
        }
    });

    Ok(())
}
