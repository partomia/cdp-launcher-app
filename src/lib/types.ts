// ---------------------------------------------------------------------------
// Domain types — mirror the Rust structs in src-tauri/src/state/store.rs
// ---------------------------------------------------------------------------

export interface Cluster {
  id: string;
  name: string;
  repo_path: string;
  aws_profile: string;
  aws_region: string;
  /** "draft" | "installing" | "running" | "failed" | "destroyed" */
  state: string;
  created_at: string;
  destroyed_at: string | null;
  tfvars_json: string | null;
  metadata_json: string | null;
}

export interface PhaseEvent {
  id: number;
  cluster_id: string;
  phase: string;
  /** "started" | "success" | "failed" */
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error_summary: string | null;
}

export interface ClusterCreateInput {
  name: string;
  repo_path: string;
  aws_profile: string;
  aws_region: string;
  tfvars_json?: string;
}

// ---------------------------------------------------------------------------
// AWS types
// ---------------------------------------------------------------------------

export interface CallerIdentity {
  account: string;
  arn: string;
  user_id: string;
}

// ---------------------------------------------------------------------------
// Error type — mirrors AppError serialization from Rust
// ---------------------------------------------------------------------------

export interface AppError {
  kind:
    | "database"
    | "migration"
    | "keychain"
    | "aws_cli_not_installed"
    | "aws_profile_not_found"
    | "aws_auth_failed"
    | "network"
    | "not_found"
    | "io"
    | "other";
  message: string;
}
