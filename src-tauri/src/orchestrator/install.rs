use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::orchestrator::tfvars::{write_tfvars, TfvarsConfig};
use crate::runner::{execute_command, CommandRun, RunnerState};
use crate::state::Store;

// ---------------------------------------------------------------------------
// Phase definitions — order is the install sequence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Tfvars,
    TerraformInit,
    TerraformPlan,
    TerraformApply,
    MakeInventory,
    MakePing,
    MakeBootstrap,
    MakePrereq,
    MakeFreeipa,
    MakeDatabases,
    MakeCm,
    MakeKerberos,
}

impl Phase {
    pub fn key(self) -> &'static str {
        match self {
            Self::Tfvars => "tfvars",
            Self::TerraformInit => "terraform_init",
            Self::TerraformPlan => "terraform_plan",
            Self::TerraformApply => "terraform_apply",
            Self::MakeInventory => "make_inventory",
            Self::MakePing => "make_ping",
            Self::MakeBootstrap => "make_bootstrap",
            Self::MakePrereq => "make_prereq",
            Self::MakeFreeipa => "make_freeipa",
            Self::MakeDatabases => "make_databases",
            Self::MakeCm => "make_cm",
            Self::MakeKerberos => "make_kerberos",
        }
    }

    pub fn all() -> &'static [Phase] {
        &[
            Self::Tfvars,
            Self::TerraformInit,
            Self::TerraformPlan,
            Self::TerraformApply,
            Self::MakeInventory,
            Self::MakePing,
            Self::MakeBootstrap,
            Self::MakePrereq,
            Self::MakeFreeipa,
            Self::MakeDatabases,
            Self::MakeCm,
            // MakeKerberos removed from auto-install: KDC setup is now a post-install
            // optional one-click action in the Health tab (security_setup_kerberos command).
        ]
    }
}

// ---------------------------------------------------------------------------
// Install context
// ---------------------------------------------------------------------------

