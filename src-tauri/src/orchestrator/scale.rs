use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::orchestrator::tfvars::{write_tfvars, TfvarsConfig};
use crate::orchestrator::install::run_phase;
use crate::runner::RunnerState;
use crate::state::Store;

// ---------------------------------------------------------------------------
// Scale phases — order is the scale-out sequence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalePhase {
    ScaleTfvars,
    ScaleTfPlan,
    ScaleTfApply,
    ScaleInventory,
    ScalePing,
    ScaleBootstrap,
    ScalePrereq,
    ScaleCmAgents,
}

impl ScalePhase {
    pub fn key(self) -> &'static str {
        match self {
            Self::ScaleTfvars    => "scale_tfvars",
            Self::ScaleTfPlan    => "scale_tf_plan",
            Self::ScaleTfApply   => "scale_tf_apply",
            Self::ScaleInventory => "scale_inventory",
            Self::ScalePing      => "scale_ping",
            Self::ScaleBootstrap => "scale_bootstrap",
            Self::ScalePrereq    => "scale_prereq",
            Self::ScaleCmAgents  => "scale_cm_agents",
        }
    }

    pub fn all() -> &'static [ScalePhase] {
        &[
            Self::ScaleTfvars,
            Self::ScaleTfPlan,
            Self::ScaleTfApply,
            Self::ScaleInventory,
            Self::ScalePing,
            Self::ScaleBootstrap,
            Self::ScalePrereq,
            Self::ScaleCmAgents,
        ]
    }
}

// ---------------------------------------------------------------------------
// Scale context
// ---------------------------------------------------------------------------

pub struct ScaleCtx {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub runner: Arc<RunnerState>,
    pub cluster_id: String,
    pub repo_path: PathBuf,
    pub aws_profile: String,
    pub aws_region: String,
    pub log_dir: PathBuf,
    /// 0 = resume (no tfvars update); >0 = target worker count
    pub new_worker_count: u32,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run_scale(ctx: ScaleCtx) {
    let app = ctx.app.clone();
    let store = Arc::clone(&ctx.store);
    let cluster_id = ctx.cluster_id.clone();

    if let Err(e) = run_scale_inner(ctx).await {
        tracing::error!("scale failed: {e}");
        let _ = app.emit(
            "log-line",
            &serde_json::json!({
                "cluster_id": cluster_id,
                "phase": "orchestrator",
                "stream": "pty",
                "line": format!("[SCALE ERROR] {e}"),
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        );
        let _ = store.update_cluster_state(&cluster_id, "failed");
    }
}

async fn run_scale_inner(ctx: ScaleCtx) -> Result<(), AppError> {
    // Load current cluster config
    let cluster = ctx.store.get_cluster(&ctx.cluster_id)?;
    let mut tfvars_cfg: TfvarsConfig = cluster
        .tfvars_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();

    // If this is a fresh scale (not a resume), update the worker count in DB
    if ctx.new_worker_count > 0 {
        tfvars_cfg.worker_count = ctx.new_worker_count;
        let updated_json = serde_json::to_string(&tfvars_cfg)
            .map_err(|e| AppError::Other(format!("tfvars serialisation: {e}")))?;
        ctx.store.update_cluster_tfvars_json(&ctx.cluster_id, &updated_json)?;
        tracing::info!(
            "scale: updated worker_count to {} in DB",
            ctx.new_worker_count
        );
    }

    let tf_dir = ctx.repo_path.join("terraform");

    // Build env
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let tool_paths = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin";
    let full_path = format!("{tool_paths}:{inherited_path}");

    let mut base_env = HashMap::new();
    base_env.insert("PATH".into(), full_path);
    base_env.insert("AWS_PROFILE".into(), ctx.aws_profile.clone());
    base_env.insert("AWS_DEFAULT_REGION".into(), ctx.aws_region.clone());

    let ansible_cfg = ctx.repo_path.join("ansible").join("ansible.cfg");
    let ansible_inv = ctx.repo_path.join("ansible").join("inventory").join("prod.ini");
    base_env.insert("ANSIBLE_CONFIG".into(), ansible_cfg.to_string_lossy().into_owned());
    base_env.insert("ANSIBLE_INVENTORY".into(), ansible_inv.to_string_lossy().into_owned());

    ctx.store.update_cluster_state(&ctx.cluster_id, "scaling")?;
    let _ = ctx.app.emit("scale-started", &ctx.cluster_id);

    for &phase in ScalePhase::all() {
        let phase_key = phase.key();

        // Skip phases that already completed in a prior (failed) run
        if ctx.store.phase_succeeded(&ctx.cluster_id, phase_key)? {
            tracing::info!("scale: skipping phase {phase_key} — already succeeded");
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
        tracing::info!("scale: starting phase {phase_key}");
        let event_id = ctx.store.start_phase_event(&ctx.cluster_id, phase_key, &now)?;

        let exit_code: i32 = match phase {
            // ----------------------------------------------------------------
            // Write updated terraform.tfvars
            // ----------------------------------------------------------------
            ScalePhase::ScaleTfvars => {
                match write_tfvars(&ctx.cluster_id, &ctx.repo_path, &tfvars_cfg) {
                    Ok(()) => {
                        let _ = ctx.app.emit(
                            "log-line",
                            &serde_json::json!({
                                "cluster_id": ctx.cluster_id,
                                "phase": phase_key,
                                "stream": "pty",
                                "line": format!(
                                    "terraform.tfvars updated: worker_count = {}",
                                    tfvars_cfg.worker_count
                                ),
                                "timestamp": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                        0
                    }
                    Err(e) => {
                        tracing::error!("scale tfvars write failed: {e}");
                        1
                    }
                }
            }

            // ----------------------------------------------------------------
            // Terraform plan → new scale plan file
            // ----------------------------------------------------------------
            ScalePhase::ScaleTfPlan => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, tf_dir.clone(), "terraform",
                    &["plan", "-out", "cdp732-scale.tfplan"],
                    base_env.clone(),
                ).await?
            }

            // ----------------------------------------------------------------
            // Terraform apply the scale plan
            // ----------------------------------------------------------------
            ScalePhase::ScaleTfApply => {
                let code = run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, tf_dir.clone(), "terraform",
                    &["apply", "-auto-approve", "cdp732-scale.tfplan"],
                    base_env.clone(),
                ).await?;
                if code != 0 {
                    // Wipe the scale plan so resume re-plans
                    let _ = std::fs::remove_file(tf_dir.join("cdp732-scale.tfplan"));
                    ctx.store.reset_phase(&ctx.cluster_id, ScalePhase::ScaleTfPlan.key())?;
                }
                code
            }

            // ----------------------------------------------------------------
            // Regenerate Ansible inventory (new nodes appear here)
            // ----------------------------------------------------------------
            ScalePhase::ScaleInventory => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, ctx.repo_path.clone(), "make",
                    &["inventory"],
                    base_env.clone(),
                ).await?
            }

            // ----------------------------------------------------------------
            // Ping all hosts — verify new nodes are reachable
            // ----------------------------------------------------------------
            ScalePhase::ScalePing => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, ctx.repo_path.clone(), "make",
                    &["ping"],
                    base_env.clone(),
                ).await?
            }

            // ----------------------------------------------------------------
            // Bootstrap /etc/cdp-env on new nodes (idempotent on existing)
            // ----------------------------------------------------------------
            ScalePhase::ScaleBootstrap => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, ctx.repo_path.clone(), "make",
                    &["bootstrap"],
                    base_env.clone(),
                ).await?
            }

