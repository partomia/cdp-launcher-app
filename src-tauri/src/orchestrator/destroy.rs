use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::runner::{execute_command, CommandRun, RunnerState};
use crate::state::Store;

pub struct DestroyCtx {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub runner: Arc<RunnerState>,
    pub cluster_id: String,
    pub repo_path: PathBuf,
    pub aws_profile: String,
    pub aws_region: String,
    pub log_dir: PathBuf,
}

pub async fn run_destroy(ctx: DestroyCtx) {
    if let Err(e) = run_destroy_inner(ctx).await {
        tracing::error!("destroy failed: {e}");
    }
}

async fn run_destroy_inner(ctx: DestroyCtx) -> Result<(), AppError> {
    let phase_key = "make_tf_destroy";
    let now = chrono::Utc::now().to_rfc3339();

    ctx.store.update_cluster_state(&ctx.cluster_id, "destroying")?;
    let event_id = ctx.store.start_phase_event(&ctx.cluster_id, phase_key, &now)?;

    let mut env = HashMap::new();
    env.insert("AWS_PROFILE".into(), ctx.aws_profile.clone());
    env.insert("AWS_DEFAULT_REGION".into(), ctx.aws_region.clone());
    // Keep the installer repo's target, but force Terraform destroy to run
    // non-interactively so the desktop workflow does not hang at a prompt.
    env.insert("TF_CLI_ARGS_destroy".into(), "-auto-approve".into());

    let exit_code = execute_command(
        ctx.app.clone(),
        CommandRun {
            cluster_id: ctx.cluster_id.clone(),
            phase: phase_key.to_string(),
            cwd: ctx.repo_path.clone(),
            program: "make".to_string(),
            args: vec!["tf-destroy".to_string()],
            env,
        },
        ctx.log_dir.clone(),
        ctx.runner.clone(),
    )
    .await?;

    let finished_at = chrono::Utc::now().to_rfc3339();

    if exit_code == 0 {
        ctx.store.finish_phase_event(event_id, "success", &finished_at, exit_code, None)?;
        let destroyed_at = chrono::Utc::now().to_rfc3339();
        ctx.store.update_cluster_destroyed(&ctx.cluster_id, &destroyed_at)?;
        let _ = ctx.app.emit("destroy-complete", &ctx.cluster_id);
        tracing::info!("cluster {} destroyed", ctx.cluster_id);
    } else {
        let summary = format!("tf-destroy exited with code {exit_code}");
        ctx.store.finish_phase_event(event_id, "failed", &finished_at, exit_code, Some(&summary))?;
        ctx.store.update_cluster_state(&ctx.cluster_id, "failed")?;
        tracing::error!("destroy failed for cluster {}", ctx.cluster_id);
    }

    Ok(())
}
