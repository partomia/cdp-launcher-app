import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  CallerIdentity,
  Cluster,
  ClusterCreateInput,
  LogLine,
  PhaseEvent,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

export const keychainSet = (clusterId: string, key: string, value: string): Promise<void> =>
  call("keychain_set", { clusterId, key, value });

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

export const awsCallerIdentity = (profile: string, region: string): Promise<CallerIdentity> =>
  call("aws_caller_identity", { profile, region });

export const awsCheckKeyPair = (profile: string, region: string, keyName: string): Promise<boolean> =>
  call("aws_check_key_pair", { profile, region, keyName });

export const awsDetectPublicIp = (): Promise<string> => call("aws_detect_public_ip");

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export const clusterList = (): Promise<Cluster[]> => call("cluster_list");

export const clusterGet = (id: string): Promise<Cluster> => call("cluster_get", { id });

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

export const logsFetch = (
  clusterId: string,
  phase: string,
  offset: number,
  limit: number
): Promise<LogLine[]> => call("logs_fetch", { clusterId, phase, offset, limit });

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { AppError, CallerIdentity, Cluster, ClusterCreateInput, LogLine, PhaseEvent };
