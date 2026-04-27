import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
// Inline log pane for security operations
// ---------------------------------------------------------------------------

interface SecurityPhaseDonePayload {
  cluster_id: string;
  phase: string;
  success: boolean;
  error: string | null;
}

interface LogLineEvent {
  cluster_id: string;
  phase: string;
  line: string;
  timestamp: string;
}

/**
 * Compact log pane that streams live output for a single phase key.
 * Listens for log-line events and security-phase-done to show status.
 */
function SecurityLogPane({
  clusterId,
  phase,
  onDone,
  onDismiss,
}: {
  clusterId: string;
  phase: string;
  onDone: (success: boolean, error: string | null) => void;
  onDismiss?: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"running" | "success" | "failed">("running");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlistenLog: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;

    listen<LogLineEvent>("log-line", (e) => {
      if (e.payload.cluster_id !== clusterId || e.payload.phase !== phase) return;
      setLines((prev) => {
        const next = [...prev, e.payload.line];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    }).then((fn) => { unlistenLog = fn; });

    listen<SecurityPhaseDonePayload>("security-phase-done", (e) => {
      if (e.payload.cluster_id !== clusterId || e.payload.phase !== phase) return;
      const s = e.payload.success ? "success" : "failed";
      setStatus(s);
      setErrorMsg(e.payload.error ?? null);
      onDone(e.payload.success, e.payload.error ?? null);
    }).then((fn) => { unlistenDone = fn; });

    return () => {
      unlistenLog?.();
      unlistenDone?.();
    };
  }, [clusterId, phase, onDone]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const statusBar =
    status === "running" ? (
      <div className="flex items-center gap-1.5 text-[11px] text-blue-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running…
      </div>
    ) : status === "success" ? (
      <div className="flex items-center gap-1.5 text-[11px] text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Completed successfully
      </div>
    ) : (
      <div className="flex items-center gap-1.5 text-[11px] text-red-500">
        <XCircle className="h-3 w-3" />
        Failed{errorMsg ? `: ${errorMsg}` : ""}
      </div>
    );

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/40">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-muted-foreground">{phase}</span>
          {statusBar}
        </div>
        {status !== "running" && onDismiss && (
          <button
            onClick={onDismiss}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-2"
          >
            dismiss
          </button>
        )}
      </div>
      <div className="h-48 overflow-y-auto bg-zinc-950 dark:bg-zinc-950 p-2">
        {lines.length === 0 && status === "running" && (
          <p className="text-[11px] text-zinc-500 font-mono">Waiting for output…</p>
        )}
        {lines.map((line, i) => {
          const isErr =
            /error|fatal|failed|exception/i.test(line) && !/unreachable/i.test(line);
          return (
            <div
              key={i}
              className={cn(
                "text-[11px] font-mono whitespace-pre-wrap leading-[1.4]",
                isErr ? "text-red-400" : "text-zinc-300",
              )}
            >
              {line}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
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

type SecurityPhaseKey =
  | "security_kerberos"
  | "security_kerberos_cluster"
  | "security_ldap";

function SecuritySection({
  health,
  clusterId,
}: {
  health: ClusterHealth;
  clusterId: string;
}) {
  const { kerberos, ldap_enabled, ldap_url, ldap_bind_dn, auto_tls_enabled } = health;

  // activePhase: phase currently in-flight — drives button spinner + disabled state
  const [activePhase, setActivePhase] = useState<SecurityPhaseKey | null>(null);
  // logPhase: phase whose log pane is visible (kept after completion so user can read output)
  const [logPhase, setLogPhase] = useState<SecurityPhaseKey | null>(null);
  const [showExtKdc, setShowExtKdc] = useState(false);
  const [showExtLdap, setShowExtLdap] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const isRunning = activePhase !== null;

  async function launch(phase: SecurityPhaseKey, fn: () => Promise<void>) {
    setActivePhase(phase);
    setLogPhase(phase);  // open log pane immediately
    setLaunchError(null);
    try {
      await fn();
      // Tauri command returns immediately after spawning — security-phase-done event
      // fires when the ansible job actually finishes (handled in SecurityLogPane).
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : String((e as { message?: unknown }).message ?? e);
      setLaunchError(msg);
      setActivePhase(null);
      setLogPhase(null);
    }
  }

  // Called by SecurityLogPane when security-phase-done event arrives
  function handlePhaseDone(_success: boolean, _err: string | null) {
    setActivePhase(null);  // stop spinner, re-enable buttons
    // logPhase stays set — log pane remains visible with final status for the user to read
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
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] font-medium">Kerberos</p>
            <div className="flex items-center gap-2 mt-0.5">
              {kerberos.kerberos_enabled ? (
                <HealthBadge status="STARTED" />
              ) : kerberos.kerberos_cm_ready ? (
                <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                  KDC ready
                </span>
              ) : kerberos.kdc_configured ? (
                <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300">
                  KDC settings only
                </span>
              ) : (
                <HealthBadge status="DISABLED" />
              )}
              {kerberos.kerberos_cm_ready && !kerberos.kerberos_enabled && (
                <span className="text-[10px] text-muted-foreground">cluster not yet kerberized</span>
              )}
              {kerberos.kdc_configured && !kerberos.kerberos_cm_ready && (
                <span className="text-[10px] text-muted-foreground">credentials not imported</span>
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

        {!kerberos.kerberos_enabled && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Step 1: run make kerberos — configures KDC in CM + imports admin credentials */}
            {!kerberos.kerberos_cm_ready && (
              <ActionButton
                label="Setup FreeIPA KDC"
                running={activePhase === "security_kerberos"}
                disabled={isRunning && activePhase !== "security_kerberos"}
                onClick={() =>
                  launch("security_kerberos", () => securitySetupKerberos(clusterId))
                }
              />
            )}
            {/* Step 2: run make kerberos-cluster — only enabled after credentials are imported */}
            {kerberos.kerberos_cm_ready && (
              <ActionButton
                label="Kerberize Cluster"
                running={activePhase === "security_kerberos_cluster"}
                disabled={isRunning && activePhase !== "security_kerberos_cluster"}
                onClick={() =>
                  launch("security_kerberos_cluster", () =>
                    securitySetupKerberosCluster(clusterId),
                  )
                }
              />
            )}
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowExtKdc((v) => !v)}
              disabled={isRunning}
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

        {launchError && activePhase === null && (
          <p className="text-[11px] text-destructive font-mono">{launchError}</p>
        )}

        {/* Log pane for kerberos phases */}
        {(logPhase === "security_kerberos" ||
          logPhase === "security_kerberos_cluster") && (
          <SecurityLogPane
            clusterId={clusterId}
            phase={logPhase}
            onDone={handlePhaseDone}
            onDismiss={() => setLogPhase(null)}
          />
        )}

        {!kerberos.kerberos_enabled && showExtKdc && !isRunning && (
          <ExternalKdcForm
            clusterId={clusterId}
            onDone={() => setShowExtKdc(false)}
          />
        )}
        {kerberos.kerberos_enabled && (
          <p className="text-[11px] text-muted-foreground">
            Cluster is kerberized. Service-level Kerberos can be adjusted in CM UI.
          </p>
        )}
      </div>

      {/* LDAP card */}
      <div className="rounded-lg border border-border/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] font-medium">CM LDAP / AD Auth</p>
            <div className="flex items-center gap-2 mt-0.5">
              <HealthBadge status={ldap_enabled ? "STARTED" : "DISABLED"} />
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
              running={activePhase === "security_ldap"}
              disabled={isRunning && activePhase !== "security_ldap"}
              onClick={() =>
                launch("security_ldap", () => securitySetupLdap(clusterId))
              }
            />
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowExtLdap((v) => !v)}
              disabled={isRunning}
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

        {/* Log pane for ldap phase */}
        {logPhase === "security_ldap" && (
          <SecurityLogPane
            clusterId={clusterId}
            phase="security_ldap"
            onDone={handlePhaseDone}
            onDismiss={() => setLogPhase(null)}
          />
        )}

        {!ldap_enabled && showExtLdap && !isRunning && (
          <ExternalLdapForm
            clusterId={clusterId}
            onDone={() => setShowExtLdap(false)}
          />
        )}
        {ldap_enabled && (
          <p className="text-[11px] text-muted-foreground">
            CM authenticates users via LDAP. Service-level settings (Ranger, Atlas, Knox) can be
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
            <SecuritySection health={health} clusterId={clusterId} />
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