            // ----------------------------------------------------------------
            // OS prerequisites on new workers (idempotent on existing)
            // ----------------------------------------------------------------
            ScalePhase::ScalePrereq => {
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, ctx.repo_path.clone(), "make",
                    &["prereq"],
                    base_env.clone(),
                ).await?
            }

            // ----------------------------------------------------------------
            // Install CM agents on new worker nodes (--limit workers is
            // idempotent — existing agents are verified, new ones installed)
            // ----------------------------------------------------------------
            ScalePhase::ScaleCmAgents => {
                let mut env = base_env.clone();
                // ANS_LIMIT=workers tells make cm to restrict the ansible play
                // to the workers group, skipping masters/edge/util/ipa
                env.insert("ANS_LIMIT".into(), "workers".into());
                run_phase(
                    &ctx.app, &ctx.cluster_id, &ctx.runner, &ctx.log_dir,
                    phase_key, ctx.repo_path.clone(), "make",
                    &["cm"],
                    env,
                ).await?
            }
        };

        let finished_at = chrono::Utc::now().to_rfc3339();

        if exit_code == 0 {
            ctx.store.finish_phase_event(event_id, "success", &finished_at, exit_code, None)?;
            tracing::info!("scale: phase {phase_key} succeeded");
        } else {
            let summary = format!("exited with code {exit_code}");
            ctx.store.finish_phase_event(
                event_id, "failed", &finished_at, exit_code, Some(&summary),
            )?;
            ctx.store.update_cluster_state(&ctx.cluster_id, "failed")?;
            tracing::error!("scale: phase {phase_key} failed ({exit_code}) — stopping");
            return Ok(());
        }
    }

    // All scale phases passed — restore ready state
    ctx.store.update_cluster_state(&ctx.cluster_id, "ready")?;
    tracing::info!(
        "scale complete for cluster {} — now {} workers",
        ctx.cluster_id, tfvars_cfg.worker_count
    );
    let _ = ctx.app.emit("scale-complete", &ctx.cluster_id);
    let _ = ctx.app.emit("install-complete", &ctx.cluster_id); // refresh ClusterDetail

    Ok(())
}