pub struct InstallCtx {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub runner: Arc<RunnerState>,
    pub cluster_id: String,
    pub repo_path: PathBuf,
    pub aws_profile: String,
    pub aws_region: String,
    pub log_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// run_install — drives all phases in sequence
// ---------------------------------------------------------------------------

pub async fn run_install(ctx: InstallCtx) {
    // Keep references alive before ctx is moved into run_install_inner.
    let app = ctx.app.clone();
    let store = Arc::clone(&ctx.store);
    let cluster_id = ctx.cluster_id.clone();

    if let Err(e) = run_install_inner(ctx).await {
        tracing::error!("install failed: {e}");
        // Surface the error to the frontend log pane so it's visible
        // even when the app is launched as a bundle (no terminal stderr).
        let _ = app.emit(
            "log-line",
            &serde_json::json!({
                "cluster_id": cluster_id,
                "phase": "orchestrator",
                "stream": "pty",
                "line": format!("[ORCHESTRATOR ERROR] {e}"),
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        );
        // Reset cluster to failed so Resume Install becomes clickable again.
        let _ = store.update_cluster_state(&cluster_id, "failed");
    }
}

/// Kill any ansible-playbook / make processes left over from a previous app session.
/// These become orphans when the app restarts mid-install and cause concurrent run
/// conflicts on the next resume because the new RunnerState starts empty.
fn kill_orphaned_ansible_processes(repo_path: &std::path::Path) {
    // Match any ansible-playbook that references our repo's playbook directory.
    // Using the repo path as the distinguishing token avoids killing unrelated Ansible runs.
    let pb_dir = repo_path.join("ansible").join("playbooks");
    let pb_str = pb_dir.to_string_lossy().into_owned();

    for pattern in &[pb_str.as_str(), "make prereq", "make bootstrap", "make freeipa", "make databases", "make cm"] {
        let _ = std::process::Command::new("pkill")
            .args(["-f", pattern])
            .status();
    }

    // Clean up any stale ControlMaster sockets so the next run starts fresh.
    let _ = std::process::Command::new("sh")
        .args(["-c", "rm -f /tmp/ansible-ssh-* /tmp/ansible-ctrl/* 2>/dev/null; true"])
        .status();

    tracing::info!("killed orphaned ansible processes (if any) and cleaned ControlMaster sockets");
}

async fn run_install_inner(ctx: InstallCtx) -> Result<(), AppError> {
    let tfvars_path = ctx.repo_path.join("terraform").join("terraform.tfvars");

    // Parse tfvars config stored with the cluster
    let cluster = ctx.store.get_cluster(&ctx.cluster_id)?;
    let tfvars_cfg: TfvarsConfig = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();

    let tf_dir = ctx.repo_path.join("terraform");

    // Base env for all commands.
    // When launched from the macOS .app bundle (Finder/Dock), PATH is minimal
    // (/usr/bin:/bin:/usr/sbin:/sbin) and doesn't include Homebrew or pyenv.
    // Prepend the common tool paths so make, ansible-playbook, terraform, etc.
    // are all resolvable regardless of how the app was opened.
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let tool_paths = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin";
    let full_path = format!("{tool_paths}:{inherited_path}");

    let mut base_env = HashMap::new();
    base_env.insert("PATH".into(), full_path);
    base_env.insert("AWS_PROFILE".into(), ctx.aws_profile.clone());
    base_env.insert("AWS_DEFAULT_REGION".into(), ctx.aws_region.clone());

    // Ansible env vars as absolute paths
    let ansible_cfg = ctx.repo_path.join("ansible").join("ansible.cfg");
    let ansible_inv = ctx
        .repo_path
        .join("ansible")
        .join("inventory")
        .join("prod.ini");
    base_env.insert(
        "ANSIBLE_CONFIG".into(),
        ansible_cfg.to_string_lossy().into_owned(),
    );
    base_env.insert(
        "ANSIBLE_INVENTORY".into(),
        ansible_inv.to_string_lossy().into_owned(),
    );

    // Kill any ansible-playbook processes left over from a previous app session
    // before we touch the cluster state. This prevents concurrent-run conflicts
    // when the user resumes after an app crash or restart.
    kill_orphaned_ansible_processes(&ctx.repo_path);

    ctx.store.update_cluster_state(&ctx.cluster_id, "installing")?;

    for &phase in Phase::all() {
        let phase_key = phase.key();

        // Skip FreeIPA when using an external directory (LDAP / AD).
        if phase == Phase::MakeFreeipa && tfvars_cfg.directory_type != "freeipa" {
            tracing::info!(
                "skipping phase {phase_key} — directory_type={}",
                tfvars_cfg.directory_type
            );
            let _ = ctx.app.emit(
                "log-line",
                &serde_json::json!({
                    "cluster_id": ctx.cluster_id,
                    "phase": phase_key,
                    "stream": "pty",
                    "line": format!("[skipped — directory_type={}, FreeIPA not required]",
                        tfvars_cfg.directory_type),
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                }),
            );
            // Record as success so resume doesn't re-run it.
            let now = chrono::Utc::now().to_rfc3339();
            let event_id = ctx.store.start_phase_event(&ctx.cluster_id, phase_key, &now)?;
            ctx.store.finish_phase_event(event_id, "success", &now, 0, None)?;
            continue;
        }

        // Skip phases that already completed successfully in a prior run.
        if ctx.store.phase_succeeded(&ctx.cluster_id, phase_key)? {
            tracing::info!("skipping phase {phase_key} — already succeeded");
            let _ = ctx.app.emit(
                "log-line",
                &serde_json::json!({
                    "cluster_id": ctx.cluster_id,
                    "phase": phase_key,
                    "stream": "pty",
                    "line": "[skipped — already completed successfully]",
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                }),
            );
            continue;
        }

        let now = chrono::Utc::now().to_rfc3339();

        tracing::info!("starting phase: {phase_key}");
        let event_id = ctx.store.start_phase_event(&ctx.cluster_id, phase_key, &now)?;

        let exit_code: i32 = match phase {
            // ----------------------------------------------------------------
            // Tfvars — write file, no subprocess
            // ----------------------------------------------------------------
            Phase::Tfvars => {
                match write_tfvars(&ctx.cluster_id, &cluster.name, &ctx.repo_path, &tfvars_cfg) {
                    Ok(()) => {
                        // Emit a synthetic log line so the UI shows activity
                        let _ = ctx.app.emit(
                            "log-line",
                            &serde_json::json!({
                                "cluster_id": ctx.cluster_id,
                                "phase": phase_key,
                                "stream": "pty",
                                "line": format!("terraform.tfvars written to {}", tfvars_path.display()),
                                "timestamp": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                        0
                    }
                    Err(e) => {
                        tracing::error!("tfvars write failed: {e}");
                        1
                    }
                }
            }

            // ----------------------------------------------------------------
            // Terraform phases — run terraform directly in terraform/
            // ----------------------------------------------------------------
            Phase::TerraformInit => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    tf_dir.clone(),
                    "terraform",
                    &["init", "-upgrade"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::TerraformPlan => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    tf_dir.clone(),
                    "terraform",
                    &["plan", "-out", "cdp732.tfplan"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::TerraformApply => {
                let code = run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    tf_dir.clone(),
                    "terraform",
                    &["apply", "-auto-approve", "cdp732.tfplan"],
                    base_env.clone(),
                )
                .await?;
                // On success, capture terraform output and store in metadata_json
                if code == 0 {
                    capture_terraform_outputs(&ctx, &tf_dir, &base_env);
                }
                code
            }

            // ----------------------------------------------------------------
            // Make phases — run from repo root
            // ----------------------------------------------------------------
            Phase::MakeInventory => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["inventory"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakePing => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["ping"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakeBootstrap => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["bootstrap"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakePrereq => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["prereq"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakeFreeipa => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["freeipa"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakeDatabases => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["databases"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::MakeCm => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["cm"],
                    base_env.clone(),
                )
                .await?
            }

            // MakeKerberos is no longer in Phase::all() — it's a post-install optional
            // action triggered from the Health tab. This arm is kept to satisfy the
            // exhaustive match; it will never be reached during a normal install.
            Phase::MakeKerberos => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["kerberos"],
                    base_env.clone(),
                )
                .await?
            }
        };

        let finished_at = chrono::Utc::now().to_rfc3339();

        if exit_code == 0 {
            ctx.store.finish_phase_event(event_id, "success", &finished_at, exit_code, None)?;
            tracing::info!("phase {phase_key} completed successfully");
        } else {
            let summary = format!("exited with code {exit_code}");
            ctx.store.finish_phase_event(
                event_id,
                "failed",
                &finished_at,
                exit_code,
                Some(&summary),
            )?;
            // If apply failed, also wipe the plan phase so resume re-plans.
            // A failed apply invalidates the plan (stale state, partial changes).
            if phase == Phase::TerraformApply {
                ctx.store.reset_phase(&ctx.cluster_id, Phase::TerraformPlan.key())?;
                // Remove the physical plan file so terraform plan produces a fresh one.
                let _ = std::fs::remove_file(tf_dir.join("cdp732.tfplan"));
            }
            ctx.store.update_cluster_state(&ctx.cluster_id, "failed")?;
            tracing::error!("phase {phase_key} failed (exit {exit_code}) — stopping install");
            return Ok(());
        }
    }

    // All phases passed
    ctx.store.update_cluster_state(&ctx.cluster_id, "ready")?;
    tracing::info!("install complete for cluster {}", ctx.cluster_id);

    // Notify frontend so it can navigate to ClusterDetail
    let _ = ctx.app.emit("install-complete", &ctx.cluster_id);

    Ok(())
}

// ---------------------------------------------------------------------------
// Capture terraform output -json and persist as metadata_json
// ---------------------------------------------------------------------------

fn capture_terraform_outputs(
    ctx: &InstallCtx,
    tf_dir: &std::path::Path,
    env: &HashMap<String, String>,
) {
    let mut cmd = std::process::Command::new("terraform");
    cmd.arg("output").arg("-json").current_dir(tf_dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    match cmd.output() {
        Err(e) => tracing::warn!("terraform output failed: {e}"),
        Ok(out) if !out.status.success() => {
            tracing::warn!("terraform output non-zero exit");
        }
        Ok(out) => {
            let raw = String::from_utf8_lossy(&out.stdout);
            // Flatten { "key": { "value": V, ... } } → { "key": V }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                let mut flat = serde_json::Map::new();
                if let Some(obj) = parsed.as_object() {
                    for (k, v) in obj {
                        let val = v.get("value").cloned().unwrap_or(v.clone());
                        flat.insert(k.clone(), val);
                    }
                }
                let metadata = serde_json::to_string(&flat).unwrap_or_else(|_| raw.to_string());
                if let Err(e) = ctx.store.update_cluster_metadata(&ctx.cluster_id, &metadata) {
                    tracing::warn!("failed to store cluster metadata: {e}");
                } else {
                    tracing::info!("stored terraform outputs in cluster metadata");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helper — execute one subprocess phase via PTY runner
// Public so orchestrator/scale.rs can reuse it.
// ---------------------------------------------------------------------------

pub async fn run_phase(
    app: &AppHandle,
    cluster_id: &str,
    runner: &Arc<RunnerState>,
    log_dir: &PathBuf,
    phase_key: &str,
    cwd: PathBuf,
    program: &str,
    args: &[&str],
    env: HashMap<String, String>,
) -> Result<i32, AppError> {
    execute_command(
        app.clone(),
        CommandRun {
            cluster_id: cluster_id.to_string(),
            phase: phase_key.to_string(),
            cwd,
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env,
        },
        log_dir.clone(),
        runner.clone(),
    )
    .await
}
