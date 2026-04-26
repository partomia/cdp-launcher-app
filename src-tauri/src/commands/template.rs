// ---------------------------------------------------------------------------
// CM Cluster Template — capture, list, apply, delete
//
// Capture: calls GET /clusters/{name}/export through an SSH tunnel to util1
//          and stores the JSON in the local SQLite DB.
//
// Apply:   writes the template JSON to a temp file in the cluster repo and
//          runs the Ansible cluster-template playbook against it.
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::orchestrator::install::run_phase;
use crate::runner::RunnerState;
use crate::state::{app_data_dir, ClusterTemplate, Store};

// ---------------------------------------------------------------------------
// template_capture
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn template_capture(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
    label: String,
) -> Result<ClusterTemplate, AppError> {
    let cluster = store.get_cluster(&cluster_id)?;

    // Derive the CM server's FQDN from tfvars (same logic as open_cm_ui)
    let domain = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v["private_dns_domain"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "cdp.prod.internal".to_string());

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
        .ok_or_else(|| AppError::Other(
            "Bastion IP not found — terraform output must contain bastion_public_ip".into(),
        ))?;

    // Read util1 private IP from inventory
    let util1_ip = util1_private_ip(&cluster.repo_path).ok_or_else(|| {
        AppError::Other("util1 IP not found in inventory — run 'make inventory' first".into())
    })?;

    let home = dirs::home_dir().unwrap_or_default();
    let key_path = format!("{}/.ssh/{}.pem", home.display(), key_name);
    let util1_fqdn = format!("util1.{domain}");

    // Read CM admin password from keychain
    let cm_password = crate::commands::keychain::keychain_get_inner(
        &cluster_id,
        "CM_ADMIN_PASSWORD",
    )
    .unwrap_or_else(|_| "admin".to_string());

    // Determine CM cluster name (environment from tfvars, defaults to "prod")
    let cm_cluster_name = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v["environment"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "prod".to_string());

    // Set up SSH tunnel local:17183 → util1:7183 (use 17183 to avoid conflict
    // with any existing open_cm_ui tunnel on 7183)
    let proxy_cmd = format!(
        "ssh -i {key_path} -W %h:%p -q -o StrictHostKeyChecking=no ec2-user@{bastion_ip}"
    );
    let mut tunnel = std::process::Command::new("ssh")
        .args([
            "-N",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", &format!("ProxyCommand={proxy_cmd}"),
            "-i", &key_path,
            "-L", &format!("17183:{util1_ip}:7183"),
            &format!("ec2-user@{util1_ip}"),
        ])
        .spawn()
        .map_err(AppError::Io)?;

    // Wait for tunnel to establish
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // Call CM API to export the cluster template
    let url = format!(
        "https://{util1_fqdn}:17183/api/v54/clusters/{cm_cluster_name}/export"
    );
    // We use the system curl via Command rather than reqwest to avoid adding
    // TLS deps; curl -k skips cert verification (internal CA).
    let output = std::process::Command::new("curl")
        .args([
            "-sk",
            "-u", &format!("admin:{cm_password}"),
            "-H", "Accept: application/json",
            &url,
        ])
        .output()
        .map_err(AppError::Io)?;

    let _ = tunnel.kill();

    if !output.status.success() && output.stdout.is_empty() {
        return Err(AppError::Other(format!(
            "curl failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let template_str = String::from_utf8_lossy(&output.stdout).to_string();

    // Validate it's real CM JSON and extract service types for the summary
    let template_val: serde_json::Value = serde_json::from_str(&template_str)
        .map_err(|e| AppError::Other(format!("CM returned invalid JSON: {e}")))?;

    if template_val.get("services").is_none() {
        return Err(AppError::Other(
            "CM response does not contain 'services' — check CM is running and the cluster name is correct".into(),
        ));
    }

    let services: String = template_val["services"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s["serviceType"].as_str())
        .collect::<Vec<_>>()
        .join(",");

    // Persist
    let id = uuid::Uuid::new_v4().to_string();
    let captured_at = chrono::Utc::now().to_rfc3339();
    store.insert_cluster_template(
        &id,
        &cluster_id,
        &label,
        &cm_cluster_name,
        &captured_at,
        &services,
        &template_str,
    )?;

    tracing::info!(
        "captured CM template '{}' for cluster {} (services: {})",
        label, cluster_id, services
    );

    store.get_cluster_template(&id)
}

// ---------------------------------------------------------------------------
// template_list
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn template_list(
    store: State<'_, Arc<Store>>,
    cluster_id: String,
) -> Result<Vec<ClusterTemplate>, AppError> {
    store.list_cluster_templates(&cluster_id)
}

// ---------------------------------------------------------------------------
// template_delete
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn template_delete(
    store: State<'_, Arc<Store>>,
    template_id: String,
) -> Result<(), AppError> {
    store.delete_cluster_template(&template_id)
}

// ---------------------------------------------------------------------------
// template_rename
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn template_rename(
    store: State<'_, Arc<Store>>,
    template_id: String,
    label: String,
) -> Result<(), AppError> {
    store.update_cluster_template_label(&template_id, &label)
}

// ---------------------------------------------------------------------------
// template_get_json — returns raw template JSON for download / inspection
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn template_get_json(
    store: State<'_, Arc<Store>>,
    template_id: String,
) -> Result<String, AppError> {
    store.get_cluster_template(&template_id).map(|t| t.template_json)
}

// ---------------------------------------------------------------------------
// template_apply — imports a saved template into CM via make cluster-template
//
// The template JSON is written to ansible/templates/cm/captured-template.json
// in the cluster's repo.  The cluster-template playbook is then invoked with
// TEMPLATE_FILE pointing at it.  A separate playbook variant
// (71-template-apply.yml) handles arbitrary template files, keeping the
// existing 60-cluster-template.yml untouched.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn template_apply(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    runner: State<'_, Arc<RunnerState>>,
    cluster_id: String,
    template_id: String,
) -> Result<(), AppError> {
    if runner.is_running(&cluster_id) {
        return Err(AppError::Other(
            "another operation is already running for this cluster".into(),
        ));
    }

    let cluster = store.get_cluster(&cluster_id)?;
    let tmpl = store.get_cluster_template(&template_id)?;

    let repo_path = PathBuf::from(&cluster.repo_path);
    let template_dir = repo_path.join("ansible").join("templates").join("cm");
    std::fs::create_dir_all(&template_dir).map_err(AppError::Io)?;

    // Write the captured JSON to a well-known path that 71-template-apply.yml reads
    let template_file = template_dir.join("captured-template.json");
    std::fs::write(&template_file, &tmpl.template_json).map_err(AppError::Io)?;

    let data_dir = app_data_dir()?;
    let log_dir = data_dir.join("logs");

    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let tool_paths = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin";
    let full_path = format!("{tool_paths}:{inherited_path}");

    let mut env = std::collections::HashMap::new();
    env.insert("PATH".into(), full_path);
    env.insert("AWS_PROFILE".into(), cluster.aws_profile.clone());
    env.insert("AWS_DEFAULT_REGION".into(), cluster.aws_region.clone());
    env.insert(
        "ANSIBLE_CONFIG".into(),
        repo_path.join("ansible").join("ansible.cfg").to_string_lossy().into_owned(),
    );
    env.insert(
        "ANSIBLE_INVENTORY".into(),
        repo_path
            .join("ansible")
            .join("inventory")
            .join("prod.ini")
            .to_string_lossy()
            .into_owned(),
    );

    let _ = app.emit(
        "log-line",
        &serde_json::json!({
            "cluster_id": cluster_id,
            "phase": "template_apply",
            "stream": "pty",
            "line": format!("[template] applying '{}' to CM cluster '{}'",
                tmpl.label, tmpl.cm_cluster_name),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        }),
    );

    let runner_arc = Arc::clone(&*runner);
    let app_clone = app.clone();
    let cluster_id_clone = cluster_id.clone();

    tokio::spawn(async move {
        let exit_code = run_phase(
            &app_clone,
            &cluster_id_clone,
            &runner_arc,
            &log_dir,
            "template_apply",
            repo_path,
            "make",
            &["template-apply"],
            env,
        )
        .await;

        match exit_code {
            Ok(0) => {
                let _ = app_clone.emit("template-apply-complete", &cluster_id_clone);
                tracing::info!("template apply succeeded for cluster {}", cluster_id_clone);
            }
            Ok(code) => {
                tracing::error!("template apply failed (exit {})", code);
                let _ = app_clone.emit(
                    "log-line",
                    &serde_json::json!({
                        "cluster_id": cluster_id_clone,
                        "phase": "template_apply",
                        "stream": "pty",
                        "line": format!("[template] apply failed with exit code {code}"),
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }
            Err(e) => {
                tracing::error!("template apply error: {e}");
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Helper: read util1 private IP from inventory
// ---------------------------------------------------------------------------

fn util1_private_ip(repo_path: &str) -> Option<String> {
    let inv = PathBuf::from(repo_path)
        .join("ansible")
        .join("inventory")
        .join("prod.ini");
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
