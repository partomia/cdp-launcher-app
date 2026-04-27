import { useState } from "react";
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MinusCircle,
  HelpCircle,
  Shield,
  ShieldOff,
  Key,
  Users,
  Lock,
  ChevronDown,
  ChevronRight,
  Play,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clusterHealthFetch,
  securitySetupKerberos,
  securitySetupKerberosCluster,
  securitySetupLdap,
  securityConfigureExternalKdc,
  securityConfigureExternalLdap,
} from "@/lib/tauri";
import type {
  ClusterHealth,
  CmHostSummary,
  CmServiceSummary,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Health indicator
// ---------------------------------------------------------------------------

function HealthDot({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    GOOD: {
      cls: "text-green-500",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    CONCERNING: {
      cls: "text-yellow-500",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
    BAD: {
      cls: "text-red-500",
      icon: <XCircle className="h-3.5 w-3.5" />,
    },
    DISABLED: {
      cls: "text-muted-foreground",
      icon: <MinusCircle className="h-3.5 w-3.5" />,
    },
  };
  const entry = map[status] ?? {
    cls: "text-muted-foreground",
    icon: <HelpCircle className="h-3.5 w-3.5" />,
  };
  return <span className={cn("inline-flex", entry.cls)}>{entry.icon}</span>;
}

function HealthBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    GOOD: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    CONCERNING:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
    BAD: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    DISABLED: "bg-muted text-muted-foreground",
    STARTED: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    STOPPED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    STOPPING:
      "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    STARTING:
      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Service friendly names
// ---------------------------------------------------------------------------

const SERVICE_LABELS: Record<string, string> = {
  HDFS: "HDFS",
  YARN: "YARN",
  HIVE: "Hive",
  HIVE_ON_TEZ: "Hive on Tez",
  RANGER: "Ranger",
  ATLAS: "Atlas",
  KAFKA: "Kafka",
  SPARK_ON_YARN: "Spark",
  SPARK3_ON_YARN: "Spark 3",
  HUE: "Hue",
  OOZIE: "Oozie",
  ZOOKEEPER: "ZooKeeper",
  KNOX: "Knox",
  SCHEMAREGISTRY: "Schema Registry",
  STREAMS_MESSAGING_MANAGER: "SMM",
  YARN_QUEUE_MANAGER: "Queue Manager",
  SOLR: "Solr",
  IMPALA: "Impala",
  KUDU: "Kudu",
  NIFI: "NiFi",
  FLINK: "Flink",
};

function serviceLabel(s: CmServiceSummary): string {
  return (
    s.display_name ??
    SERVICE_LABELS[s.service_type] ??
    s.service_type
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMemory(bytes: number | null): string {
  if (!bytes) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(0)} GB`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  Util: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  Master: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Worker: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  Edge: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  IPA: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Bastion: "bg-muted text-muted-foreground",
};

function RoleBadge({ role }: { role: string | null }) {
  if (!role) return <span className="text-muted-foreground text-[11px]">—</span>;
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
        ROLE_COLORS[role] ?? "bg-muted text-muted-foreground",
      )}
    >
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hosts table
// ---------------------------------------------------------------------------

function HostsTable({ hosts }: { hosts: CmHostSummary[] }) {
  if (hosts.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground px-1">No hosts returned.</p>
    );
  }
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border/40 bg-muted/30">
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Health</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Hostname</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Role</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">IP</th>
            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Cores</th>
            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Memory</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {hosts.map((h) => (
            <tr key={h.hostname} className="hover:bg-muted/20 transition-colors">
              <td className="px-3 py-2">
                <HealthDot status={h.health_summary} />
              </td>
              <td className="px-3 py-2 font-mono text-[11px] max-w-[220px] truncate" title={h.hostname}>
                {h.hostname.split(".")[0]}
                <span className="text-muted-foreground/60">
                  .{h.hostname.split(".").slice(1).join(".")}
                </span>
              </td>
              <td className="px-3 py-2">
                <RoleBadge role={h.node_role} />
              </td>
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {h.ip_address || "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {h.num_cores ?? "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {fmtMemory(h.total_phys_mem_bytes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Services grid
// ---------------------------------------------------------------------------

function ServicesGrid({ services }: { services: CmServiceSummary[] }) {
  if (services.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground px-1">No services found.</p>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {services.map((s) => (
        <div
          key={s.name}
          className="rounded-lg border border-border/50 px-3 py-2.5 space-y-1.5 hover:bg-muted/20 transition-colors"
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-[13px] font-medium truncate">
              {serviceLabel(s)}
            </span>
            <HealthDot status={s.health_summary} />
          </div>
          <HealthBadge status={s.service_state} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security section — interactive KDC and LDAP setup cards
// ---------------------------------------------------------------------------

function ActionButton({
  label,
  running,
  disabled,
  onClick,
  variant = "outline",
}: {
  label: string;
  running: boolean;
  disabled?: boolean;
  onClick: () => void;
  variant?: "outline" | "default";
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={onClick}
      disabled={running || disabled}
      className="h-7 text-[12px]"
    >
      {running ? (
        <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
      ) : (
        <Play className="h-3 w-3 mr-1.5" />
      )}
      {label}
    </Button>
  );
}

function ExternalKdcForm({
  clusterId,
  onDone,
}: {
  clusterId: string;
  onDone: () => void;
}) {
  const [kdcHost, setKdcHost] = useState("");
  const [realm, setRealm] = useState("");
  const [kdcType, setKdcType] = useState("MIT KDC");
  const [adminPrincipal, setAdminPrincipal] = useState("admin/admin");
  const [adminPassword, setAdminPassword] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!kdcHost || !realm || !adminPrincipal || !adminPassword) return;
    setRunning(true);
    setError(null);
    try {
      await securityConfigureExternalKdc(
        clusterId,
        kdcHost,
        realm,
        kdcType,
        adminPrincipal,
        adminPassword,
      );
      onDone();
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e));
    } finally {
      setRunning(false);
    }
  }

  const input =
    "w-full rounded border border-border/50 bg-background px-2 py-1 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-ring";
  const label = "block text-[11px] text-muted-foreground mb-0.5";

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        External KDC configuration
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={label}>KDC Host</label>
          <input className={input} value={kdcHost} onChange={(e) => setKdcHost(e.target.value)} placeholder="kdc.example.com" />
        </div>
        <div>
          <label className={label}>Realm</label>
          <input className={input} value={realm} onChange={(e) => setRealm(e.target.value)} placeholder="EXAMPLE.COM" />
        </div>
        <div>
          <label className={label}>KDC Type</label>
          <select
            className={cn(input, "cursor-pointer")}
            value={kdcType}
            onChange={(e) => setKdcType(e.target.value)}
          >
            <option>MIT KDC</option>
            <option>Active Directory</option>
          </select>
        </div>
        <div>
          <label className={label}>Admin Principal</label>
          <input className={input} value={adminPrincipal} onChange={(e) => setAdminPrincipal(e.target.value)} placeholder="admin/admin" />
        </div>
        <div className="col-span-2">
          <label className={label}>Admin Password</label>
          <input className={input} type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
        </div>
      </div>
      {error && (
        <p className="text-[11px] text-destructive font-mono whitespace-pre-wrap">{error}</p>
      )}
      <Button size="sm" onClick={submit} disabled={running || !kdcHost || !realm || !adminPassword} className="h-7 text-[12px]">
        {running ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : null}
        Apply
      </Button>
    </div>
  );
}

function ExternalLdapForm({
  clusterId,
  onDone,
}: {
  clusterId: string;
  onDone: () => void;
}) {
  const [ldapUrl, setLdapUrl] = useState("ldaps://");
  const [bindDn, setBindDn] = useState("");
  const [bindPassword, setBindPassword] = useState("");
  const [searchBase, setSearchBase] = useState("");
  const [ldapType, setLdapType] = useState("LDAP");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!ldapUrl || !bindDn || !bindPassword || !searchBase) return;
    setRunning(true);
    setError(null);
    try {
      await securityConfigureExternalLdap(
        clusterId,
        ldapUrl,
        bindDn,
        bindPassword,
        searchBase,
        ldapType,
      );
      onDone();
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e));
    } finally {
      setRunning(false);
    }
  }

  const input =
    "w-full rounded border border-border/50 bg-background px-2 py-1 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-ring";
  const label = "block text-[11px] text-muted-foreground mb-0.5";

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        External LDAP / AD configuration
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={label}>LDAP URL</label>
          <input className={input} value={ldapUrl} onChange={(e) => setLdapUrl(e.target.value)} placeholder="ldaps://ldap.example.com:636" />
        </div>
        <div>
          <label className={label}>Type</label>
          <select
            className={cn(input, "cursor-pointer")}
            value={ldapType}
            onChange={(e) => setLdapType(e.target.value)}
          >
            <option value="LDAP">LDAP</option>
            <option value="AD">Active Directory</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className={label}>Bind DN</label>
          <input className={input} value={bindDn} onChange={(e) => setBindDn(e.target.value)} placeholder="cn=cm-bind,dc=example,dc=com" />
        </div>
        <div className="col-span-2">
          <label className={label}>Bind Password</label>
          <input className={input} type="password" value={bindPassword} onChange={(e) => setBindPassword(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className={label}>Search Base DN</label>
          <input className={input} value={searchBase} onChange={(e) => setSearchBase(e.target.value)} placeholder="dc=example,dc=com" />
        </div>
      </div>
      {error && (
        <p className="text-[11px] text-destructive font-mono whitespace-pre-wrap">{error}</p>
      )}
      <Button size="sm" onClick={submit} disabled={running || !ldapUrl || !bindDn || !bindPassword || !searchBase} className="h-7 text-[12px]">
        {running ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : null}
        Apply
      </Button>
    </div>
  );
}

function SecuritySection({
  health,
  clusterId,
  onActionStart,
}: {
  health: ClusterHealth;
  clusterId: string;
  onActionStart?: () => void;
}) {
  const { kerberos, ldap_enabled, ldap_url, ldap_bind_dn, auto_tls_enabled } = health;
  const [kdcRunning, setKdcRunning] = useState(false);
  const [kdcClusterRunning, setKdcClusterRunning] = useState(false);
  const [ldapRunning, setLdapRunning] = useState(false);
  const [showExtKdc, setShowExtKdc] = useState(false);
  const [showExtLdap, setShowExtLdap] = useState(false);
  const [kdcError, setKdcError] = useState<string | null>(null);
  const [ldapError, setLdapError] = useState<string | null>(null);

  async function handleSetupKerberos() {
    setKdcRunning(true);
    setKdcError(null);
    try {
      await securitySetupKerberos(clusterId);
      onActionStart?.();
    } catch (e: unknown) {
      setKdcError(typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e));
    } finally {
      setKdcRunning(false);
    }
  }

  async function handleKerberizeCluster() {
    setKdcClusterRunning(true);
    setKdcError(null);
    try {
      await securitySetupKerberosCluster(clusterId);
      onActionStart?.();
    } catch (e: unknown) {
      setKdcError(typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e));
    } finally {
      setKdcClusterRunning(false);
    }
  }

  async function handleSetupLdap() {
    setLdapRunning(true);
    setLdapError(null);
    try {
      await securitySetupLdap(clusterId);
      onActionStart?.();
    } catch (e: unknown) {
      setLdapError(typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e));
    } finally {
      setLdapRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Top row — Auto-TLS + CM version */}
      <div className="rounded-lg border border-border/50 divide-y divide-border/40">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-shrink-0">
            {auto_tls_enabled ? (
              <Shield className="h-4 w-4 text-green-500" />
            ) : (
              <ShieldOff className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <span className="w-28 flex-shrink-0 text-[12px] text-muted-foreground">Auto-TLS</span>
          <HealthBadge status={auto_tls_enabled ? "STARTED" : "STOPPED"} />
        </div>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Lock className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="w-28 flex-shrink-0 text-[12px] text-muted-foreground">CM version</span>
          <span className="font-mono text-[12px] text-muted-foreground">{health.cm_version ?? "—"}</span>
        </div>
      </div>

      {/* Kerberos card */}
      <div className="rounded-lg border border-border/50 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-medium">Kerberos</p>
              <div className="flex items-center gap-2 mt-0.5">
                {kerberos.kerberos_enabled ? (
                  <HealthBadge status="STARTED" />
                ) : kerberos.kdc_configured ? (
                  <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                    KDC configured
                  </span>
                ) : (
                  <HealthBadge status="DISABLED" />
                )}
                {kerberos.kdc_configured && !kerberos.kerberos_enabled && (
                  <span className="text-[10px] text-muted-foreground">cluster not yet kerberized</span>
                )}
              </div>
              {(kerberos.realm || kerberos.kdc_host) && (
                <div className="mt-1 space-y-0.5">
                  {kerberos.realm && (
                    <p className="font-mono text-[11px] text-muted-foreground">{kerberos.realm}</p>
                  )}
                  {kerberos.kdc_host && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      KDC: {kerberos.kdc_host}
                      {kerberos.kdc_type && (
                        <span className="text-muted-foreground/60"> ({kerberos.kdc_type})</span>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FreeIPA KDC action buttons */}
        {!kerberos.kerberos_enabled && (
          <div className="flex flex-wrap items-center gap-2">
            {!kerberos.kdc_configured && (
              <ActionButton
                label="Setup FreeIPA KDC"
                running={kdcRunning}
                onClick={handleSetupKerberos}
              />
            )}
            {kerberos.kdc_configured && (
              <ActionButton
                label="Kerberize Cluster"
                running={kdcClusterRunning}
                onClick={handleKerberizeCluster}
              />
            )}
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowExtKdc((v) => !v)}
            >
              {showExtKdc ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              External KDC
            </button>
          </div>
        )}
        {kdcError && (
          <p className="text-[11px] text-destructive font-mono">{kdcError}</p>
        )}
        {!kerberos.kerberos_enabled && showExtKdc && (
          <ExternalKdcForm
            clusterId={clusterId}
            onDone={() => {
              setShowExtKdc(false);
              onActionStart?.();
            }}
          />
        )}
        {kerberos.kerberos_enabled && (
          <p className="text-[11px] text-muted-foreground">
            Cluster is kerberized. Service-level Kerberos settings can be adjusted in CM UI.
          </p>
        )}
      </div>

      {/* LDAP card */}
      <div className="rounded-lg border border-border/50 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Users className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] font-medium">CM LDAP / AD Auth</p>
            <div className="flex items-center gap-2 mt-0.5">
              {ldap_enabled ? (
                <HealthBadge status="STARTED" />
              ) : (
                <HealthBadge status="DISABLED" />
              )}
            </div>
            {ldap_enabled && (
              <div className="mt-1 space-y-0.5">
                {ldap_url && (
                  <p className="font-mono text-[11px] text-muted-foreground break-all">{ldap_url}</p>
                )}
                {ldap_bind_dn && (
                  <p className="font-mono text-[11px] text-muted-foreground break-all">{ldap_bind_dn}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {!ldap_enabled && (
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              label="Setup FreeIPA LDAP"
              running={ldapRunning}
              onClick={handleSetupLdap}
            />
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowExtLdap((v) => !v)}
            >
              {showExtLdap ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              External LDAP / AD
            </button>
          </div>
        )}
        {ldapError && (
          <p className="text-[11px] text-destructive font-mono">{ldapError}</p>
        )}
        {!ldap_enabled && showExtLdap && (
          <ExternalLdapForm
            clusterId={clusterId}
            onDone={() => {
              setShowExtLdap(false);
              onActionStart?.();
            }}
          />
        )}
        {ldap_enabled && (
          <p className="text-[11px] text-muted-foreground">
            CM authenticates users via LDAP. Service-level LDAP settings (Ranger, Atlas, Knox) can be
            configured in CM UI per-service.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ClusterHealthPanel({ clusterId }: { clusterId: string }) {
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchHealth() {
    setLoading(true);
    setError(null);
    try {
      const result = await clusterHealthFetch(clusterId);
      setHealth(result);
    } catch (e: unknown) {
      const msg =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // After a security action starts, prompt the user to re-fetch to see updated state.
  function onSecurityActionStart() {
    // The action streams output via log-line events to the log pane.
    // We don't auto-refresh here — user clicks Refresh when ready.
  }

  const goodCount = health?.hosts.filter((h) => h.health_summary === "GOOD").length ?? 0;
  const badCount = health?.hosts.filter(
    (h) => h.health_summary === "BAD" || h.health_summary === "CONCERNING",
  ).length ?? 0;
  const serviceGood = health?.services.filter((s) => s.health_summary === "GOOD").length ?? 0;
  const serviceBad = health?.services.filter(
    (s) => s.health_summary === "BAD" || s.health_summary === "CONCERNING",
  ).length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header / fetch bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={fetchHealth}
          disabled={loading}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")}
          />
          {loading ? "Fetching via SSH tunnel…" : health ? "Refresh" : "Fetch Health"}
        </Button>

        {health && !loading && (
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span>
              Hosts:{" "}
              <span className="text-green-500 font-medium">{goodCount} healthy</span>
              {badCount > 0 && (
                <span className="text-red-500 font-medium ml-1">
                  {badCount} unhealthy
                </span>
              )}
            </span>
            <span>·</span>
            <span>
              Services:{" "}
              <span className="text-green-500 font-medium">{serviceGood} healthy</span>
              {serviceBad > 0 && (
                <span className="text-red-500 font-medium ml-1">
                  {serviceBad} unhealthy
                </span>
              )}
            </span>
            <span>·</span>
            <span>Last fetched {fmtTime(health.fetched_at)}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-[12px] text-destructive space-y-1">
          <p className="font-medium">Health fetch failed</p>
          <p className="font-mono whitespace-pre-wrap">{error}</p>
        </div>
      )}

      {!health && !loading && !error && (
        <p className="text-[13px] text-muted-foreground">
          Click <strong>Fetch Health</strong> to open an SSH tunnel to CM and retrieve live health
          data. Requires a running cluster with bastion access.
        </p>
      )}

      {health && (
        <>
          {/* Security */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Security
            </h3>
            <SecuritySection
              health={health}
              clusterId={clusterId}
              onActionStart={onSecurityActionStart}
            />
          </div>

          {/* Services */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Services ({health.services.length})
            </h3>
            <ServicesGrid services={health.services} />
          </div>

          {/* Hosts */}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
              Hosts ({health.hosts.length})
            </h3>
            <HostsTable hosts={health.hosts} />
          </div>
        </>
      )}
    </div>
  );
}
