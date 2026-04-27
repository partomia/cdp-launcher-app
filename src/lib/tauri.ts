import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  CallerIdentity,
  Cluster,
  ClusterCreateInput,
  LicenseInfo,
  LogLine,
  PhaseEvent,
} from "./types";

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

export const keychainSet = (
  clusterId: string,
  key: string,
  value: string,
): Promise<void> => call("keychain_set", { clusterId, key, value });

export const keychainGet = (clusterId: string, key: string): Promise<string> =>
  call("keychain_get", { clusterId, key });

export const keychainDelete = (clusterId: string, key: string): Promise<void> =>
  call("keychain_delete", { clusterId, key });

export const keychainDeleteAllForCluster = (clusterId: string): Promise<void> =>
  call("keychain_delete_all_for_cluster", { clusterId });

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

export const awsProfileList = (): Promise<string[]> => call("aws_profile_list");

export const awsCallerIdentity = (
  profile: string,
  region: string,
): Promise<CallerIdentity> => call("aws_caller_identity", { profile, region });

export const awsCheckKeyPair = (
  profile: string,
  region: string,
  keyName: string,
): Promise<boolean> => call("aws_check_key_pair", { profile, region, keyName });

export const awsDetectPublicIp = (): Promise<string> =>
  call("aws_detect_public_ip");

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export const clusterList = (): Promise<Cluster[]> => call("cluster_list");

export const clusterGet = (id: string): Promise<Cluster> =>
  call("cluster_get", { id });

export const clusterCreate = (input: ClusterCreateInput): Promise<Cluster> =>
  call("cluster_create", { input });

export const clusterDeleteMetadata = (id: string): Promise<void> =>
  call("cluster_delete_metadata", { id });

export const clusterPhaseEvents = (clusterId: string): Promise<PhaseEvent[]> =>
  call("cluster_phase_events", { clusterId });

// ---------------------------------------------------------------------------
// Install / Destroy / Logs
// ---------------------------------------------------------------------------

export const installStart = (clusterId: string): Promise<void> =>
  call("install_start", { clusterId });

export const installCancel = (clusterId: string): Promise<void> =>
  call("install_cancel", { clusterId });

export const destroyStart = (clusterId: string): Promise<void> =>
  call("destroy_start", { clusterId });

export const scaleStart = (
  clusterId: string,
  newWorkerCount: number,
): Promise<void> => call("scale_start", { clusterId, newWorkerCount });

export const logsFetch = (
  clusterId: string,
  phase: string,
  offset: number,
  limit: number,
): Promise<LogLine[]> =>
  call("logs_fetch", { clusterId, phase, offset, limit });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsGet = (): Promise<Record<string, string>> =>
  call("settings_get");
export const settingsSet = (key: string, value: string): Promise<void> =>
  call("settings_set", { key, value });

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

export const forgetAllSecrets = (): Promise<void> => call("forget_all_secrets");
export const deleteAllClusters = (): Promise<void> =>
  call("delete_all_clusters");

// ---------------------------------------------------------------------------
// Cluster UI actions
// ---------------------------------------------------------------------------

export const clusterEnvVars = (clusterId: string): Promise<string> =>
  call("cluster_env_vars", { clusterId });

export const openCmUi = (clusterId: string): Promise<void> =>
  call("open_cm_ui", { clusterId });

export const openCmTunnel = (clusterId: string): Promise<void> =>
  call("open_cm_tunnel", { clusterId });

export const openSshTerminal = (clusterId: string): Promise<void> =>
  call("open_ssh_terminal", { clusterId });

export const runRemediation = (
  clusterId: string,
  command: string,
): Promise<void> => call("run_remediation", { clusterId, command });

// ---------------------------------------------------------------------------
// Cluster health
// ---------------------------------------------------------------------------

export const clusterHealthFetch = (
  clusterId: string,
): Promise<import("./types").ClusterHealth> =>
  call("cluster_health_fetch", { clusterId });

/** Configure KDC settings in CM + import admin credentials (runs make kerberos). */
export const securitySetupKerberos = (clusterId: string): Promise<void> =>
  call("security_setup_kerberos", { clusterId });

/** Kerberize the CM cluster (runs make kerberos-cluster). */
export const securitySetupKerberosCluster = (clusterId: string): Promise<void> =>
  call("security_setup_kerberos_cluster", { clusterId });

/** Configure CM LDAP auth against FreeIPA (runs make cm-ldap). */
export const securitySetupLdap = (clusterId: string): Promise<void> =>
  call("security_setup_ldap", { clusterId });

/**
 * Fix missing keytabs on an already-kerberized cluster:
 * installs FreeIPA wrapper + importAdminCredentials + generateCredentials + restart stale services.
 */
export const securityFixCredentials = (clusterId: string): Promise<void> =>
  call("security_fix_credentials", { clusterId });

/** Configure an external KDC in CM via API (MIT KDC or AD). */
export const securityConfigureExternalKdc = (
  clusterId: string,
  kdcHost: string,
  realm: string,
  kdcType: string,
  adminPrincipal: string,
  adminPassword: string,
): Promise<void> =>
  call("security_configure_external_kdc", {
    clusterId,
    kdcHost,
    realm,
    kdcType,
    adminPrincipal,
    adminPassword,
  });

/** Configure external LDAP/AD auth in CM via API. */
export const securityConfigureExternalLdap = (
  clusterId: string,
  ldapUrl: string,
  bindDn: string,
  bindPassword: string,
  searchBase: string,
  ldapType: string,
): Promise<void> =>
  call("security_configure_external_ldap", {
    clusterId,
    ldapUrl,
    bindDn,
    bindPassword,
    searchBase,
    ldapType,
  });

// ---------------------------------------------------------------------------
// CM Cluster Templates
// ---------------------------------------------------------------------------

export const templateCapture = (
  clusterId: string,
  label: string,
): Promise<import("./types").ClusterTemplate> =>
  call("template_capture", { clusterId, label });

export const templateList = (
  clusterId: string,
): Promise<import("./types").ClusterTemplate[]> =>
  call("template_list", { clusterId });

export const templateDelete = (templateId: string): Promise<void> =>
  call("template_delete", { templateId });

export const templateRename = (
  templateId: string,
  label: string,
): Promise<void> => call("template_rename", { templateId, label });

export const templateGetJson = (templateId: string): Promise<string> =>
  call("template_get_json", { templateId });

export const templateApply = (
  clusterId: string,
  templateId: string,
): Promise<void> => call("template_apply", { clusterId, templateId });

// ---------------------------------------------------------------------------
// License
// ---------------------------------------------------------------------------

export const licenseCheck = (): Promise<boolean> => call("license_check");

export const licenseInfo = (): Promise<LicenseInfo> => call("license_info");

export const licenseActivate = (token: string): Promise<LicenseInfo> =>
  call("license_activate", { token });

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  AppError,
  CallerIdentity,
  Cluster,
  ClusterCreateInput,
  LicenseInfo,
  LogLine,
  PhaseEvent,
};
