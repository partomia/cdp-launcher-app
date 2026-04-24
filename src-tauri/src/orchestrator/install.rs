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
    if let Err(e) = run_install_inner(ctx).await {
        tracing::error!("install failed: {e}");
    }
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

    // Base env for all commands
    let mut base_env = HashMap::new();
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

    ctx.store.update_cluster_state(&ctx.cluster_id, "installing")?;

    for &phase in Phase::all() {
        let phase_key = phase.key();
        let now = chrono::Utc::now().to_rfc3339();

        tracing::info!("starting phase: {phase_key}");
        let event_id = ctx.store.start_phase_event(&ctx.cluster_id, phase_key, &now)?;

        let exit_code: i32 = match phase {
            // ----------------------------------------------------------------
            // Tfvars — write file, no subprocess
            // ----------------------------------------------------------------
            Phase::Tfvars => {
                match write_tfvars(&ctx.cluster_id, &ctx.repo_path, &tfvars_cfg) {
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
                    &ctx,
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
                    &ctx,
                    phase_key,
                    tf_dir.clone(),
                    "terraform",
                    &["plan", "-out", "cdp732.tfplan"],
                    base_env.clone(),
                )
                .await?
            }

            Phase::TerraformApply => {
                run_phase(
                    &ctx,
                    phase_key,
                    tf_dir.clone(),
                    "terraform",
                    &["apply", "-auto-approve", "cdp732.tfplan"],
                    base_env.clone(),
                )
                .await?
            }

            // ----------------------------------------------------------------
            // Make phases — run from repo root
            // ----------------------------------------------------------------
            Phase::MakeInventory => {
                run_phase(
                    &ctx,
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
                    &ctx,
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
                    &ctx,
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
                    &ctx,
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
                    &ctx,
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
                    &ctx,
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
                    &ctx,
                    phase_key,
                    ctx.repo_path.clone(),
                    "make",
                    &["cm"],
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
// Helper — execute one subprocess phase via PTY runner
// ---------------------------------------------------------------------------

async fn run_phase(
    ctx: &InstallCtx,
    phase_key: &str,
    cwd: PathBuf,
    program: &str,
    args: &[&str],
    env: HashMap<String, String>,
) -> Result<i32, AppError> {
    execute_command(
        ctx.app.clone(),
        CommandRun {
            cluster_id: ctx.cluster_id.clone(),
            phase: phase_key.to_string(),
            cwd,
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env,
        },
        ctx.log_dir.clone(),
        ctx.runner.clone(),
    )
    .await
}
