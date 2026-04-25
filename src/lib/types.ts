// ---------------------------------------------------------------------------
// Domain types — mirror the Rust structs
// ---------------------------------------------------------------------------

export interface Cluster {
  id: string;
  name: string;
  repo_path: string;
  aws_profile: string;
  aws_region: string;
  /** "draft" | "installing" | "ready" | "failed" | "destroying" | "destroyed" */
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
  /** "running" | "success" | "failed" | "interrupted" */
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

/** Non-secret terraform variable values — serialised into clusters.tfvars_json */
export interface TfvarsConfig {
  aws_region: string;
  environment: string;
  owner_tag: string;
  operator_ingress_cidrs: string[];
  vpc_cidr: string;
  public_subnets: string[];
  private_subnets: string[];
  azs: string[];
  private_dns_domain: string;
  master_count: number;
  worker_count: number;
  edge_count: number;
  worker_data_disk_count: number;
  worker_data_disk_gb: number;
  master_data_disk_gb: number;
  bastion_instance_type: string;
  ipa_instance_type: string;
  util_instance_type: string;
  master_instance_type: string;
  worker_instance_type: string;
  edge_instance_type: string;
  ssh_key_name: string;
}

export const DEFAULT_TFVARS: TfvarsConfig = {
  aws_region: "ap-south-1",
  environment: "prod",
  owner_tag: "platform-team",
  operator_ingress_cidrs: [],
  vpc_cidr: "10.42.0.0/16",
  public_subnets: ["10.42.0.0/24"],
  private_subnets: ["10.42.10.0/24"],
  azs: ["ap-south-1a"],
  private_dns_domain: "cdp.prod.internal",
  master_count: 3,
  worker_count: 5,
  edge_count: 1,
  worker_data_disk_count: 4,
  worker_data_disk_gb: 1000,
  master_data_disk_gb: 500,
  bastion_instance_type: "t3.small",
  ipa_instance_type: "m5.large",
  util_instance_type: "m5.2xlarge",
  master_instance_type: "m5.2xlarge",
  worker_instance_type: "r5.4xlarge",
  edge_instance_type: "m5.xlarge",
  ssh_key_name: "cdp732",
};

// ---------------------------------------------------------------------------
// Log streaming
// ---------------------------------------------------------------------------

export interface LogLine {
  cluster_id: string;
  phase: string;
  stream: string; // "pty"
  line: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

export interface CallerIdentity {
  account: string;
  arn: string;
  user_id: string;
}

// ---------------------------------------------------------------------------
// Error type — mirrors AppError Rust serialisation
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

// ---------------------------------------------------------------------------
// Phase UI metadata
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error hints (emitted as "error-hint" Tauri event)
// ---------------------------------------------------------------------------

export interface ErrorHint {
  name: string;
  severity: string; // "blocker" | "warning"
  summary: string;
  remediation: string;
  remediation_command: string | null;
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  default_repo_path: string;
  default_aws_profile: string;
  default_aws_region: string;
}

// ---------------------------------------------------------------------------
// Cluster metadata (populated from terraform output -json after apply)
// ---------------------------------------------------------------------------

export interface ClusterMetadata {
  bastion_public_ip?: string;
  bastion_private_ip?: string;
  [key: string]: string | undefined;
}

export const PHASE_DEFS = [
  { key: "tfvars", label: "Write tfvars" },
  { key: "terraform_init", label: "Terraform Init" },
  { key: "terraform_plan", label: "Terraform Plan" },
  { key: "terraform_apply", label: "Terraform Apply" },
  { key: "make_inventory", label: "Generate Inventory" },
  { key: "make_ping", label: "Ping Hosts" },
  { key: "make_bootstrap", label: "Bootstrap" },
  { key: "make_prereq", label: "Prerequisites" },
  { key: "make_freeipa", label: "FreeIPA" },
  { key: "make_databases", label: "Databases" },
  { key: "make_cm", label: "Cloudera Manager" },
] as const;

export type PhaseKey = (typeof PHASE_DEFS)[number]["key"];
